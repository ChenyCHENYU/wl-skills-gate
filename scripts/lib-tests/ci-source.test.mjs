import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { collectCiSource } from "../../lib/ci-source.js";
import { createBuildLifecycle } from "../../lib/lifecycle-source.js";
import { archiveQualityReport } from "../../lib/report-publication.js";

const sha = "a".repeat(40), origin = "https://ci.example.invalid";
function fixture(t, system = "gitlab") {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-ci-source-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "config.json"), requestFile = path.join(dir, "request.json"), outDir = path.join(dir, "evidence");
  const config = { schemaVersion: 1, system, project: "demo", scope: "standard", baseUrl: origin, tokenEnv: "CI_TOKEN", ref: system === "gitlab" ? "uat" : "origin/uat",
    requiredJobs: system === "gitlab" ? ["quality", "business-test"] : ["produce/build"], artifacts: { job: system === "gitlab" ? "quality" : "produce/build", paths: ["quality/summary.json"] }, qualitySummary: "quality/summary.json",
    ...(system === "gitlab" ? { projectId: 12, trustedRunnerIds: [77] } : { jobPath: "produce/build", userEnv: "CI_USER", jobConfigHash: createHash("sha256").update("<flow-definition/>").digest("hex") }) };
  const summary = { schemaVersion: 1, run: { project: "demo", profile: "standard", commitSha: sha, eventId: "event-1", startedAt: "2026-10-15T00:00:00Z", durationMs: 1, tool: "gate" },
    checks: [{ checkId: "CHECK", status: "ok" }], findings: [], counts: {}, decision: { status: "passed", reasons: [] } };
  const pipeline = { id: 45, project_id: 12, sha, ref: "uat", web_url: `${origin}/p/45` };
  const jobs = ["quality", "business-test"].map((name, i) => ({ id: 60 + i, name, pipeline: { id: 45 }, commit: { id: sha }, ref: "uat", runner: { id: 77 }, allow_failure: false, status: "success", web_url: `${origin}/j/${60 + i}` }));
  const build = { number: 45, building: false, result: "SUCCESS", actions: [{ lastBuiltRevision: { SHA1: sha, branch: [{ name: "origin/uat", SHA1: sha }] } }], artifacts: [{ relativePath: "quality/summary.json" }] };
  const request = { sha, runId: 45, sequence: 1, authorId: "author" }, calls = [], extra = new Map();
  let modifyResponse = (route, value) => value;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
    const route = new URL(url).pathname; let value;
    if (extra.has(route)) return extra.get(route)();
    if (route.endsWith("/config.xml")) return new Response("<flow-definition/>");
    if (route.endsWith("/pipelines/45")) value = pipeline;
    else if (route.endsWith("/pipelines/45/jobs")) value = jobs;
    else if (route.endsWith("/jobs/60")) value = jobs[0];
    else if (route.endsWith("/api/json")) value = build;
    else if (route.endsWith("/quality/summary.json")) value = summary;
    else throw new Error(`unexpected path ${route}`);
    value = modifyResponse(route, structuredClone(value));
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const run = async () => { writeFileSync(configFile, JSON.stringify(config)); writeFileSync(requestFile, JSON.stringify(request)); return collectCiSource({ configFile, requestFile, outDir, fetchImpl, env: { CI_TOKEN: "TOP_SECRET", CI_USER: "reader" }, now: Date.parse("2026-10-15T00:00:00Z") }); };
  return { config, summary, pipeline, jobs, build, request, calls, outDir, configFile, run, extra, modify: (fn) => modifyResponse = fn };
}

