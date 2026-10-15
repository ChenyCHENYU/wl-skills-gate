import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { automationTick, loadAutomationConfig } from "../../lib/automation.js";
import { readGovernanceState } from "../../lib/governance.js";
const hash = (v) => createHash("sha256").update(v).digest("hex"), pin = "a".repeat(64), sha = "b".repeat(40), origin = "https://ci.example.invalid", now = Date.parse("2026-10-15T03:00:00Z");
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function fixture(t) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-automation-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, "receipt-private.pem"), publicKeyFile = path.join(dir, "receipt-public.pem");
  writeFileSync(privateKeyFile, key.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, key.publicKey.export({ type: "spki", format: "pem" }));
  const governanceConfigFile = path.join(dir, "governance.json"), stateFile = path.join(dir, "ledger.json"), configFile = path.join(dir, "automation.json"), ciFile = path.join(dir, "ci.json");
  const scope = { requiredChecks: ["CHECK"], policyHash: pin, rulesHash: pin, baselineHash: pin, waiversHash: pin, closurePolicy: { requiredEnvironments: ["sit"], deploymentLane: "release", requireDeployment: true } };
  write(governanceConfigFile, { schemaVersion: 1, issuer: "central", publicKeyFile, allowedLinkOrigins: [origin, "https://quality.example.invalid"], operators: ["operator"], projects: { demo: { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: "https://quality.example.invalid/issues", scopes: { full: scope } } }, channels: { group: { type: "feishu", webhookEnv: "GROUP_WEBHOOK", signingSecretEnv: "GROUP_SECRET" } } });
  const ci = { schemaVersion: 1, system: "gitlab", project: "demo", scope: "full", baseUrl: origin, projectId: 12, trustedRunnerIds: [77], tokenEnv: "TOKEN", ref: "uat", requiredJobs: ["quality", "business"], artifacts: { job: "quality", paths: ["quality/summary.json", "quality/manifest.json", "app.bin"] }, qualitySummary: "quality/summary.json", discovery: { pageSize: 10, dueAfterMinutes: 60 } }; write(ciFile, ci);
  const config = { schemaVersion: 1, governanceConfigFile, stateFile, dataDir: path.join(dir, "data"), receiptPrivateKeyFile: privateKeyFile, sources: [{ id: "demo-full", configFile: ciFile, actors: { "15": "owner" }, since: "2026-10-15T00:00:00Z", environment: "sit", manifestPath: "quality/manifest.json" }] }; write(configFile, config);
  let ticks = 0, requests = 0, mode = "running", missing = false, brokenManifest = false, runIds = [45];
  const runSha = (runId) => runId === 45 ? sha : "c".repeat(40);
  const pipeline = (runId) => ({ id: runId, project_id: 12, sha: runSha(runId), ref: "uat", user: { id: 15 }, status: mode, created_at: "2026-10-15T01:00:00Z", web_url: `${origin}/p/${runId}` });
  const jobs = (runId) => ["quality", "business"].filter((n) => !(missing && n === "quality")).map((name, i) => ({ id: runId * 10 + i, name, pipeline: { id: runId }, commit: { id: runSha(runId) }, ref: "uat", status: mode === "success" ? "success" : mode === "failed" ? "failed" : "running", runner: { id: 77 }, allow_failure: false, web_url: `${origin}/j/${runId * 10 + i}` }));
  const fetchImpl = async (url, init) => {
    requests++; assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); const u = new URL(url), p = u.pathname;
    if (p.endsWith("/pipelines")) return new Response(JSON.stringify(runIds.map(pipeline)));
    const pipelineMatch = p.match(/\/pipelines\/(\d+)(\/jobs)?$/); if (pipelineMatch) return new Response(JSON.stringify(pipelineMatch[2] ? jobs(Number(pipelineMatch[1])) : pipeline(Number(pipelineMatch[1]))));
    const jobMatch = p.match(/\/jobs\/(\d+)(?:\/artifacts\/(.+))?$/); assert(jobMatch, `unexpected ${url}`); const runId = Math.floor(Number(jobMatch[1]) / 10);
    if (!jobMatch[2]) return new Response(JSON.stringify(jobs(runId).find((j) => j.id === Number(jobMatch[1]))));
    const currentSha = runSha(runId), file = jobMatch[2], failed = mode === "failed";
    if (file === "app.bin") return new Response("actual-binary");
    if (file === "quality/manifest.json") return new Response(JSON.stringify({ schemaVersion: 1, project: "demo", commitSha: currentSha, sourceDigest: pin, targetEnv: "sit", createdAt: "2026-10-15T01:00:00Z", artifacts: [{ path: "app.bin", sha256: brokenManifest ? "d".repeat(64) : hash("actual-binary") }], configFiles: [] }));
    assert.equal(file, "quality/summary.json"); return new Response(JSON.stringify({ schemaVersion: 1, run: { project: "demo", profile: "standard", commitSha: currentSha, eventId: `report-${runId}`, startedAt: "2026-10-15T01:00:00Z", durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: pin }, policy: { policyHash: pin, ruleSetHash: pin, baselineHash: pin, waiversHash: pin, requiredCheckIds: ["CHECK"], checksSelected: 1, lockedToolVersions: { CHECK: "fixture@1" } }, checks: [{ checkId: "CHECK", required: true, status: "ok", toolVersionVerified: true, toolVersion: "fixture@1" }], findings: failed ? [{ fingerprint: pin, ruleId: "R", severity: "error", file: "A.java", line: 1, status: "new" }] : [], counts: { blockingNew: failed ? 1 : 0 }, decision: { status: failed ? "blocked" : "passed", reasons: [] } }));
  };
  const tick = (options = {}) => automationTick({ configFile, env: { TOKEN: "NEVER_PRINT_TOKEN" }, fetchImpl, now: now + ticks++ * 1000, ...options });
  return { dir, config, configFile, ci, ciFile, tick, fetchImpl, mode: (v) => mode = v, missing: (v) => missing = v, brokenManifest: (v) => brokenManifest = v, runIds: (v) => runIds = v, requests: () => requests, state: () => readGovernanceState({ configFile: governanceConfigFile, stateFile }), progress: () => JSON.parse(readFileSync(path.join(config.dataDir, "automation-state.json"))) };
}
test("实际分页发现→running事实→稳定重试不重复→success新generation→旧漏跑待复验", async (t) => {
  const f = fixture(t); const first = await f.tick(); assert.equal(first.status, "ok", JSON.stringify(first.errors));
  const initial = f.state(); assert.equal(Object.values(initial.lifecycles)[0].status, "running"); assert.equal(Object.values(initial.issues)[0].status, "open");
  await f.tick(); assert.equal(Object.values(f.state().events).filter((e) => e.kind === "lifecycle-event").length, 1);
  f.mode("success"); const complete = await f.tick(); assert.equal(complete.status, "ok", JSON.stringify(complete.errors));
  assert.equal(Object.values(f.state().lifecycles)[0].status, "success"); assert.equal(Object.values(f.state().issues)[0].status, "awaitingVerification");
  assert.equal(f.progress().runs["demo-full:45"].generation, 2);
  assert.equal(Object.values(f.state().events).filter((e) => e.kind === "quality-event").length, 1);
  await f.tick(); assert.equal(Object.values(f.state().events).filter((e) => e.kind === "quality-event").length, 1);
});
test("必需作业根本未创建仍自动建漏跑；同run补跑后不会遗留永远open旧序号", async (t) => {
  const f = fixture(t); f.missing(true); f.mode("success"); const first = await f.tick(); assert.equal(first.status, "attention"); assert.equal(first.sources[0].discovered, 1);
  assert.equal(Object.values(f.state().issues)[0].ruleId, "GOV/NOT-RUN"); f.missing(false);
  const second = await f.tick(); assert.equal(second.status, "ok", JSON.stringify(second.errors)); assert.equal(Object.values(f.state().issues)[0].status, "awaitingVerification");
});
test("quality入账后中断：持久同份receipt续跑，不重新采集、不改事件正文", async (t) => {
  const f = fixture(t); f.mode("success"); let injected = false;
  const first = await f.tick({ afterStage: (stage) => { if (stage === "quality-ingested" && !injected) { injected = true; throw new Error("injected crash after ledger commit"); } } }); assert.equal(first.status, "attention");
  const progress = Object.values(f.progress().runs["demo-full:45"].revisions)[0], original = readFileSync(progress.qualityReceiptFile), source = readFileSync(progress.collection.sourceFile);
  const second = await f.tick(); assert.equal(second.status, "ok", JSON.stringify(second.errors)); assert.equal(second.sources[0].collected, 0);
  assert.deepEqual(readFileSync(progress.qualityReceiptFile), original); assert.deepEqual(readFileSync(progress.collection.sourceFile), source);
  assert.equal(Object.values(f.state().events).filter((e) => e.kind === "quality-event").length, 1); assert.equal(Object.values(f.state().lifecycles)[0].status, "success");
});
test("build入账后中断，暂停25小时仍核对已入账相同摘要并恢复，不修改旧观察时间", async (t) => {
  const f = fixture(t); f.mode("success"); let injected = false;
  await f.tick({ afterStage: (stage) => { if (stage === "build-ingested" && !injected) { injected = true; throw new Error("injected build checkpoint failure"); } } });
  const old = Object.values(f.progress().runs["demo-full:45"].revisions)[0], bytes = readFileSync(old.buildReceiptFile);
  const next = await f.tick({ now: now + 25 * 3600000 }); assert.equal(next.status, "ok", JSON.stringify(next.errors));
  assert.equal(next.sources[0].collected, 0); assert.equal(f.progress().runs["demo-full:45"].generation, 1); assert.deepEqual(readFileSync(old.buildReceiptFile), bytes);
  assert.equal(Object.values(f.state().lifecycles)[0].sequence, 450001);
});
test("尚未入账的采集超过24小时：保留旧原件，重新查源分配新generation", async (t) => {
  const f = fixture(t); f.mode("success"); delete f.config.sources[0].manifestPath; write(f.configFile, f.config); let injected = false;
  await f.tick({ afterStage: (stage) => { if (stage === "source-collected" && !injected) { injected = true; throw new Error("crash before any ingest"); } } });
  const old = Object.values(f.progress().runs["demo-full:45"].revisions)[0], bytes = readFileSync(old.collection.sourceFile);
  const next = await f.tick({ now: now + 25 * 3600000 }); assert.equal(next.status, "ok", JSON.stringify(next.errors));
  assert.equal(next.sources[0].collected, 1); assert.equal(f.progress().runs["demo-full:45"].generation, 2); assert.deepEqual(readFileSync(old.collection.sourceFile), bytes);
  assert.equal(f.state().scopes["demo:full"].sequence, 450002);
});
test("坏构建清单失败不抹去已入账质量事件，反复续跑显式失败且可审计", async (t) => {
  const f = fixture(t); f.mode("success"); f.brokenManifest(true); const first = await f.tick(); assert.equal(first.status, "attention");
  assert.equal(Object.values(f.state().events).filter((e) => e.kind === "quality-event").length, 1);
  const second = await f.tick(); assert.equal(second.status, "attention"); assert.equal(second.sources[0].collected, 0); assert.match(second.errors[0].reason, /实际制品/);
  assert.equal(Object.values(f.state().events).filter((e) => e.kind === "quality-event").length, 1); assert.ok(f.progress().history.length === 2);
});
test("旧流水线晚到不能覆盖新SHA；顺序预算及中央配置漂移拒绝", async (t) => {
  const f = fixture(t); f.mode("success"); f.runIds([46]); await f.tick(); f.runIds([45, 46]); const next = await f.tick(); assert.equal(next.status, "ok", JSON.stringify(next.errors));
  assert.equal(f.state().scopes["demo:full"].sha, "c".repeat(40)); assert.equal(Object.values(f.state().lifecycles)[0].sha, "c".repeat(40));
  f.config.sources.push({ ...f.config.sources[0], id: "duplicate" }); write(f.configFile, f.config); assert.throws(() => loadAutomationConfig(f.configFile), /只能绑定一个CI来源/);
});
test("一个来源故障继续已有项目对账和其他来源，凭据不进入持久结果", async (t) => {
  const f = fixture(t); f.mode("success"); await f.tick(); const second = await f.tick({ discoverImpl: async () => { throw new Error("CI read unavailable"); } });
  assert.equal(second.status, "attention"); assert.equal(second.sources[0].errors[0].stage, "source"); assert.equal(f.progress().health["demo-full"].status, "attention"); assert.ok(second.delivery);
  assert.ok(!JSON.stringify(f.progress()).includes("NEVER_PRINT_TOKEN")); assert.ok(readdirSync(f.config.dataDir).length > 1);
});
test("CI来源故障仍消费部署队列，坏部署交付独立报错且不阻断消息恢复", async (t) => {
  const f = fixture(t), deliveryDir = path.join(f.dir, "deployment-deliveries"); mkdirSync(deliveryDir);
  f.config.deployments = { deliveryDir, configs: { uat: { configFile: path.join(f.dir, "approved-deployment.json"), executorPublicKeyFile: path.join(f.dir, "executor-public.pem"), executionRoot: path.join(f.dir, "executions") } } };
  write(f.configFile, f.config);
  const empty = await f.tick({ discoverImpl: async () => { throw new Error("CI source offline"); } });
  assert.equal(empty.deployments.status, "ok"); assert.equal(empty.deployments.delivered, 0); assert.ok(empty.delivery);
  write(path.join(deliveryDir, "delivery-" + "a".repeat(48) + ".json"), { schemaVersion: 1, kind: "wrong-type" });
  const bad = await f.tick({ discoverImpl: async () => { throw new Error("CI source offline"); } });
  assert.equal(bad.deployments.status, "attention"); assert.ok(bad.errors.some((e) => e.stage === "deployment")); assert.ok(bad.delivery);
});
test("发现水位先持久而处理前中断，所有run仍在重查队列，续页后不漏当前候选", async (t) => {
  const f = fixture(t); f.mode("success"); let cut = false;
  const first = await f.tick({ afterStage: (stage) => { if (stage === "discovery-checkpointed" && !cut) { cut = true; throw new Error("crash after discovery checkpoint"); } } });
  assert.equal(first.status, "attention"); assert.deepEqual(f.progress().discovery["demo-full"].pendingRunIds, [45]);
  const recovered = await f.tick(); assert.equal(recovered.status, "ok", JSON.stringify(recovered.errors));
  assert.equal(f.state().scopes["demo:full"].sha, sha); assert.deepEqual(f.progress().discovery["demo-full"].pendingRunIds, []);
});
test("1001条未完成运行持久轮转分批重查，尾部不会因1000上限永久饥饿", async (t) => {
  const f = fixture(t); f.mode("success"); await f.tick();
  const file = path.join(f.config.dataDir, "automation-state.json"), state = f.progress(); state.discovery["demo-full"].pendingRunIds = Array.from({ length: 1001 }, (_, i) => i + 1000); write(file, state);
  const batches = [], discoverImpl = async ({ recheckRunIds }) => { batches.push(recheckRunIds); return { runs: [], discoveryErrors: [], attemptedRecheckRunIds: recheckRunIds, watermark: new Date(now).toISOString(), partial: false }; };
  await f.tick({ discoverImpl }); await f.tick({ discoverImpl });
  assert.equal(batches[0].length, 1000); assert.equal(batches[1].length, 1000); assert.equal(new Set(batches.flat()).size, 1001); assert.equal(f.progress().discovery["demo-full"].pendingRunIds.length, 1001);
});
test("来源ID包含冒号时按完整source归属隔离运行，不把前缀相似来源加入重查", async (t) => {
  const f = fixture(t), governance = JSON.parse(readFileSync(f.config.governanceConfigFile)); governance.projects.demo.scopes.other = structuredClone(governance.projects.demo.scopes.full); write(f.config.governanceConfigFile, governance);
  const secondConfig = path.join(f.dir, "ci-other.json"); write(secondConfig, { ...f.ci, scope: "other" }); f.config.sources.push({ ...f.config.sources[0], id: "demo-full:other", configFile: secondConfig }); write(f.configFile, f.config);
  const calls = [], discoverImpl = async (options) => { const ci = JSON.parse(readFileSync(options.configFile)), runId = ci.scope === "full" ? 45 : 77; calls.push({ scope: ci.scope, recheck: options.recheckRunIds }); return { runs: [{ runId, sha, ref: "uat", dueAt: new Date(now - 1000).toISOString(), pipelineUrl: origin + "/p/" + runId, authorId: "owner", terminal: false, missingJobs: ["quality"], status: "running", observedRevision: hash(ci.scope) }], discoveryErrors: [], attemptedRecheckRunIds: options.recheckRunIds }; };
  await f.tick({ discoverImpl }); await f.tick({ discoverImpl }); assert.deepEqual(calls.slice(2), [{ scope: "full", recheck: [45] }, { scope: "other", recheck: [77] }]);
});
test("治理台账被单独回退时稳定运行缓存显式报错，不默认为已处理", async (t) => {
  const f = fixture(t); f.mode("success"); await f.tick(); rmSync(f.config.stateFile);
  const result = await f.tick(); assert.equal(result.status, "attention"); assert.match(result.errors[0].reason, /台账与执行缓存不一致/);
});
