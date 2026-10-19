import { readFileSync, mkdirSync, writeFileSync, lstatSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { stableStringify } from "./util.js";
import { validateSummaryAgainstSchema, DEFAULT_SCHEMA_FILE } from "./validate-report.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const assert = (value, message) => { if (!value) throw new Error(message); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const relative = (value) => typeof value === "string" && value.length < 512 && !/[\\\u0000-\u001f?#%]/.test(value) && !value.startsWith("/") && value.split("/").every((p) => p && p !== "." && p !== "..");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

// Only the central collector owns this configuration and its read-only secrets.
// A project webhook supplies an ID to look up; it cannot supply a URL or facts.
export function loadCiSourceConfig(file) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert(config.schemaVersion === 1 && ["gitlab", "jenkins"].includes(config.system) && ID.test(config.project || "") && ID.test(config.scope || ""), "CI采集配置身份无效");
  const url = new URL(config.baseUrl);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "CI来源必须是固定HTTPS origin");
  config.baseUrl = url.origin;
  assert(/^[A-Z][A-Z0-9_]+$/.test(config.tokenEnv || ""), "CI只读凭据必须使用环境变量引用");
  assert(Array.isArray(config.requiredJobs) && config.requiredJobs.length && config.requiredJobs.every((v) => typeof v === "string" && v.trim() && v.length < 128) && new Set(config.requiredJobs).size === config.requiredJobs.length, "必须登记无重复的全部必需作业");
  assert(typeof config.ref === "string" && config.ref && !/[\u0000-\u001f]/.test(config.ref), "必须固定实际分支/候选ref");
  assert(config.artifacts && config.requiredJobs.includes(config.artifacts.job) && Array.isArray(config.artifacts.paths) && config.artifacts.paths.length && config.artifacts.paths.every(relative) && new Set(config.artifacts.paths).size === config.artifacts.paths.length, "必须固定证据作业和工件路径，不能使用glob/越界路径");
  if (config.qualitySummary !== undefined) assert(config.artifacts.paths.includes(config.qualitySummary), "qualitySummary未登记在固定工件清单");
  if (config.artifacts.optionalPaths !== undefined) assert(Array.isArray(config.artifacts.optionalPaths) && new Set(config.artifacts.optionalPaths).size === config.artifacts.optionalPaths.length && config.artifacts.optionalPaths.every((p) => config.artifacts.paths.includes(p) && p !== config.qualitySummary), "可选Review工件必须在固定清单内且不能包含原始Gate报告");
  if (config.system === "gitlab") {
    assert(positive(config.projectId), "GitLab必须固定数字projectId");
    assert(Array.isArray(config.trustedRunnerIds) && config.trustedRunnerIds.length && config.trustedRunnerIds.every(positive), "GitLab必须固定批准Runner编号");
  }
  else {
    assert(relative(config.jobPath) && config.requiredJobs.length === 1 && config.requiredJobs[0] === config.jobPath, "Jenkins必须固定唯一jobPath；多条作业分别采集并由受控发布作业汇总");
    assert(/^[A-Z][A-Z0-9_]+$/.test(config.userEnv || ""), "Jenkins用户必须用环境变量引用");
    assert(/^[a-f0-9]{64}$/.test(config.jobConfigHash || ""), "Jenkins必须固定批准job config.xml摘要");
  }
  config.maxArtifactBytes ??= 64 * 1024 * 1024;
  assert(Number.isSafeInteger(config.maxArtifactBytes) && config.maxArtifactBytes > 0 && config.maxArtifactBytes <= 256 * 1024 * 1024, "工件预算无效");
  return config;
}