for (const mode of ["valid", "login", "403"]) test(`Jenkins发布报告${mode}经真实采集校验，详情不再指向摘要JSON`, async (t) => {
  const f = fixture(t, "jenkins"); f.summary.run.stage = "ci";
  const input = { summary: f.summary, dimensions: [] };
  const publication = archiveQualityReport({ input, outDir: path.join(path.dirname(f.outDir), "published"), jenkinsBuildUrl: `${origin}/job/produce/job/build/45/` });
  const manifestPath = "quality/publication.json";
  f.config.artifacts.paths.push(manifestPath); f.build.artifacts.push({ relativePath: manifestPath });
  f.config.reportPublication = { manifestPath };
  f.extra.set(`/job/produce/job/build/45/artifact/${manifestPath}`, () => new Response(JSON.stringify(publication)));
  f.extra.set(new URL(publication.reportUrl).pathname, () => new Response(mode === "valid" ? readFileSync(publication.entryFile) : "<html>Sign in</html>", { status: mode === "403" ? 403 : 200, headers: { "Content-Type": "text/html" } }));
  if (mode !== "valid") { await assert.rejects(f.run, /在线报告|HTTP 403/); assert(!existsSync(f.outDir)); return; }
  const result = await f.run(), event = JSON.parse(readFileSync(result.eventFile));
  assert.equal(event.reportUrl, publication.reportUrl); assert(!event.reportUrl.endsWith(".json"));
  assert.equal(readFileSync(path.join(f.outDir, "published-report.html"), "utf8"), readFileSync(publication.entryFile, "utf8"));
  assert.equal(JSON.parse(readFileSync(result.sourceFile)).publishedReport.htmlSha256, publication.htmlSha256);
});

for (const system of ["gitlab", "jenkins"]) test(`${system}固定来源查询真实身份和工件，生成未签事件，不保存凭据`, async (t) => {
  const f = fixture(t, system), result = await f.run();
  assert.equal(result.passed, true); assert.equal(result.signed, false);
  const source = readFileSync(result.sourceFile, "utf8"), event = JSON.parse(readFileSync(result.eventFile));
  assert(!source.includes("TOP_SECRET")); assert.equal(event.sha, sha); assert.match(event.eventId, /^quality:/); assert.equal(event.reportEventId, "event-1");
  assert.equal(JSON.parse(readFileSync(result.summaryFile)).run.commitSha, sha);
  assert.equal(event.source.recordHash, result.sourceHash);
  await assert.rejects(f.run, /已存在/);
});

for (const [name, mutate] of [
  ["错误SHA", (f) => f.pipeline.sha = "b".repeat(40)],
  ["错误项目", (f) => f.pipeline.project_id = 99],
  ["错误ref", (f) => f.pipeline.ref = "prd"],
  ["缺失必需作业", (f) => f.jobs.pop()],
  ["重复必需作业", (f) => f.jobs.push(f.jobs[0])],
  ["允许失败", (f) => f.jobs[0].allow_failure = true],
  ["未批准Runner", (f) => f.jobs[0].runner.id = 88],
  ["错误报告SHA", (f) => f.summary.run.commitSha = "b".repeat(40)],
  ["作业链接越界", (f) => f.jobs[0].web_url = "https://evil.invalid/job"],
  ["webhook自报状态", (f) => f.request.status = "success"],
  ["工件越界路径", (f) => f.config.artifacts.paths = ["../secret"]],
  ["HTTP来源", (f) => f.config.baseUrl = "http://ci.example.invalid"],
]) test(`CI采集拒绝${name}，不写成功证据`, async (t) => { const f = fixture(t); mutate(f); await assert.rejects(f.run); assert(!existsSync(f.outDir)); });

