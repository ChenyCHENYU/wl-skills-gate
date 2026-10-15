import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { collectCiSource } from "../../lib/ci-source.js";
import { createBuildLifecycle, createReviewLifecycle, signCollectedReleaseProof, inspectCiObservation } from "../../lib/lifecycle-source.js";
import { createReviewDraft, REVIEW_DIMENSIONS } from "../../lib/review.js";
import { signReviewRecord, signRecord } from "../../lib/evidence.js";
import { stableStringify } from "../../lib/util.js";
import { signPlatformReceipt, ingestLifecycleGovernance, outboxGovernance } from "../../lib/governance.js";
const digest = (v) => createHash("sha256").update(v).digest("hex"), sha = "b".repeat(40), hash = "a".repeat(64), now = Date.parse("2026-10-15T00:00:00Z"), origin = "https://ci.example.invalid";
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
async function fixture(t, system = "gitlab", mutate = () => {}) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-lifecycle-source-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "ci-config.json"), requestFile = path.join(dir, "request.json"), collected = path.join(dir, "collected");
  const summary = { schemaVersion: 1, run: { project: "demo", profile: "standard", commitSha: sha, eventId: "gate-1", startedAt: new Date(now).toISOString(), durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: hash }, policy: { policyHash: hash, ruleSetHash: hash, baselineHash: hash, waiversHash: hash, requiredCheckIds: ["CHECK"], lockedToolVersions: { CHECK: "fixture@1" }, checksSelected: 1 }, checks: [{ checkId: "CHECK", status: "ok", required: true, toolVersionVerified: true, toolVersion: "fixture@1" }], findings: [], counts: { blockingNew: 0 }, decision: { status: "passed", reasons: [] } };
  const app = Buffer.from([0, 255, 26, 13, 10]), deploymentConfig = "apiVersion: fixture\n";
  const manifest = { schemaVersion: 1, project: "demo", commitSha: sha, sourceDigest: hash, targetEnv: "uat", createdAt: new Date(now).toISOString(), artifacts: [{ path: "target/app.jar", sha256: digest(app) }], configFiles: [{ path: "deploy/app.yaml", sha256: digest(deploymentConfig) }] };
  const paths = ["quality/summary.json", "release/manifest.json", "target/app.jar", "deploy/app.yaml"];
  const config = { schemaVersion: 1, system, project: "demo", scope: "standard", baseUrl: origin, tokenEnv: "TOKEN", ref: system === "gitlab" ? "uat" : "origin/uat", requiredJobs: system === "gitlab" ? ["quality", "build"] : ["produce/build"], artifacts: { job: system === "gitlab" ? "build" : "produce/build", paths }, qualitySummary: "quality/summary.json", ...(system === "gitlab" ? { projectId: 12, trustedRunnerIds: [77] } : { jobPath: "produce/build", userEnv: "CI_USER", jobConfigHash: digest("<flow-definition/>") }) };
  const pipeline = { id: 45, project_id: 12, sha, ref: "uat", web_url: `${origin}/p/45` };
  const jobs = ["quality", "build"].map((name, i) => ({ id: 60 + i, name, pipeline: { id: 45 }, commit: { id: sha }, ref: "uat", runner: { id: 77 }, allow_failure: false, status: "success", web_url: `${origin}/j/${60 + i}`, finished_at: new Date(now - 1000).toISOString() }));
  const build = { number: 45, building: false, result: "SUCCESS", timestamp: now - 2000, duration: 1000, actions: [{ lastBuiltRevision: { SHA1: sha, branch: [{ name: "origin/uat", SHA1: sha }] } }], artifacts: paths.map((relativePath) => ({ relativePath })) };
  mutate({ manifest, config, summary, jobs, build });
  const content = { "quality/summary.json": JSON.stringify(summary), "release/manifest.json": JSON.stringify(manifest), "target/app.jar": app, "deploy/app.yaml": deploymentConfig };
  write(configFile, config); write(requestFile, { sha, runId: 45, sequence: 3, authorId: "author" });
  const result = await collectCiSource({ configFile, requestFile, outDir: collected, now, env: { TOKEN: "SECRET", CI_USER: "reader" }, fetchImpl: async (url) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/config.xml")) return new Response("<flow-definition/>");
    for (const [key, value] of Object.entries(content)) if (route.endsWith(`/artifacts/${key}`) || route.endsWith(`/artifact/${key}`)) return new Response(value);
    if (route.endsWith("/artifacts/review/impact.md")) return new Response("missing optional report", { status: 404 });
    const value = route.endsWith("/pipelines/45") ? pipeline : route.endsWith("/jobs") ? jobs : route.endsWith("/jobs/61") ? jobs[1] : route.endsWith("/api/json") ? build : null;
    assert.ok(value, `unexpected route ${route}`); return new Response(JSON.stringify(value));
  } });
  const options = { configFile, sourceFile: result.sourceFile, manifestPath: "release/manifest.json", env: "uat", sha, outDir: path.join(dir, "build-fact"), now };
  return { dir, config, configFile, summary, manifest, options, result, collected };
}
function reviewFixture(f, partial = false) {
  const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(f.dir, "private.pem"), publicKeyFile = path.join(f.dir, "public.pem");
  writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, pair.publicKey.export({ type: "spki", format: "pem" }));
  const identity = generateKeyPairSync("ed25519"), authorizationPrivateKeyFile = path.join(f.dir, "identity-private.pem"), authorizationPublicKeyFile = path.join(f.dir, "identity-public.pem");
  writeFileSync(authorizationPrivateKeyFile, identity.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(authorizationPublicKeyFile, identity.publicKey.export({ type: "spki", format: "pem" }));
  const policy = { schemaVersion: 1, project: "demo", dimensions: REVIEW_DIMENSIONS.map((d) => ({ id: d.id, applicable: true, requiredEvidenceTypes: [d.id === "scan" || d.id === "coding" ? "gate-summary" : `${d.id}-evidence`] })) };
  const evidence = [{ id: "gate", type: "gate-summary", source: "trusted-fixture/collector", project: "demo", candidateSha: sha, file: "collected/artifacts/quality/summary.json", dimensionIds: ["scan", "coding"] }, ...REVIEW_DIMENSIONS.filter((d) => !partial && !["scan", "coding"].includes(d.id)).map((d) => ({ id: d.id, type: `${d.id}-evidence`, source: "isolated-test/actual-reviewer", project: "demo", candidateSha: sha, file: `${d.id}.txt`, dimensionIds: [d.id] }))];
  for (const e of evidence.filter((e) => e.type !== "gate-summary")) writeFileSync(path.join(f.dir, e.file), `isolated evidence for ${e.id}; not a business claim`);
  write(path.join(f.dir, "review-policy.json"), policy);
  const inputFile = path.join(f.dir, "review-input.json"); write(inputFile, { schemaVersion: 1, kind: "review-input", reviewId: "review-1", project: "demo", authorId: "author", candidateSha: sha, scope: "standard", source: "dev", target: "uat", policyFile: "review-policy.json", evidence });
  const draft = createReviewDraft({ inputFile, evidenceRoot: f.dir, outDir: path.join(f.dir, "review"), now: new Date(now) });
  const pins = { project: "demo", sha, expectReviewPolicyHash: digest(stableStringify(policy)), expectPolicyHash: hash, expectRulesHash: hash, expectBaselineHash: hash, expectWaiversHash: hash, evidenceRoot: f.dir, privateKeyFile, publicKeyFile, authorizationPublicKeyFile, expectAuthorizationIssuer: "identity", authorId: "author", reviewerId: "reviewer", now: new Date(now) };
  const options = { ...f.options, ...pins, sequence: 7, recordFile: draft.recordFile, reportUrl: "https://quality.example.invalid/review/1", outDir: path.join(f.dir, "review-fact"), now };
  function sign() {
    const record = JSON.parse(readFileSync(draft.recordFile)); const authorizationFile = path.join(f.dir, "authorization.json");
    write(authorizationFile, signRecord({ schemaVersion: 1, kind: "review-authorization", authorizationId: "auth-1", issuer: "identity", identitySource: "isolated authenticated human", scope: "review-publish", decision: "approved", actorId: "reviewer", authorId: "author", project: "demo", candidateSha: sha, reviewDigest: record.reviewDigest, bodyDigest: record.bodyDigest, evidenceDigest: record.evidenceDigest, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), reason: "逐维复核完成", dimensionDecisions: record.content.dimensions.map((d) => ({ id: d.id, decision: "approved", reason: "已看原始证据" })) }, authorizationPrivateKeyFile));
    const signedFile = path.join(f.dir, "signed-review.json"); write(signedFile, signReviewRecord({ ...pins, recordFile: draft.recordFile, authorizationFile })); return signedFile;
  }
  return { draft, pins, options, sign };
}
for (const system of ["gitlab", "jenkins"]) test(`${system}可信采集结果自动构造构建事实，逐项核实际二进制/配置`, async (t) => {
  const f = await fixture(t, system), result = createBuildLifecycle(f.options), event = JSON.parse(readFileSync(result.eventFile));
  assert.equal(result.signed, false); assert.equal(event.status, "success"); assert.equal(event.manifestHash, digest(readFileSync(path.join(f.collected, "artifacts/release/manifest.json")))); assert.equal(event.artifactHash, f.manifest.artifacts[0].sha256); assert.equal(event.configCount, 1); assert.equal(event.sequence, 3); assert.equal(event.source.recordHash, digest(readFileSync(result.sourceFile))); assert.equal(event.occurredAt, new Date(now - 1000).toISOString());
  assert.throws(() => createBuildLifecycle(f.options), /已存在/);
});
test("目录在检查后被另一进程取得时，事实构造失败但保留胜者产物", async (t) => {
  const f = await fixture(t);
  const script = `import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const options=JSON.parse(process.argv[1]),original=fs.mkdirSync;let injected=false;
fs.mkdirSync=function(file,settings){if(!injected&&path.resolve(file)===path.resolve(options.outDir)){injected=true;original(file);fs.writeFileSync(path.join(file,'lifecycle-event.json'),'concurrent-winner');}return original(file,settings);};syncBuiltinESMExports();
const {createBuildLifecycle}=await import(process.argv[2]);try{createBuildLifecycle(options);process.exitCode=1;}catch(error){console.log(JSON.stringify({code:error.code,preserved:fs.readFileSync(path.join(options.outDir,'lifecycle-event.json'),'utf8')==='concurrent-winner'}));}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(f.options), new URL("../../lib/lifecycle-source.js", import.meta.url).href], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); const outcome = JSON.parse(result.stdout); assert.equal(outcome.code, "EEXIST"); assert.equal(outcome.preserved, true);
});
for (const [label, change] of [
  ["manifest项目", (m) => m.project = "other"], ["manifest候选", (m) => m.commitSha = "c".repeat(40)], ["manifest环境", (m) => m.targetEnv = "prd"],
  ["制品摘要", (m) => m.artifacts[0].sha256 = hash], ["配置摘要", (m) => m.configFiles[0].sha256 = hash], ["越界文件", (m) => m.artifacts[0].path = "../secret"],
]) test(`构造器拒绝${label}，不生成成功事实`, async (t) => { const f = await fixture(t, "gitlab", ({ manifest }) => change(manifest)); assert.throws(() => createBuildLifecycle(f.options)); assert.equal(existsSync(f.options.outDir), false); });
test("原始来源状态、配置、工件字节任意变化均不能抄写成成功", async (t) => {
  for (const mode of ["source", "config", "artifact", "symlink"]) {
    const f = await fixture(t);
    if (mode === "source") { const source = JSON.parse(readFileSync(f.result.sourceFile)); source.jobStatus = "failed"; write(f.result.sourceFile, source); }
    if (mode === "config") { f.config.ref = "prd"; write(f.configFile, f.config); }
    if (mode === "artifact") writeFileSync(path.join(f.collected, "artifacts/target/app.jar"), "tampered");
    if (mode === "symlink") { rmSync(path.join(f.collected, "artifacts/target/app.jar")); symlinkSync(f.configFile, path.join(f.collected, "artifacts/target/app.jar")); }
    assert.throws(() => createBuildLifecycle(f.options)); assert.equal(existsSync(f.options.outDir), false);
  }
});
test("取消构建自动输出无有效结果，不借用旧manifest和制品", async (t) => {
  const f = await fixture(t, "gitlab", ({ jobs }) => jobs[1].status = "canceled"), r = createBuildLifecycle(f.options), e = JSON.parse(readFileSync(r.eventFile));
  assert.equal(e.status, "canceled"); assert.equal(e.artifactHash, undefined); assert.equal(e.manifestHash, undefined);
});
test("Review草稿自动取真实正文/证据摘要，显式中央序号，保持待确认", async (t) => {
  const f = await fixture(t), r = reviewFixture(f), event = createReviewLifecycle(r.options), value = JSON.parse(readFileSync(event.eventFile));
  assert.equal(value.status, "draft"); assert.equal(value.sequence, 7); assert.equal(value.authorizationId, undefined); assert.equal(event.sourceFile, r.draft.recordFile); assert.equal(value.reportHash, r.draft.bodyDigest);
});
test("Review正式事件必须verifyReview验证当前正文/九维/授权/公钥", async (t) => {
  const f = await fixture(t), r = reviewFixture(f), recordFile = r.sign(), event = createReviewLifecycle({ ...r.options, recordFile }), value = JSON.parse(readFileSync(event.eventFile));
  assert.equal(value.status, "approved"); assert.equal(value.actorId, "reviewer"); assert.equal(value.authorizationId, "auth-1");
  writeFileSync(path.join(f.dir, "review/review.md"), "tampered");
  assert.throws(() => createReviewLifecycle({ ...r.options, recordFile, outDir: path.join(f.dir, "second") }), /正文/);
});
test("草稿缺维仍可提醒补证据，不能伪造正式事件；无中央序号拒绝", async (t) => {
  const f = await fixture(t), r = reviewFixture(f, true);
  assert.throws(() => createReviewLifecycle({ ...r.options, sequence: undefined }), /显式中央序号/);
  assert.equal(createReviewLifecycle(r.options).status, "draft"); assert.throws(r.sign, /仍缺证据/);
});
test("构造→中央签名→生命周期台账→卡片预览可直接串联，不手填事实", async (t) => {
  const f = await fixture(t), r = reviewFixture(f), build = createBuildLifecycle(f.options);
  const configFile = path.join(f.dir, "governance.json"), stateFile = path.join(f.dir, "ledger.json"), eventFile = path.join(f.dir, "receipt.json");
  write(configFile, { schemaVersion: 1, issuer: "central", publicKeyFile: r.pins.publicKeyFile, allowedLinkOrigins: [origin, "https://quality.example.invalid"], operators: ["operator"], projects: { demo: { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: "https://quality.example.invalid/issues", scopes: { standard: { requiredChecks: ["CHECK"], policyHash: hash, rulesHash: hash, baselineHash: hash, waiversHash: hash } } } }, channels: { group: { type: "feishu", webhookEnv: "GROUP_WEBHOOK", signingSecretEnv: "GROUP_SECRET" } } });
  write(eventFile, signPlatformReceipt(JSON.parse(readFileSync(build.eventFile)), { privateKeyFile: r.pins.privateKeyFile, issuer: "central", createdAt: new Date(now).toISOString() }));
  assert.equal(ingestLifecycleGovernance({ configFile, stateFile, eventFile, sourceFile: build.sourceFile, now }).status, "ingested"); assert.equal(outboxGovernance({ configFile, stateFile, now }).messages[0].category, "build");
});

test("独立签发从实际CI来源提取项目/流水线/作业，重新核验完整release与原始制品", async (t) => {
  const f = await fixture(t, "gitlab", ({ summary }) => { summary.run.profile = "release"; summary.run.targetEnv = "uat"; });
  const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(f.dir, "proof-key.pem"); writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const options = { ...f.options, privateKeyFile, issuer: "proof-signer", outFile: path.join(f.dir, "proof.json"), expectPolicyHash: hash, expectRulesHash: hash, expectBaselineHash: hash, expectWaiversHash: hash, pipelineId: "forged", jobId: "forged" };
  const result = signCollectedReleaseProof(options), record = JSON.parse(readFileSync(result.proofFile)); assert.equal(record.pipelineId, "45"); assert.equal(record.jobId, "61"); assert.equal(record.project, "demo");
  writeFileSync(path.join(f.collected, "artifacts/target/app.jar"), "changed");
  assert.throws(() => signCollectedReleaseProof({ ...options, outFile: path.join(f.dir, "wrong.json") }), /工件发生变化/);
});

test("成功CI只允许显式optional报告缺失，不改变真实状态或绕过发布必需制品", async (t) => {
  const f = await fixture(t, "gitlab", ({ config }) => { config.artifacts.paths.push("review/impact.md"); config.artifacts.optionalPaths = ["review/impact.md", "release/manifest.json"]; });
  const inspected = inspectCiObservation(f.options); assert.equal(inspected.value.status, "success"); assert.equal(inspected.value.missingArtifacts[0].reason, "optional-unavailable");
  assert.equal(createBuildLifecycle(f.options).status, "success");
  const source = JSON.parse(readFileSync(f.result.sourceFile)); source.artifacts = source.artifacts.filter((a) => a.path !== "release/manifest.json"); source.missingArtifacts.push({ path: "release/manifest.json", reason: "optional-unavailable" }); write(f.result.sourceFile, source);
  assert.equal(inspectCiObservation(f.options).value.jobStatus, "success");
  assert.throws(() => createBuildLifecycle({ ...f.options, outDir: path.join(f.dir, "missing-manifest") }), /制品未由固定来源采集/);
  const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(f.dir, "private-for-optional.pem"); writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.throws(() => signCollectedReleaseProof({ ...f.options, privateKeyFile, issuer: "proof-signer", outFile: path.join(f.dir, "missing-proof.json"), expectPolicyHash: hash, expectRulesHash: hash, expectBaselineHash: hash, expectWaiversHash: hash }), /制品未由固定来源采集/);
  source.missingArtifacts[0].reason = "download-unavailable"; write(f.result.sourceFile, source); assert.throws(() => inspectCiObservation(f.options), /缺失工件/);
});