async function bytes(response, limit) {
  assert(response.ok, `CI只读查询失败: HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  assert(!declared || (Number.isSafeInteger(Number(declared)) && Number(declared) >= 0 && Number(declared) <= limit), "CI响应超出大小预算");
  const chunks = []; let size = 0;
  if (response.body) for await (const part of response.body) { size += part.byteLength; assert(size <= limit, "CI响应超出大小预算"); chunks.push(Buffer.from(part)); }
  return Buffer.concat(chunks);
}

export async function collectCiSource({ configFile, requestFile, outDir, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  const config = loadCiSourceConfig(configFile), request = JSON.parse(readFileSync(requestFile, "utf8"));
  assert(SHA.test(request.sha || "") && positive(request.runId) && Number.isSafeInteger(request.sequence) && request.sequence > 0 && ID.test(request.authorId || ""), "采集请求须包含真实SHA、runId、中央序号和已认证作者映射");
  assert(!Object.keys(request).some((v) => !["sha", "runId", "sequence", "authorId"].includes(v)), "采集请求不能覆盖中央来源配置或自报状态");
  assert(outDir, "必须指定新的隔离证据目录");
  const output = path.resolve(outDir); let current = path.parse(output).root;
  for (const part of output.slice(current.length).split(path.sep)) { current = path.join(current, part); if (existsSync(current)) assert(!lstatSync(current).isSymbolicLink(), "采集证据路径不能含符号链接"); }
  assert(!existsSync(output), "采集证据目录已存在；不可覆盖原始响应");
  const token = env[config.tokenEnv]; assert(typeof token === "string" && token && !/[\r\n]/.test(token), "缺少有效CI只读凭据");
  const headers = config.system === "gitlab" ? { "PRIVATE-TOKEN": token } : { Authorization: `Basic ${Buffer.from(`${env[config.userEnv] || ""}:${token}`).toString("base64")}` };
  if (config.system === "jenkins") assert(env[config.userEnv] && !/[:\r\n]/.test(env[config.userEnv]), "缺少有效Jenkins只读用户");
  const responses = [], artifacts = [], missingArtifacts = [];
  const get = async (route, binary = false, snapshot) => {
    const url = new URL(route, config.baseUrl);
    assert(url.origin === config.baseUrl && !url.username && !url.password, "CI来源越出固定origin");
    let response;
    try { response = await fetchImpl(url.href, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error("CI只读查询连接失败；没有接受webhook自报结果"); }
    assert(!response.url || new URL(response.url).origin === config.baseUrl, "CI响应来源发生跳转");
    if (!response.ok) { const error = new Error(`CI只读查询失败: HTTP ${response.status}`); error.ciStatus = response.status; throw error; }
    const body = await bytes(response, binary ? config.maxArtifactBytes : 10 * 1024 * 1024);
    if (binary) return body;
    const raw = body.toString("utf8"); let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("CI来源没有返回有效JSON"); }
    responses.push({ url: url.href, sha256: digest(body), raw, ...(snapshot ? { snapshot } : {}) });
    return { parsed, response };
  };
  let job, jobs, pipelineUrl, artifactRoute, jobUrl, jobStatus, recheckRoute, recheckJobs;
  if (config.system === "gitlab") {
    const base = `/api/v4/projects/${config.projectId}`;
    const pipeline = (await get(`${base}/pipelines/${request.runId}`)).parsed;
    assert(String(pipeline.id) === String(request.runId) && String(pipeline.project_id) === String(config.projectId) && pipeline.sha === request.sha && pipeline.ref === config.ref, "GitLab流水线身份/SHA/ref不匹配");
    const fetchJobs = async (snapshot) => {
      const rows = []; let page = 1;
      while (true) {
        assert(page <= 100, "GitLab作业分页超出预算");
        const r = await get(`${base}/pipelines/${request.runId}/jobs?include_retried=false&per_page=100&page=${page}`, false, snapshot);
        assert(Array.isArray(r.parsed), "GitLab作业清单无效"); rows.push(...r.parsed);
        const next = r.response.headers.get("x-next-page"); if (!next) break;
        assert(String(page + 1) === next, "GitLab分页顺序无效"); page++;
      }
      return config.requiredJobs.map((name) => {
      const matches = rows.filter((v) => v.name === name);
      assert(matches.length === 1, `必需作业缺失/重复: ${name}`);
      const value = matches[0];
      assert(positive(value.id) && String(value.pipeline?.id) === String(request.runId) && value.commit?.id === request.sha && value.ref === config.ref && value.allow_failure === false, `必需作业身份/阻断属性不匹配: ${name}`);
      assert(["success", "failed", "canceled", "skipped", "manual", "pending", "running", "created", "preparing", "scheduled", "waiting_for_resource", "canceling"].includes(value.status), "未知GitLab作业状态");
      if (["success", "failed"].includes(value.status)) assert(config.trustedRunnerIds.map(String).includes(String(value.runner?.id)), `必需作业不在批准Runner: ${name}`);
      return value;
      });
    };
    jobs = await fetchJobs("initial-required-jobs");
    recheckJobs = async () => {
      const latest = await fetchJobs("final-required-jobs");
      const facts = (list) => list.map((v) => ({ id: v.id, name: v.name, status: v.status, sha: v.commit.id, pipelineId: v.pipeline.id, ref: v.ref, runnerId: v.runner?.id ?? null, allowFailure: v.allow_failure, erased: !!v.erased_at }));
      assert(stableStringify(facts(latest)) === stableStringify(facts(jobs)), "采集期间必需作业集合/当前重试编号/状态改变，重新采集");
      const finalPipeline = (await get(`${base}/pipelines/${request.runId}`, false, "final-pipeline")).parsed;
      assert(String(finalPipeline.id) === String(request.runId) && String(finalPipeline.project_id) === String(config.projectId) && finalPipeline.sha === request.sha && finalPipeline.ref === config.ref, "采集期间流水线身份/SHA/ref改变，重新采集");
      jobs = latest;
    };
    job = jobs.find((v) => v.name === config.artifacts.job);
    // Re-query the exact job. No branch-latest artifact endpoint is used.
    const exact = (await get(`${base}/jobs/${job.id}`)).parsed;
    assert(exact.id === job.id && exact.status === job.status && exact.commit?.id === request.sha && String(exact.pipeline?.id) === String(request.runId) && exact.ref === config.ref && exact.name === job.name && exact.allow_failure === false && exact.runner?.id === job.runner?.id, "采集中作业状态/身份改变，重新采集");
    pipelineUrl = pipeline.web_url; jobUrl = exact.web_url; jobStatus = job.status;
    recheckRoute = `${base}/jobs/${job.id}`;
    artifactRoute = (file) => `${base}/jobs/${job.id}/artifacts/${file.split("/").map(encodeURIComponent).join("/")}`;
  } else {
    const jobPath = config.jobPath.split("/").map((v) => `job/${encodeURIComponent(v)}`).join("/");
    const configXml = await get(`/${jobPath}/config.xml`, true);
    assert(digest(configXml) === config.jobConfigHash, "Jenkins作业配置与批准摘要不一致");
    // Job XML can contain legacy inline secrets. Keep its verified digest,
    // never copy configuration text into the report/chat evidence bundle.
    responses.push({ url: `${config.baseUrl}/${jobPath}/config.xml`, sha256: digest(configXml), rawOmitted: "controlled-job-configuration" });
    const buildPath = `/${jobPath}/${request.runId}/`;
    job = (await get(`${buildPath}api/json`, false, "initial-build")).parsed;
    assert(String(job.number) === String(request.runId) && typeof job.building === "boolean", "Jenkins构建身份无效");
    const revisions = [...new Set((job.actions || []).map((a) => a.lastBuiltRevision?.SHA1).filter(Boolean))];
    assert(revisions.length === 1 && revisions[0] === request.sha, "Jenkins缺少唯一真实SCM revision，不能用参数SHA代替");
    const branches = (job.actions || []).flatMap((a) => a.lastBuiltRevision?.branch || []).filter((b) => b.SHA1 === request.sha).map((b) => b.name);
    assert(branches.includes(config.ref), "Jenkins实际SCM分支与批准ref不一致");
    const states = { SUCCESS: "success", FAILURE: "failed", UNSTABLE: "failed", ABORTED: "canceled", NOT_BUILT: "skipped" };
    jobStatus = job.building ? "running" : states[job.result]; assert(jobStatus, "未知Jenkins构建结果");
    jobs = [{ ...job, name: config.jobPath, status: jobStatus }];
    pipelineUrl = jobUrl = new URL(buildPath, config.baseUrl).href;
    recheckRoute = `${buildPath}api/json`;
    artifactRoute = (file) => `${buildPath}artifact/${file.split("/").map(encodeURIComponent).join("/")}`;
  }
  for (const value of [pipelineUrl, jobUrl]) { const u = new URL(value); assert(u.origin === config.baseUrl && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash, "CI作业链接不属于固定来源"); }
  const terminal = ["success", "failed"].includes(jobStatus);
  if (terminal) for (const file of config.artifacts.paths) {
    const optional = config.artifacts.optionalPaths?.includes(file);
    if (config.system === "jenkins" && !job.artifacts?.some((v) => v.relativePath === file)) {
      assert(optional || jobStatus !== "success", `Jenkins固定工件缺失: ${file}`); missingArtifacts.push({ path: file, reason: optional ? "optional-unavailable" : "not-archived" }); continue;
    }
    try { const body = await get(artifactRoute(file), true); artifacts.push({ path: file, sha256: digest(body), bytes: body.byteLength, body }); }
    catch (error) { if (optional && [404, 410].includes(error.ciStatus)) missingArtifacts.push({ path: file, reason: "optional-unavailable" }); else { if (jobStatus === "success") throw error; missingArtifacts.push({ path: file, reason: "download-unavailable" }); } }
  }
  // A concurrent retry, erase, SCM update or result change invalidates the
  // collection instead of mixing one run's status with another run's bytes.
  const final = (await get(recheckRoute, false, config.system === "gitlab" ? "final-artifact-job" : "final-build")).parsed;
  if (config.system === "gitlab") assert(final.id === job.id && final.status === jobStatus && final.commit?.id === request.sha && String(final.pipeline?.id) === String(request.runId) && final.ref === config.ref && final.name === job.name && final.allow_failure === false && final.runner?.id === job.runner?.id && !final.erased_at, "工件采集后作业身份/状态改变或已擦除，重新采集");
  else {
    assert(String(final.number) === String(request.runId) && final.building === job.building && final.result === job.result && stableStringify(final.actions) === stableStringify(job.actions) && stableStringify(final.artifacts) === stableStringify(job.artifacts), "工件采集后Jenkins构建改变，重新采集");
    const jobPath = config.jobPath.split("/").map((v) => `job/${encodeURIComponent(v)}`).join("/");
    assert(digest(await get(`/${jobPath}/config.xml`, true)) === config.jobConfigHash, "采集期间Jenkins作业配置变化，重新采集");
  }
  if (recheckJobs) await recheckJobs();
  const passed = jobs.every((v) => v.status === "success");
  const observation = { schemaVersion: 1, kind: "verified-ci-observation", system: config.system, project: config.project, scope: config.scope, sha: request.sha,
    runId: String(request.runId), sequence: request.sequence, authorId: request.authorId, observedAt: new Date(now).toISOString(), ref: config.ref,
    status: passed ? "success" : "not-passed", pipelineUrl, jobUrl, jobId: String(job.id ?? job.number), jobStatus,
    configHash: digest(stableStringify(config)), requiredJobsSnapshot: config.system === "gitlab" ? "final-required-jobs" : "final-build", requiredJobs: jobs.map((v) => ({ id: String(v.id ?? v.number), name: v.name, status: v.status })),
    responses, artifacts: artifacts.map(({ body, ...v }) => v), missingArtifacts };
  let event;
  if (config.qualitySummary && terminal) {
    const content = artifacts.find((v) => v.path === config.qualitySummary)?.body;
    let summary, reason;
    if (!content) reason = "quality-report-unavailable";
    else {
      try { summary = JSON.parse(content); } catch { reason = "quality-report-not-json"; }
      if (summary) {
        const errors = validateSummaryAgainstSchema(summary, JSON.parse(readFileSync(DEFAULT_SCHEMA_FILE, "utf8")));
        if (errors.length || summary.run?.project !== config.project || summary.run?.commitSha !== request.sha || !ID.test(summary.run?.eventId || "")) reason = "quality-report-identity-or-schema-invalid";
        else if (!["passed", "blocked", "invalid"].includes(summary.decision.status) || (summary.decision.status === "passed") !== (jobStatus === "success") || (passed && summary.decision.status !== "passed") || (summary.decision.status === "passed" && !passed)) reason = "quality-report-ci-status-conflict";
      }
    }
    if (reason) {
      assert(!passed, `CI质量证据不可用于通过: ${reason}`);
      observation.qualityEvidence = { status: "unavailable-or-invalid", reason };
    } else event = { schemaVersion: 1, kind: "quality-event", eventId: `quality:${digest(`${config.project}:${config.scope}:${request.runId}:${job.id ?? job.number}:${request.sequence}:${digest(content)}`).slice(0, 48)}`, reportEventId: summary.run.eventId, project: config.project, scope: config.scope, sha: request.sha,
      sequence: request.sequence, authorId: request.authorId, pipelineId: String(request.runId), jobId: String(job.id ?? job.number), jobStatus,
      reportHash: digest(content), reportUrl: new URL(artifactRoute(config.qualitySummary), config.baseUrl).href, pipelineUrl,
      occurredAt: new Date(now).toISOString(),ref:config.ref };
  }
  const sourceText = json(observation);
  if (event) event.source = { system: config.system, recordId: String(request.runId), recordHash: digest(sourceText), observedAt: new Date(now).toISOString(), url: jobUrl };
  // Persist only after the final source identity/state checks. A failed job may
  // retain explicit missing-artifact evidence, never a passing quality event.
  // Request headers and credentials are not copied to the evidence bundle.
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  // Acquire this exact output directory atomically. A duplicate worker must
  // never enter our cleanup path or remove a winner's already-saved evidence.
  mkdirSync(output, { mode: 0o700 });
  try {
    writeFileSync(path.join(output, "source.json"), sourceText, { flag: "wx", mode: 0o600 });
    for (const item of artifacts) { const dest = path.join(output, "artifacts", item.path); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, item.body, { flag: "wx", mode: 0o600 }); }
    if (event) writeFileSync(path.join(output, "quality-event.json"), json(event), { flag: "wx", mode: 0o600 });
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  return { status: observation.status, sourceFile: path.join(output, "source.json"), sourceHash: digest(sourceText), eventFile: event ? path.join(output, "quality-event.json") : null,
    summaryFile: event ? path.join(output, "artifacts", config.qualitySummary) : null, signed: false, passed, requiredJobs: observation.requiredJobs };
}