test("取消/跳过不会生成质量通过事件，不会用旧工件", async (t) => {
  const f = fixture(t); f.jobs[0].status = "canceled";
  const r = await f.run(); assert.equal(r.passed, false); assert.equal(r.eventFile, null);
  assert.equal(f.calls.filter((c) => c.url.includes("/artifacts/")).length, 0);
});
test("可选人工Review原件缺失保留pending来源，不把原始Gate报告变成可选", async (t) => {
  const f = fixture(t); f.config.artifacts.paths.push("review/impact.json"); f.config.artifacts.optionalPaths = ["review/impact.json"];
  const rawFetch = async (url, init) => url.endsWith("/review/impact.json") ? new Response("", { status: 404 }) : (() => { const route = new URL(url).pathname; return new Response(JSON.stringify(route.endsWith("/pipelines/45") ? f.pipeline : route.endsWith("/jobs") ? f.jobs : route.endsWith("/jobs/60") ? f.jobs[0] : f.summary)); })();
  const dir = path.dirname(f.outDir), requestFile = path.join(dir, "request.json"); writeFileSync(f.configFile, JSON.stringify(f.config)); writeFileSync(requestFile, JSON.stringify(f.request));
  const result = await collectCiSource({ configFile: f.configFile, requestFile, outDir: f.outDir, env: { CI_TOKEN: "secret" }, fetchImpl: rawFetch });
  assert.equal(result.passed, true); assert.ok(result.eventFile); assert.deepEqual(JSON.parse(readFileSync(result.sourceFile)).missingArtifacts, [{ path: "review/impact.json", reason: "optional-unavailable" }]);
  f.config.artifacts.optionalPaths.push(f.config.qualitySummary); writeFileSync(f.configFile, JSON.stringify(f.config));
  await assert.rejects(collectCiSource({ configFile: f.configFile, requestFile, outDir: f.outDir + "-invalid", env: { CI_TOKEN: "secret" }, fetchImpl: rawFetch }), /不能包含原始Gate/);
});
test("采集间状态改变必须重新采集", async (t) => {
  const f = fixture(t); f.modify((route, value) => route.endsWith("/jobs/60") ? { ...value, status: "failed" } : value);
  await assert.rejects(f.run, /采集中/);
});
test("分页抓取全部必需作业而非默认首屏", async (t) => {
  const f = fixture(t); const jobs = f.jobs.splice(1);
  // Pagination exercised with a direct collector call and strict next-page.
  const dir = path.dirname(f.outDir), configFile = path.join(dir, "config.json"), requestFile = path.join(dir, "request.json");
  writeFileSync(configFile, JSON.stringify(f.config)); writeFileSync(requestFile, JSON.stringify(f.request));
  await collectCiSource({ configFile, requestFile, outDir: f.outDir, env: { CI_TOKEN: "secret" }, fetchImpl: async (url) => {
    const u = new URL(url); let value, headers = {};
    if (u.pathname.endsWith("/pipelines/45")) value = f.pipeline;
    else if (u.pathname.endsWith("/jobs/60")) value = f.jobs[0];
    else if (u.pathname.endsWith("/jobs")) { const first = u.searchParams.get("page") === "1"; value = first ? f.jobs : jobs; if (first) headers["x-next-page"] = "2"; }
    else value = f.summary;
    return new Response(JSON.stringify(value), { headers });
  } });
  assert(existsSync(path.join(f.outDir, "source.json")));
});
for (const [name, mutate] of [
  ["参数SHA冒充SCM", (f) => { f.build.actions = [{ parameters: [{ name: "SHA", value: sha }] }]; }],
  ["多SCM版本冲突", (f) => { f.build.actions.push({ lastBuiltRevision: { SHA1: "b".repeat(40) } }); }],
  ["SCM分支不符", (f) => f.build.actions[0].lastBuiltRevision.branch[0].name = "origin/prd"],
  ["工件未归档", (f) => f.build.artifacts = []],
  ["未批准作业配置", (f) => f.config.jobConfigHash = "0".repeat(64)],
]) test(`Jenkins拒绝${name}`, async (t) => { const f = fixture(t, "jenkins"); mutate(f); await assert.rejects(f.run); });
test("响应超限立即拒绝，错误消息不回显响应或凭据", async (t) => {
  const f = fixture(t); f.config.maxArtifactBytes = 3;
  await assert.rejects(f.run, (error) => /预算/.test(error.message) && !error.message.includes("TOP_SECRET"));
});
for (const [name, mutate] of [
  ["其他必需作业失败", (f) => f.jobs[1].status = "failed"],
  ["报告自报通过但实际失败", (f) => f.jobs[0].status = "failed"],
]) test(`CI记录${name}的真实失败来源，不生成通过事件`, async (t) => {
  const f = fixture(t); mutate(f); const result = await f.run(), observation = JSON.parse(readFileSync(result.sourceFile));
  assert.equal(result.passed, false); assert.equal(result.eventFile, null); assert.equal(observation.status, "not-passed"); assert.equal(observation.qualityEvidence.reason, "quality-report-ci-status-conflict");
});
for (const [name, mutate] of [
  ["其他必需作业转失败", (jobs) => jobs[1].status = "failed"],
  ["其他必需作业被重试", (jobs) => { jobs[1].id = 99; jobs[1].status = "pending"; }],
  ["其他必需作业消失", (jobs) => jobs.pop()],
]) test(`末次全量快照拒绝${name}，不能沿用旧成功`, async (t) => {
  const f = fixture(t); let snapshots = 0;
  f.modify((route, value) => { if (route.endsWith("/jobs") && ++snapshots === 2) mutate(value); return value; });
  await assert.rejects(f.run, /必需作业/); assert.equal(existsSync(f.outDir), false);
});
test("末次流水线SHA漂移拒绝；保留显式最后作业快照", async (t) => {
  const f = fixture(t); let reads = 0;
  f.modify((route, value) => { if (route.endsWith("/pipelines/45") && ++reads === 2) value.sha = "b".repeat(40); return value; });
  await assert.rejects(f.run, /流水线身份/); assert.equal(existsSync(f.outDir), false);
  const good = fixture(t), result = await good.run(), source = JSON.parse(readFileSync(result.sourceFile));
  assert.equal(source.requiredJobsSnapshot, "final-required-jobs"); assert.equal(source.responses.filter((r) => r.snapshot === "initial-required-jobs").length, 1); assert.equal(source.responses.filter((r) => r.snapshot === "final-required-jobs").length, 1);
});
test("同目录重复采集并发只有一个胜者，失败者不删除其完整证据", async (t) => {
  const f = fixture(t), results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const winner = results.find((r) => r.status === "fulfilled").value;
  assert(existsSync(winner.sourceFile)); assert(existsSync(winner.summaryFile)); assert(existsSync(winner.eventFile));
  assert.equal(JSON.parse(readFileSync(winner.sourceFile)).status, "success");
});
for (const system of ["gitlab", "jenkins"]) test(`${system}构建失败无工件仍保存可信source并可生成失败卡片事实`, async (t) => {
  const f = fixture(t, system);
  if (system === "gitlab") { f.jobs[0].status = "failed"; f.modify((route, value) => route.endsWith("/quality/summary.json") ? new Response("not archived", { status: 404 }) : value); }
  else { f.build.result = "FAILURE"; f.build.artifacts = []; }
  const result = await f.run(), source = JSON.parse(readFileSync(result.sourceFile));
  assert.equal(result.passed, false); assert.equal(result.eventFile, null); assert.equal(source.jobStatus, "failed"); assert.deepEqual(source.artifacts, []); assert.equal(source.missingArtifacts[0].path, "quality/summary.json"); assert.equal(source.qualityEvidence.reason, "quality-report-unavailable");
  const fact = createBuildLifecycle({ configFile: f.configFile, sourceFile: result.sourceFile, sha, env: "uat", outDir: path.join(path.dirname(f.outDir), "failure-fact"), now: Date.parse("2026-10-15T00:00:00Z") });
  const event = JSON.parse(readFileSync(fact.eventFile)); assert.equal(event.status, "failed"); assert.equal(event.artifactHash, undefined); assert.equal(event.manifestHash, undefined);
});
test("作业成功但固定工件缺失仍严格拒绝，不降级成成功事实", async (t) => {
  const f = fixture(t); f.modify((route, value) => route.endsWith("/quality/summary.json") ? new Response("missing", { status: 404 }) : value);
  await assert.rejects(f.run, /HTTP 404/); assert.equal(existsSync(f.outDir), false);
});

for(const mode of ['valid','missing','old-runtime','other-sha'])test(`Jenkins公共入口证据${mode}：固定路径与包升级隔离`,async t=>{
 const f=fixture(t,'jenkins'),p='quality-reports/ci-integration/entry-context.json';f.config.nativeEntry={runtimeHash:'b'.repeat(64),entryPointHash:'c'.repeat(64)};f.config.artifacts.paths.push(p);if(mode!=='missing')f.build.artifacts.push({relativePath:p});f.extra.set(`/job/produce/job/build/45/artifact/${p}`,()=>new Response(JSON.stringify({schemaVersion:1,kind:'wl-quality-native-execution',project:'demo',scope:'standard',job:'produce/build',buildNumber:45,sha:mode==='other-sha'?'f'.repeat(40):sha,sourceDigest:'1'.repeat(64),registryHash:'2'.repeat(64),bindingHash:'3'.repeat(64),runtimeHash:mode==='old-runtime'?'d'.repeat(64):f.config.nativeEntry.runtimeHash,entryPointHash:f.config.nativeEntry.entryPointHash})));
 if(mode==='valid')assert.equal((await f.run()).passed,true);else await assert.rejects(f.run,/公共入口|旧报告|固定工件缺失/);
});
