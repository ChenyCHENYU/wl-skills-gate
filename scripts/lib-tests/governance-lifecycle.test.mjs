import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash, createHmac } from "node:crypto";
import { signPlatformReceipt, ingestLifecycleGovernance, ingestGovernance, outboxGovernance, dispatchGovernance, actionGovernance } from "../../lib/governance.js";
const digest = (x) => createHash("sha256").update(x).digest("hex"), hash = "a".repeat(64), sha = "b".repeat(40), now = Date.parse("2026-10-15T00:00:00Z");
function fixture(t) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-lifecycle-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, "private.pem"), publicKeyFile = path.join(dir, "public.pem");
  writeFileSync(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  const configFile = path.join(dir, "config.json"), stateFile = path.join(dir, "ledger.json");
  const config = { schemaVersion: 1, issuer: "central", publicKeyFile, allowedLinkOrigins: ["https://quality.example.invalid"], operators: ["operator"], projects: { demo: { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: "https://quality.example.invalid/issues", scopes: { full: { requiredChecks: ["CHECK"], policyHash: hash, rulesHash: hash, baselineHash: hash, waiversHash: hash } } } }, channels: { group: { type: "feishu", webhookEnv: "GROUP_WEBHOOK", signingSecretEnv: "GROUP_SECRET" } }, delivery: { maxAttempts: 2, retrySeconds: 1, timeoutMs: 1000 } };
  writeFileSync(configFile, JSON.stringify(config)); let count = 0;
  const base = { configFile, stateFile, now, clock: () => 0 };
  const sourceFile = path.join(dir, "source.json"); writeFileSync(sourceFile, JSON.stringify({ capturedBy: "trusted-read-only-collector", status: "success", sha }));
  const receipt = (payload) => { const file = path.join(dir, `event-${count++}.json`); writeFileSync(file, JSON.stringify(signPlatformReceipt(JSON.parse(JSON.stringify(payload)), { privateKeyFile, issuer: "central", createdAt: new Date(now).toISOString() }))); return file; };
  function fact(overrides = {}) { return { schemaVersion: 1, kind: "lifecycle-event", eventId: `build-${count++}`, project: "demo", scope: "full", sha, authorId: "author", sequence: 1, pipelineId: "pipeline", jobId: "job", category: "build", lane: "main", status: "success", occurredAt: new Date(now).toISOString(), reportUrl: "https://quality.example.invalid/report", pipelineUrl: "https://quality.example.invalid/pipeline", artifactHash: hash, manifestHash: hash, artifactUrl: "https://quality.example.invalid/artifact", source: { system: "jenkins", recordId: "job-42", recordHash: digest(readFileSync(sourceFile)), observedAt: new Date(now).toISOString(), url: "https://quality.example.invalid/source" }, ...overrides }; }
  const ingest = (payload) => ingestLifecycleGovernance({ ...base, eventFile: receipt(payload), sourceFile });
  const state = () => JSON.parse(readFileSync(stateFile));
  return { ...base, dir, config, fact, ingest, state, receipt, sourceFile, env: { GROUP_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/mock-key", GROUP_SECRET: "mock-secret" } };
}
test("真实来源摘要绑定、默认卡片预览零网络、构建成功保持待部署验证", async (t) => {
  const f = fixture(t), event = f.fact(); assert.equal(f.ingest(event).status, "ingested");
  assert.equal(f.ingest(event).status, "duplicate"); assert.equal(Object.keys(f.state().outbox).length, 1); assert.equal(Object.keys(f.state().issues).length, 0);
  const preview = await dispatchGovernance({ ...f, fetchImpl: () => assert.fail("must not send") });
  const message = preview.messages[0]; assert.equal(message.category, "build"); assert.equal(message.payload.msg_type, "interactive"); assert.equal(message.payload.card.schema, "2.0"); assert.match(message.payload.card.header.title.content, /待部署验证/); assert.notEqual(message.payload.card.header.template, "green");
  for (const button of message.payload.card.body.elements.filter((x) => x.tag === "button")) assert.equal(button.behaviors[0].type, "open_url");
  assert.ok(!JSON.stringify(preview).includes("mock-secret"));
});
test("不同事件同序号拒绝、同编号内容冲突、旧成功不能覆盖新失败", (t) => {
  const f = fixture(t), newer = f.fact({ sequence: 2, status: "failed" }); f.ingest(newer);
  assert.throws(() => f.ingest({ ...newer, status: "success" }), /内容冲突/);
  assert.throws(() => f.ingest(f.fact({ sequence: 2 })), /序号冲突/);
  assert.equal(f.ingest(f.fact({ sequence: 1 })).status, "stale");
  assert.equal(Object.values(f.state().lifecycles)[0].status, "failed"); assert.equal(outboxGovernance(f).messages.length, 1);
});
test("新运行快照替换待发旧通知，不同通道/环境互不覆盖", (t) => {
  const f = fixture(t); f.ingest(f.fact()); f.ingest(f.fact({ sequence: 2, status: "failed" })); f.ingest(f.fact({ lane: "release" }));
  assert.equal(Object.values(f.state().outbox).filter((x) => x.status === "superseded").length, 1); assert.equal(outboxGovernance(f).messages.length, 2);
});
test("同通道不同部署环境各自保留状态", (t) => {
  const f = fixture(t), deployed = f.fact({ category: "deploy", environment: "uat", deploymentId: "deploy-1", authorizationId: "release-auth" });
  f.ingest(deployed); f.ingest({ ...deployed, eventId: "deploy-pre", environment: "pre" });
  assert.equal(Object.keys(f.state().lifecycles).length, 2); assert.equal(outboxGovernance(f).messages.length, 2);
});
for (const [label, mutate] of [
  ["缺少原始来源", (e) => e.source.recordHash = "c".repeat(64)],
  ["伪造来源时间", (e) => e.source.observedAt = new Date(now + 120000).toISOString()],
  ["来源过期", (e) => e.source.observedAt = new Date(now - 86400001).toISOString()],
  ["来源分类不符", (e) => e.source.system = "review"],
  ["伪造链接", (e) => e.reportUrl = "https://evil.invalid/report"],
  ["缺少制品摘要", (e) => delete e.artifactHash],
  ["缺少清单摘要", (e) => delete e.manifestHash],
  ["未登记范围", (e) => e.scope = "other"],
  ["未登记状态", (e) => e.status = "passed"],
]) test(`运行事实拒绝${label}`, (t) => { const f = fixture(t), e = f.fact(); mutate(e); assert.throws(() => f.ingest(e)); });
test("Review草稿、正式授权分开，作者/未登记审批人不能发已批准事实", (t) => {
  const f = fixture(t), draft = f.fact({ category: "review", status: "draft", reviewId: "review-1", reportHash: hash, evidenceHash: hash }); draft.source.system = "review";
  f.ingest(draft); assert.match(outboxGovernance(f).messages[0].text, /待技术经理审核/);
  const approved = { ...draft, eventId: "review-approved", sequence: 2, status: "approved", authorizationId: "auth-1", actorId: "reviewer" };
  assert.throws(() => f.ingest({ ...approved, actorId: "author" }), /明确授权/);
  assert.throws(() => f.ingest({ ...approved, actorId: "stranger" }), /明确授权/);
  assert.throws(() => f.ingest({ ...approved, authorizationId: undefined }), /明确授权/);
  f.ingest(approved); assert.match(outboxGovernance(f).messages[0].text, /审核已确认/); assert.equal(Object.keys(f.state().issues).length, 0);
});
test("已部署和环境验证分别陈述事实，缺独立复核和验证记录拒绝", (t) => {
  const f = fixture(t), deployed = f.fact({ category: "deploy", environment: "uat", deploymentId: "deploy-1", authorizationId: "release-auth" });
  f.ingest(deployed); assert.match(outboxGovernance(f).messages[0].text, /已部署 · 验证待完成/);
  const verified = { ...deployed, eventId: "verification", sequence: 2, status: "verified", actorId: "reviewer", verificationHash: hash, verificationUrl: "https://quality.example.invalid/verification" };
  assert.throws(() => f.ingest({ ...verified, actorId: "author" }), /独立复核/);
  assert.throws(() => f.ingest({ ...verified, verificationHash: undefined }), /验证证据/);
  f.ingest(verified); assert.match(outboxGovernance(f).messages[0].text, /问题待独立关闭/); assert.equal(Object.keys(f.state().issues).length, 0);
});
test("取消/未运行显示无有效结果，不要求不存在的制品也不显示绿色", (t) => {
  const f = fixture(t); f.ingest(f.fact({ status: "not-run", artifactHash: undefined, manifestHash: undefined, artifactUrl: undefined }));
  const card = outboxGovernance(f).messages[0].payload.card; assert.match(card.header.title.content, /无有效构建结果/); assert.equal(card.header.template, "orange");
});
test("分类卡片复用签名与provider接受判断，状态不影响问题闭环", async (t) => {
  const f = fixture(t); f.ingest(f.fact());
  const result = await dispatchGovernance({ ...f, send: true, env: f.env, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); assert.equal(body.msg_type, "interactive"); assert.equal(body.sign, createHmac("sha256", `${body.timestamp}\n${f.env.GROUP_SECRET}`).update("").digest("base64"));
    return { ok: true, json: async () => ({ code: 0 }) };
  } });
  assert.equal(result.results[0].status, "delivered"); assert.equal(Object.values(f.state().lifecycles)[0].status, "success"); assert.equal(Object.keys(f.state().issues).length, 0);
});
test("成功构建和已验证部署均不能关闭已有质量问题", (t) => {
  const f = fixture(t), report = { schemaVersion: 1, run: { project: "demo", profile: "standard", startedAt: new Date(now).toISOString(), durationMs: 10, commitSha: sha, tool: "gate", eventId: "quality-1", sourceBound: true, sourceDigest: hash }, policy: { policyHash: hash, ruleSetHash: hash, baselineHash: hash, waiversHash: hash, requiredCheckIds: ["CHECK"], enforceWarnings: false, checksSelected: 1, lockedToolVersions: { CHECK: "fixture@1" } }, checks: [{ checkId: "CHECK", required: true, status: "ok", toolVersionVerified: true, toolVersion: "fixture@1" }], findings: [{ fingerprint: hash, ruleId: "R", severity: "error", file: "src/Main.java", status: "new" }], counts: { blockingNew: 1 }, decision: { status: "blocked", reasons: [] } };
  const summaryFile = path.join(f.dir, "quality.json"); writeFileSync(summaryFile, JSON.stringify(report));
  const quality = { schemaVersion: 1, kind: "quality-event", eventId: "quality-1", project: "demo", scope: "full", sha, authorId: "author", sequence: 1, pipelineId: "pipeline", jobId: "job", jobStatus: "failed", reportHash: digest(readFileSync(summaryFile)), reportUrl: "https://quality.example.invalid/report", pipelineUrl: "https://quality.example.invalid/pipeline" };
  ingestGovernance({ ...f, eventFile: f.receipt(quality), summaryFile }); const before = f.state().issues;
  f.ingest(f.fact()); f.ingest(f.fact({ category: "deploy", environment: "uat", deploymentId: "deploy-1", authorizationId: "release-auth", status: "verified", actorId: "reviewer", verificationHash: hash, verificationUrl: "https://quality.example.invalid/verification" }));
  assert.deepEqual(f.state().issues, before); assert.equal(Object.values(f.state().issues)[0].status, "open");
});
test("网络未知不盲重发，运维签名重试与新事实覆盖保护沿用同一台账", async (t) => {
  const f = fixture(t); f.ingest(f.fact()); let calls = 0;
  const send = () => dispatchGovernance({ ...f, send: true, env: f.env, fetchImpl: async () => { calls++; throw new Error("unavailable"); } });
  await send(); await send(); assert.equal(calls, 1);
  const item = Object.values(f.state().outbox)[0];
  const actionFile = f.receipt({ schemaVersion: 1, kind: "issue-action", eventId: "retry-1", action: "retry-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "经消息端查询确无此消息" });
  actionGovernance({ ...f, actionFile }); assert.equal(Object.values(f.state().outbox)[0].status, "pending");
  f.ingest(f.fact({ sequence: 2, status: "failed" }));
  assert.throws(() => actionGovernance({ ...f, actionFile: f.receipt({ schemaVersion: 1, kind: "issue-action", eventId: "retry-2", action: "retry-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "旧重试" }) }), /可重试状态|替代/);
});
test("运行事实台账与快照篡改、未知map拒绝，不隐式清空", (t) => {
  const f = fixture(t); f.ingest(f.fact()); const original = readFileSync(f.stateFile, "utf8");
  for (const corrupt of [(s) => s.lifecycles = [], (s) => Object.values(s.lifecycles)[0].sha = "c".repeat(40), (s) => Object.values(s.outbox)[0].snapshot.reportUrl = "https://evil.invalid/r", (s) => Object.values(s.outbox)[0].streamId = hash]) {
    const state = JSON.parse(original); corrupt(state); writeFileSync(f.stateFile, JSON.stringify(state)); assert.throws(() => outboxGovernance(f));
  }
});
for (const outcome of ["accepted-by-provider", "not-received"]) test(`旧未知消息由运维核实${outcome}后归档，不永久卡住新版通知`, async (t) => {
  const f = fixture(t); f.ingest(f.fact());
  await dispatchGovernance({ ...f, send: true, env: f.env, fetchImpl: async () => { throw new Error("network lost after request"); } });
  const item = Object.values(f.state().outbox)[0]; f.ingest(f.fact({ sequence: 2, status: "failed" }));
  const action = { schemaVersion: 1, kind: "issue-action", eventId: "resolve-1", action: "resolve-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "按消息端记录完成独立核实", outcome, verificationUrl: "https://quality.example.invalid/channel-audit/1" };
  assert.throws(() => actionGovernance({ ...f, actionFile: f.receipt({ ...action, actorId: "reviewer" }) }), /运维授权/);
  actionGovernance({ ...f, actionFile: f.receipt(action) });
  const resolved = f.state().outbox[item.id]; assert.equal(resolved.status, outcome === "accepted-by-provider" ? "delivered" : "superseded");
  assert.equal(outboxGovernance(f).unknownDeliveries.length, 0); assert.equal(outboxGovernance(f).messages.length, 1); assert.equal(Object.values(f.state().lifecycles)[0].status, "failed");
});
test("当前消息核实未收到才回到待发，活跃租约与过期attempt不能裁决", async (t) => {
  const f = fixture(t); f.ingest(f.fact());
  await dispatchGovernance({ ...f, send: true, env: f.env, fetchImpl: async () => { throw new Error("unknown"); } });
  const item = Object.values(f.state().outbox)[0], action = { schemaVersion: 1, kind: "issue-action", eventId: "resolve-1", action: "resolve-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "查询后确无消息", outcome: "not-received", verificationUrl: "https://quality.example.invalid/channel-audit/1" };
  assert.throws(() => actionGovernance({ ...f, actionFile: f.receipt({ ...action, expectedAttemptId: "wrong" }) }), /对象已过期/);
  const state = f.state(); state.outbox[item.id].completedAt = null; writeFileSync(f.stateFile, JSON.stringify(state));
  assert.throws(() => actionGovernance({ ...f, actionFile: f.receipt(action) }), /有效投递租约/);
  state.outbox[item.id].completedAt = new Date(now).toISOString(); writeFileSync(f.stateFile, JSON.stringify(state));
  actionGovernance({ ...f, actionFile: f.receipt(action) }); assert.equal(f.state().outbox[item.id].status, "pending"); assert.equal(outboxGovernance(f).unknownDeliveries.length, 0);
});
