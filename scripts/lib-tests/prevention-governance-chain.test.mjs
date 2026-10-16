import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash, createHmac } from "node:crypto";
import { automationTick } from "../../lib/automation.js";
import { readGovernanceState, signPlatformReceipt, actionGovernance, ingestLifecycleGovernance } from "../../lib/governance.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const pin = "a".repeat(64), sha = "b".repeat(40), origin = "https://ci.example.invalid", control = "https://quality.example.invalid";
const epoch = Date.parse("2026-10-16T01:00:00Z");
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

// Every GET goes through the production GitLab discovery/collector. Every POST
// goes through the real signed-card/outbox implementation; the remote endpoints
// alone are in-memory substitutes. No business repository or real chat is used.
function chain(t, name) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-prevention-chain-"));
  const keys = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, "receipt-private.pem"), publicKeyFile = path.join(dir, "receipt-public.pem");
  writeFileSync(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  const configFile = path.join(dir, "automation.json"), governanceConfigFile = path.join(dir, "governance.json"), ciFile = path.join(dir, "ci.json"), stateFile = path.join(dir, "ledger.json");
  write(governanceConfigFile, { schemaVersion: 1, issuer: "central", publicKeyFile, allowedLinkOrigins: [origin, control], operators: ["operator"],
    projects: { demo: { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer", "author"], channel: "group", issueBaseUrl: control + "/issues", scopes: { standard: {
      requiredChecks: ["CHECK"], policyHash: pin, rulesHash: pin, baselineHash: pin, waiversHash: pin,
      closurePolicy: { requiredEnvironments: ["sit"], deploymentLane: "release", requireDeployment: true }
    } } } }, channels: { group: { type: "feishu", webhookEnv: "GROUP_WEBHOOK", signingSecretEnv: "GROUP_SECRET" } },
    sla: { ackMinutes: 1, resolveMinutes: 2, escalationMinutes: 1 }, delivery: { maxAttempts: 2, retrySeconds: 1, timeoutMs: 1000 } });
  write(ciFile, { schemaVersion: 1, system: "gitlab", project: "demo", scope: "standard", baseUrl: origin, projectId: 12, trustedRunnerIds: [77], tokenEnv: "TOKEN", ref: "uat", requiredJobs: ["quality", "business"],
    artifacts: { job: "quality", paths: ["quality/summary.json", "quality/manifest.json", "app.bin"] }, qualitySummary: "quality/summary.json", discovery: { pageSize: 10, dueAfterMinutes: 60 } });
  const config = { schemaVersion: 1, governanceConfigFile, stateFile, dataDir: path.join(dir, "data"), receiptPrivateKeyFile: privateKeyFile, sources: [{ id: "demo-standard", configFile: ciFile, actors: { "15": "author" }, since: "2026-10-16T00:00:00Z", environment: "sit", manifestPath: "quality/manifest.json" }] };
  write(configFile, config);
  const env = { TOKEN: "isolated-ci-credential", GROUP_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/simulation-only", GROUP_SECRET: "isolated-signing-secret" };
  let mode = "error", runId = 45, instant = epoch, offline = false, provider = "accepted", nonce = 0, missingQuality = false;
  const requests = [], stages = [];
  const pipeline = () => ({ id: runId, project_id: 12, sha, ref: "uat", user: { id: 15 }, status: mode === "error" ? "failed" : "success", created_at: "2026-10-16T00:59:00Z", web_url: `${origin}/p/${runId}` });
  const jobs = () => ["quality", "business"].map((name, i) => ({ id: runId * 10 + i, name, pipeline: { id: runId }, commit: { id: sha }, ref: "uat", status: mode === "error" && name === "quality" ? "failed" : "success", runner: { id: 77 }, allow_failure: false, web_url: `${origin}/j/${runId * 10 + i}` })).filter((job) => !missingQuality || job.name !== "quality");
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "error");
    if (init.method === "POST") {
      assert.equal(url, env.GROUP_WEBHOOK); const body = JSON.parse(init.body);
      assert.equal(body.sign, createHmac("sha256", `${body.timestamp}\n${env.GROUP_SECRET}`).update("").digest("base64"));
      assert.equal(body.msg_type, "interactive");
      const response = provider === "accepted" ? { code: 0 } : { code: 19024, msg: "signature-invalid" };
      requests.push({ method: "POST", url: "feishu://simulation-only", body, response });
      if (provider === "unknown") throw new Error("simulated socket closed after request");
      return new Response(JSON.stringify(response));
    }
    assert.equal(init.method, "GET"); requests.push({ method: "GET", url });
    if (offline) throw new Error("simulated CI read unavailable");
    const p = new URL(url).pathname;
    if (p.endsWith("/pipelines")) return new Response(JSON.stringify([pipeline()]));
    if (/\/pipelines\/\d+\/jobs$/.test(p)) return new Response(JSON.stringify(jobs()));
    if (/\/pipelines\/\d+$/.test(p)) return new Response(JSON.stringify(pipeline()));
    const job = p.match(/\/jobs\/(\d+)(?:\/artifacts\/(.+))?$/); assert(job, `unexpected URL ${url}`);
    if (!job[2]) return new Response(JSON.stringify(jobs().find((item) => item.id === Number(job[1]))));
    if (job[2] === "app.bin") return new Response("actual-binary");
    if (job[2] === "quality/manifest.json") return new Response(JSON.stringify({ schemaVersion: 1, project: "demo", commitSha: sha, sourceDigest: pin, targetEnv: "sit", createdAt: "2026-10-16T00:59:00Z", artifacts: [{ path: "app.bin", sha256: hash("actual-binary") }], configFiles: [] }));
    assert.equal(job[2], "quality/summary.json");
    const finding = { fingerprint: hash("RISK:sql-concatenation"), ruleId: "BD/SQL-CONCAT", severity: mode === "warning" ? "warning" : "error", file: "src/OrderService.java", line: 17, status: "new" };
    return new Response(JSON.stringify({ schemaVersion: 1, run: { project: "demo", profile: "standard", commitSha: sha, eventId: `report-${runId}`, startedAt: new Date(instant).toISOString(), durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: pin },
      policy: { policyHash: pin, ruleSetHash: pin, baselineHash: pin, waiversHash: pin, requiredCheckIds: ["CHECK"], checksSelected: 1, lockedToolVersions: { CHECK: "fixture@1" } },
      checks: [{ checkId: "CHECK", required: true, status: "ok", toolVersionVerified: true, toolVersion: "fixture@1" }], findings: mode === "clean" ? [] : [finding], counts: { blockingNew: mode === "error" ? 1 : 0 }, decision: { status: mode === "error" ? "blocked" : "passed", reasons: [] } }));
  };
  const state = () => readGovernanceState({ configFile: governanceConfigFile, stateFile });
  const issue = () => Object.values(state().issues).find((item) => item.ruleId === "BD/SQL-CONCAT");
  const receipt = (payload) => { const file = path.join(dir, `receipt-${nonce++}.json`); write(file, signPlatformReceipt(payload, { privateKeyFile, issuer: "central", createdAt: new Date(instant).toISOString() })); return file; };
  const action = (payload) => actionGovernance({ configFile: governanceConfigFile, stateFile, now: instant, actionFile: receipt({ schemaVersion: 1, kind: "issue-action", eventId: `action-${nonce++}`, ...payload }) });
  const tick = async (options = {}) => { const result = await automationTick({ configFile, env, fetchImpl, now: instant, send: true, ...options }); stages.push({ instant: new Date(instant).toISOString(), result }); return result; };
  const fact = ({ category = "deploy", status = "verified", sequence = 1, occurredAt = instant, actorId = "reviewer" } = {}) => {
    const sourceFile = path.join(dir, `verification-${nonce++}.json`); write(sourceFile, { trustedExecutor: "isolated-simulator", status, sha });
    const event = { schemaVersion: 1, kind: "lifecycle-event", eventId: `lifecycle-${nonce++}`, category, status, project: "demo", scope: "standard", lane: category === "deploy" ? "release" : "main", environment: "sit", sha, authorId: "author", actorId, sequence,
      deploymentId: "deployment-1", authorizationId: "auth-1", artifactHash: pin, manifestHash: pin, releaseSetHash: pin, executionHash: pin, verificationHash: pin, verificationUrl: control + "/verification", pipelineId: "release-pipeline", jobId: "smoke", reportUrl: control + "/report", pipelineUrl: origin + "/p/45", occurredAt: new Date(occurredAt).toISOString(),
      source: { system: category === "deploy" ? "deployment" : "review", recordId: "record-1", recordHash: hash(readFileSync(sourceFile)), observedAt: new Date(instant).toISOString(), url: control + "/executor" }, ...(category === "review" ? { reviewId: "review-1", reportHash: pin, evidenceHash: pin } : {}) };
    ingestLifecycleGovernance({ configFile: governanceConfigFile, stateFile, eventFile: receipt(event), sourceFile, now: instant }); return event;
  };
  const close = (overrides = {}) => { const current = issue(); return action({ action: "close", actorId: "reviewer", issueId: current.id, expectedRevision: current.revision, sha, reportHash: current.pendingEvidence.reportHash, environment: "sit", result: "passed", reason: "独立人员验证当前修复结果和环境证据", verificationUrl: control + "/verification", ...overrides }); };
  const evidence = () => {
    if (!process.env.WL_FULL_CHAIN_EVIDENCE_DIR) return;
    const destination = path.join(process.env.WL_FULL_CHAIN_EVIDENCE_DIR, name); mkdirSync(destination, { recursive: true });
    const rawArtifacts = {};
    const collect = (directory) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) collect(file); else if (entry.isFile() && entry.name.endsWith(".json")) { const bytes = readFileSync(file); rawArtifacts[path.relative(dir, file)] = { sha256: hash(bytes), utf8: bytes.toString("utf8") }; } } };
    collect(dir);
    write(path.join(destination, "execution.json"), { schemaVersion: 1, simulation: true, realChatContacted: false, stages, requests, ledger: state(), rawArtifacts });
    assert(!JSON.stringify({ stages, ledger: state() }).includes(env.TOKEN));
    assert(!JSON.stringify({ stages, ledger: state() }).includes(env.GROUP_SECRET));
  };
  t.after(() => { try { evidence(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  return { config, configFile, governanceConfigFile, stateFile, dir, tick, state, issue, action, fact, close, requests,
    setMode: (value) => mode = value, setRun: (value) => runId = value, setProvider: (value) => provider = value, setOffline: (value) => offline = value, setMissingQuality: (value) => missingQuality = value,
    advance: (ms) => instant += ms, now: () => instant };
}

test("全链路：实际采集阻断→签名卡片→主备认领→脚本修复新报告→独立环境复验→关闭→复发重开", async (t) => {
  const f = chain(t, "01-fix-close-reopen"); assert.equal((await f.tick()).status, "ok");
  assert.equal(f.issue().status, "open"); assert(f.requests.some((r) => r.method === "POST" && r.body.card.header.title.content.includes("代码质量")));
  const initial = f.issue(); assert.throws(() => f.action({ action: "claim", actorId: "stranger", issueId: initial.id, expectedRevision: initial.revision }), /主备/);
  f.action({ action: "claim", actorId: "owner", issueId: initial.id, expectedRevision: initial.revision });
  f.advance(5000); f.setRun(46); f.setMode("clean"); assert.equal((await f.tick()).status, "ok");
  assert.equal(f.issue().status, "awaitingVerification"); assert.throws(() => f.close({ actorId: "author" }), /独立非作者/); assert.throws(() => f.close(), /逐必要环境/);
  f.advance(5000); const verified = f.fact(); assert.equal(f.issue().status, "awaitingVerification");
  f.close({ verificationEventIds: [verified.eventId] }); assert.equal(f.issue().status, "closed");
  await f.tick(); assert(f.requests.some((r) => r.method === "POST" && r.body.card.header.title.content.includes("已独立复验关闭")));
  f.advance(5000); f.setRun(47); f.setMode("error"); await f.tick(); assert.equal(f.issue().status, "open"); assert.equal(f.issue().recurrence, 1);
});

test("全链路：HTTP 200 业务失败不算送达；自动退避后成功且稳定轮次不重复发", async (t) => {
  const f = chain(t, "02-provider-retry"); f.setProvider("rejected"); const first = await f.tick(); assert.equal(first.status, "attention");
  const riskId = Object.values(f.state().outbox).find((item) => item.snapshot.ruleId === "BD/SQL-CONCAT").id;
  assert.equal(f.state().outbox[riskId].status, "retry"); assert.equal(f.state().outbox[riskId].lastResult, "provider-rejected");
  f.advance(2000); f.setProvider("accepted"); assert.equal((await f.tick()).status, "ok"); assert.equal(f.state().outbox[riskId].status, "delivered");
  const sent = f.requests.filter((r) => r.method === "POST").length; f.advance(2000); await f.tick(); assert.equal(f.requests.filter((r) => r.method === "POST").length, sent);
});

test("全链路：未知网络结果不盲发，认证运维核实后恢复；认领后不再催未认领", async (t) => {
  const f = chain(t, "03-unknown-delivery-sla"); f.setProvider("unknown"); await f.tick();
  const item = Object.values(f.state().outbox).find((entry) => entry.snapshot.ruleId === "BD/SQL-CONCAT"), sent = f.requests.filter((r) => r.method === "POST").length;
  assert.equal(item.status, "attempting"); await f.tick(); assert.equal(f.requests.filter((r) => r.method === "POST").length, sent);
  assert.throws(() => f.action({ action: "resolve-delivery", actorId: "owner", messageId: item.id, expectedAttemptId: item.attemptId, reason: "查无消息", outcome: "not-received", verificationUrl: control + "/audit/1" }), /运维授权/);
  f.action({ action: "resolve-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "消息端日志已确认无本次发送记录", outcome: "not-received", verificationUrl: control + "/audit/1" });
  f.setProvider("accepted"); await f.tick(); assert.equal(f.state().outbox[item.id].status, "delivered");
  const current = f.issue(); f.action({ action: "claim", actorId: "backup", issueId: current.id, expectedRevision: current.revision });
  f.advance(130000); await f.tick(); assert(f.issue().escalations.some((key) => key.startsWith("overdue:"))); assert(!f.issue().escalations.some((key) => key.startsWith("unclaimed:")));
});

test("预防要求：未阻断 warning 首次发现也由自动执行器发摘要，不能等到超时才提醒", async (t) => {
  const f = chain(t, "04-early-warning"); f.setMode("warning"); const result = await f.tick(); assert.equal(result.status, "ok");
  const item = Object.values(f.state().outbox).find((entry) => entry.snapshot.ruleId === "BD/SQL-CONCAT");
  assert.equal(item.status, "delivered", "warning 摘要必须由中央周期主动消费");
  assert(f.requests.some((r) => r.method === "POST" && r.body.card.header.title.content.includes("代码质量")));
});

test("预防要求：首次CI来源不可用也产生持久执行异常通知，恢复时产生恢复事实", async (t) => {
  const f = chain(t, "05-source-health"); f.setOffline(true); const first = await f.tick(); assert.equal(first.status, "attention");
  assert(f.requests.some((r) => r.method === "POST"), "没有历史流水线不能成为中央采集故障无提醒的理由");
  const firstCount = f.requests.filter((r) => r.method === "POST").length; await f.tick(); assert.equal(f.requests.filter((r) => r.method === "POST").length, firstCount, "同一故障保持时不能每分钟刷屏");
  f.advance(5000); f.setOffline(false); f.setMode("clean"); await f.tick(); assert(f.requests.filter((r) => r.method === "POST").length > firstCount);
  const recovered = Object.values(f.state().lifecycles).find((fact) => fact.category === "collection"); assert.equal(recovered.status, "recovered"); assert.equal(recovered.sha, undefined); assert.equal(recovered.authorId, undefined);
});

test("闭环要求：问题复发同SHA重扫后不能复用上一轮旧环境验证事实直接关闭", async (t) => {
  const f = chain(t, "06-old-verification"); await f.tick(); f.advance(1000); f.setRun(46); f.setMode("clean"); await f.tick();
  f.advance(1000); const verified = f.fact(); f.close({ verificationEventIds: [verified.eventId] });
  f.advance(5000); f.setRun(47); f.setMode("error"); await f.tick(); assert.equal(f.issue().status, "open");
  f.advance(5000); f.setRun(48); f.setMode("clean"); await f.tick(); assert.equal(f.issue().status, "awaitingVerification");
  assert.throws(() => f.close({ verificationEventIds: [verified.eventId] }), /当前修复|早于|旧|本轮|验证时间/, "同 SHA 的旧验证发生在本轮问题之前，不能复用为修复完成依据");
  f.advance(1000); const renewed = f.fact({ sequence: 2 }); f.close({ verificationEventIds: [renewed.eventId] }); assert.equal(f.issue().status, "closed");
});

test("采集提醒持久化后中断：同份签名原件自动续跑；故障逾SLA升级，恢复事实不冒充质量通过", async (t) => {
  const f = chain(t, "07-health-crash-restart"); f.setOffline(true); let cut = false;
  const first = await f.tick({ afterStage: (stage) => { if (stage === "source-health-ingested" && !cut) { cut = true; throw new Error("simulated process stopped after health ledger write"); } } }); assert.equal(first.status, "attention");
  const progressFile = path.join(f.config.dataDir, "automation-state.json"), before = JSON.parse(readFileSync(progressFile));
  assert(before.health["demo-standard"].pendingNotification); const receipt = readFileSync(before.health["demo-standard"].pendingNotification.receiptFile);
  await f.tick(); const resumed = JSON.parse(readFileSync(progressFile)); assert(!resumed.health["demo-standard"].pendingNotification); assert.deepEqual(readFileSync(resumed.health["demo-standard"].notification.receiptFile), receipt);
  const initialCount = f.requests.filter((r) => r.method === "POST").length; f.advance(61000); await f.tick(); assert.equal(f.requests.filter((r) => r.method === "POST").length, initialCount + 1);
  f.advance(1000); f.setOffline(false); f.setMode("error"); await f.tick(); assert.equal(Object.values(f.state().lifecycles).find((fact) => fact.category === "collection").status, "recovered"); assert.equal(f.issue().status, "open");
});

test("部署队列坏原件与Review publication故障均触发执行提醒，修正原件后周期自动回流", async (t) => {
  const f = chain(t, "08-queue-health"); f.setMode("clean"); const deliveryDir = path.join(f.dir, "delivery-queue"); mkdirSync(deliveryDir);
  f.config.deployments = { deliveryDir, configs: { sit: { configFile: path.join(f.dir, "deployment.json"), executorPublicKeyFile: path.join(f.dir, "executor-public.pem"), executionRoot: path.join(f.dir, "executions") } } }; write(f.configFile, f.config);
  await f.tick(); const invalid = path.join(deliveryDir, "delivery-" + "d".repeat(48) + ".json"); write(invalid, { schemaVersion: 1, kind: "untrusted-delivery" });
  f.advance(1000); const failed = await f.tick(); assert.equal(failed.status, "attention");
  const health = Object.values(f.state().lifecycles).find((fact) => fact.category === "collection"); assert.equal(health.status, "attention"); assert(health.errorStages.includes("deployment"));
  assert(f.requests.some((request) => request.method === "POST" && request.body.card.header.title.content.includes("采集执行异常")));
  rmSync(invalid); f.advance(1000); await f.tick(); assert.equal(Object.values(f.state().lifecycles).find((fact) => fact.category === "collection").status, "recovered");
  rmSync(deliveryDir, { recursive: true }); f.advance(1000); const lostQueue = await f.tick(); assert.equal(lostQueue.status, "attention"); assert(lostQueue.errors.some((error) => /不存在或未挂载/.test(error.reason)));
  mkdirSync(deliveryDir); f.advance(1000); await f.tick(); assert.equal(Object.values(f.state().lifecycles).find((fact) => fact.category === "collection").status, "recovered");
  const publication = chain(t, "09-review-publication-health"), reviewDir = path.join(publication.dir, "formal"); mkdirSync(reviewDir);
  write(path.join(publication.dir, "invalid-review.json"), { schemaVersion: 1 });
  publication.config.sources[0].review = { configFile: path.join(publication.dir, "invalid-review.json"), outRoot: path.join(publication.dir, "review-output"), publication: {
    manifestDir: reviewDir, publicKeyFile: path.join(publication.dir, "missing-review-public.pem"), authorizationPublicKeyFile: path.join(publication.dir, "missing-authorization-public.pem"), evidenceRoot: publication.dir, expectAuthorizationIssuer: "review-authority", expectReviewPolicyHash: pin
  } }; write(publication.configFile, publication.config);
  const result = await publication.tick(); assert.equal(result.status, "attention"); assert(result.errors.some((error) => error.stage === "formal-review"));
  assert(Object.values(publication.state().lifecycles).find((fact) => fact.category === "collection").errorStages.includes("formal-review"));
  assert(publication.requests.some((request) => request.method === "POST" && request.body.card.header.title.content.includes("执行提醒")));
});

test("Review草稿和非作者授权结果分类通知，取消不显示通过；作者不能伪造正式批准", async (t) => {
  const f = chain(t, "10-review-notifications"); f.setMode("clean"); await f.tick();
  f.fact({ category: "review", status: "draft" }); await f.tick(); assert(f.requests.some((request) => request.method === "POST" && request.body.card.header.title.content.includes("草稿 · 待确认")));
  assert.throws(() => f.fact({ category: "review", status: "approved", sequence: 2, actorId: "author" }), /明确授权/);
  f.fact({ category: "review", status: "approved", sequence: 2 }); await f.tick(); assert(f.requests.some((request) => request.method === "POST" && request.body.card.header.title.content.includes("已授权确认")));
  f.fact({ category: "review", status: "canceled", sequence: 3 }); await f.tick(); const card = f.requests.filter((request) => request.method === "POST").at(-1).body.card;
  assert.match(card.header.title.content, /无有效批准/); assert.equal(card.header.template, "orange"); assert.equal(Object.keys(f.state().issues).length, 0);
});

test("漏跑闭环：必需作业未创建先提醒，同运行真实补跑后独立验证可关闭且复扫证据不丢时间绑定", async (t) => {
  const f = chain(t, "11-missing-run-close"); f.setMode("clean"); f.setMissingQuality(true); f.advance(2 * 3600000);
  assert.equal((await f.tick()).status, "attention"); let missing = Object.values(f.state().issues).find((item) => item.ruleId === "GOV/NOT-RUN"); assert.equal(missing.status, "open");
  assert(f.requests.some((request) => request.method === "POST" && request.body.card.header.title.content.includes("处理提醒")));
  f.setMissingQuality(false); f.advance(1000); await f.tick(); missing = f.state().issues[missing.id]; assert.equal(missing.status, "awaitingVerification"); assert(missing.pendingEvidence.receivedAt);
  f.advance(1000); const verified = f.fact();
  f.action({ action: "close", actorId: "reviewer", issueId: missing.id, expectedRevision: missing.revision, sha, reportHash: missing.pendingEvidence.reportHash, environment: "sit", result: "passed", reason: "补跑后独立复核对应环境实际结果", verificationUrl: control + "/verification", verificationEventIds: [verified.eventId] });
  assert.equal(f.state().issues[missing.id].status, "closed");
});
