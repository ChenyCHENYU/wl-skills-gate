import {fileURLToPath} from 'node:url';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync, symlinkSync, existsSync, linkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, createHash, createHmac } from "node:crypto";
import { signPlatformReceipt, ingestGovernance, ingestLifecycleGovernance, actionGovernance, reconcileGovernance, outboxGovernance, dispatchGovernance, migrateGovernanceConfig, governanceConfigIdentity, loadGovernanceConfig } from "../../lib/governance.js";
const digest = (x) => createHash("sha256").update(x).digest("hex");
const hash = "a".repeat(64), sha = "b".repeat(40), now = Date.parse("2026-10-13T00:00:00Z");
function fixture(t, type = "feishu") {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-governance-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(dir, "private.pem"), publicKeyFile = path.join(dir, "public.pem");
  writeFileSync(privateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  const config = { schemaVersion: 1, issuer: "central", publicKeyFile, allowedLinkOrigins: ["https://quality.example.invalid"], operators: ["operator"],
    projects: { demo: { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: "https://quality.example.invalid/issues",
      scopes: { full: { requiredChecks: ["CHECK"], policyHash: hash, rulesHash: hash, baselineHash: hash, waiversHash: hash, closurePolicy: { requiredEnvironments: ["sit"], deploymentLane: "release", requireDeployment: true } } } } },
    channels: { group: { type, webhookEnv: "GROUP_WEBHOOK", ...(type === "feishu" ? { signingSecretEnv: "GROUP_SECRET" } : {}) } },
    sla: { ackMinutes: 1, resolveMinutes: 2, escalationMinutes: 1 }, delivery: { maxAttempts: 2, retrySeconds: 1, timeoutMs: 1000 } };
  const configFile = path.join(dir, "config.json"), stateFile = path.join(dir, "ledger.json");
  writeFileSync(configFile, JSON.stringify(config));
  let count = 0;
  function receipt(payload, at = now) { const file = path.join(dir, `receipt-${count++}.json`); writeFileSync(file, JSON.stringify(signPlatformReceipt(payload, { privateKeyFile, issuer: "central", createdAt: new Date(at).toISOString() }))); return file; }
  function ingest({ status = "blocked", findings = [{ fingerprint: digest("finding"), ruleId: "R", severity: "error", file: "src/Main.java", line: 1, status: "new" }], sequence = 1, eventId = `run-${sequence}`, at = now, mutate } = {}) {
    const report = { schemaVersion: 1, run: { project: "demo", profile: "standard", startedAt: new Date(at).toISOString(), durationMs: 10, commitSha: sha, tool: "gate", eventId, sourceBound: true, sourceDigest: hash },
      policy: { policyHash: hash, ruleSetHash: hash, baselineHash: hash, waiversHash: hash, requiredCheckIds: ["CHECK"], enforceWarnings: false, checksSelected: 1, lockedToolVersions: { CHECK: "fixture@1" } },
      checks: [{ checkId: "CHECK", required: true, status: "ok", toolVersionVerified: true, toolVersion: "fixture@1" }], findings, counts: { blockingNew: status === "passed" ? 0 : findings.filter((f) => f.severity === "error").length }, decision: { status, reasons: [] } };
    mutate?.(report); const summaryFile = path.join(dir, `summary-${count++}.json`); writeFileSync(summaryFile, JSON.stringify(report));
    const payload = { schemaVersion: 1, kind: "quality-event", eventId, project: "demo", scope: "full", sha, authorId: "author", sequence, pipelineId: `pipeline-${sequence}`, jobId: "job", jobStatus: status === "passed" ? "success" : "failed", reportHash: digest(readFileSync(summaryFile)), reportUrl: "https://quality.example.invalid/report", pipelineUrl: "https://quality.example.invalid/pipeline" };
    return { ...ingestGovernance({ configFile, stateFile, eventFile: receipt(payload, at), summaryFile, now: at }), payload, summaryFile };
  }
  const base = { configFile, stateFile };
  const state = () => JSON.parse(readFileSync(stateFile));
  const issue = () => Object.values(state().issues)[0];
  const action = (payload, at = now) => actionGovernance({ ...base, actionFile: receipt({ schemaVersion: 1, kind: "issue-action", eventId: `action-${count++}`, ...payload }, at), now: at });
  const reconcile = (expectedRuns = [], at = now) => reconcileGovernance({ ...base, expectationsFile: receipt({ schemaVersion: 1, kind: "pipeline-expectations", eventId: `query-${count++}`, expectedRuns }, at), now: at });
  const env = { GROUP_WEBHOOK: type === "feishu" ? "https://open.feishu.cn/open-apis/bot/v2/hook/mock-key" : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=mock_key", GROUP_SECRET: "mock-secret" };
  const verified = (overrides = {}) => {
    const sourceFile = path.join(dir, `deployment-${count++}.json`); writeFileSync(sourceFile, JSON.stringify({ trustedExecutor: "isolated-test", status: "success" }));
    const event = { schemaVersion: 1, kind: "lifecycle-event", eventId: `verification-${count++}`, category: "deploy", project: "demo", scope: "full", lane: "release", environment: "sit", status: "verified", sha, sequence: 1, authorId: "author", actorId: "reviewer", deploymentId: "deployment-1", authorizationId: "authorization-1", artifactHash: hash, manifestHash: hash, releaseSetHash: hash, executionHash: hash, verificationHash: hash, verificationUrl: "https://quality.example.invalid/verification", pipelineId: "release-pipeline", jobId: "smoke", reportUrl: "https://quality.example.invalid/report", pipelineUrl: "https://quality.example.invalid/pipeline", occurredAt: new Date(now).toISOString(), source: { system: "deployment", recordId: "smoke", recordHash: digest(readFileSync(sourceFile)), observedAt: new Date(now).toISOString(), url: "https://quality.example.invalid/executor" }, ...overrides };
    ingestLifecycleGovernance({ ...base, eventFile: receipt(event), sourceFile, now }); return event;
  };
  return { ...base, clock: () => 0, dir, config, receipt, ingest, state, issue, action, reconcile, env, verified };
}
test("经理本人提交同步人必须登记且不能误配为经理本人，通知配置不增加审批人", (t) => {
  const f = fixture(t), c = f.config, project = c.projects.demo;
  project.technicalManager = "manager"; project.managerSubmissionNotify = "observer";
  c.people = { manager: { name: "技术经理", roles: ["technical-manager"], feishu: { idType: "open_id", id: "ou_manager" } }, observer: { name: "李月", roles: ["quality-observer"], feishu: { idType: "open_id", id: "ou_observer" } } };
  const save = () => writeFileSync(f.configFile, JSON.stringify(c));
  save(); assert.deepEqual(loadGovernanceConfig(f.configFile).projects.demo.reviewers, ["reviewer"]);
  project.managerSubmissionNotify = "missing"; save(); assert.throws(() => loadGovernanceConfig(f.configFile), /须登记实名/);
  project.managerSubmissionNotify = "manager"; save(); assert.throws(() => loadGovernanceConfig(f.configFile), /同一飞书人员/);
  project.managerSubmissionNotify = "observer"; c.people.observer.feishu.id = "ou_manager"; save(); assert.throws(() => loadGovernanceConfig(f.configFile), /同一飞书人员/);
});
test("正式摄入按event去重，拒绝同编号冲突；旧轮次不回写当前状态", (t) => {
  const f = fixture(t), run = f.ingest({ sequence: 2 });
  assert.equal(ingestGovernance({ ...f, eventFile: f.receipt(run.payload), summaryFile: run.summaryFile, now }).status, "duplicate");
  assert.throws(() => ingestGovernance({ ...f, eventFile: f.receipt({ ...run.payload, sequence: 3 }), summaryFile: run.summaryFile, now }), /内容冲突/);
  assert.equal(f.ingest({ sequence: 1, status: "passed", findings: [] }).status, "stale"); assert.equal(f.issue().status, "open");
});
test("篡改receipt或报告字节、过期receipt均拒绝", (t) => {
  const f = fixture(t), r = f.ingest();
  const file = f.receipt({ ...r.payload, authorId: "forged" }); const signed = JSON.parse(readFileSync(file)); signed.payload.authorId = "owner"; writeFileSync(file, JSON.stringify(signed));
  assert.throws(() => ingestGovernance({ ...f, eventFile: file, summaryFile: r.summaryFile, now }), /签名无效/);
  writeFileSync(r.summaryFile, readFileSync(r.summaryFile, "utf8") + " ");
  assert.throws(() => ingestGovernance({ ...f, eventFile: f.receipt(r.payload), summaryFile: r.summaryFile, now }), /摘要不一致/);
  assert.throws(() => ingestGovernance({ ...f, eventFile: f.receipt(r.payload, now - 86400001), summaryFile: r.summaryFile, now }), /过期/);
});
for (const [label, mutate] of [["必需检查缺失", (r) => r.checks.pop()], ["未绑定源码", (r) => r.run.sourceBound = false], ["版本未验", (r) => r.checks[0].toolVersionVerified = false], ["错误规则摘要", (r) => r.policy.ruleSetHash = "c".repeat(64)], ["局部扫描", (r) => r.run.scope = "changed"], ["passed隐藏错误", (r) => r.decision.status = "passed"]]) test(`台账拒收${label}`, (t) => { const f = fixture(t); assert.throws(() => f.ingest({ mutate })); });
test("主备认领、修复待复验、独立认证复核关闭；旧卡片和错误SHA拒绝", (t) => {
  const f = fixture(t); f.ingest(); const open = f.issue();
  assert.throws(() => f.action({ action: "claim", actorId: "reviewer", issueId: open.id, expectedRevision: open.revision }), /只有主备/);
  f.action({ action: "claim", actorId: "owner", issueId: open.id, expectedRevision: open.revision });
  assert.throws(() => f.action({ action: "claim", actorId: "backup", issueId: open.id, expectedRevision: open.revision }), /旧动作/);
  f.ingest({ sequence: 2, status: "passed", findings: [] }); const pending = f.issue(); assert.equal(pending.status, "awaitingVerification");
  const close = { action: "close", actorId: "reviewer", issueId: pending.id, expectedRevision: pending.revision, sha, reportHash: pending.pendingEvidence.reportHash, environment: "sit", result: "passed", reason: "实际复验通过", verificationUrl: "https://quality.example.invalid/verification" };
  assert.throws(() => f.action({ ...close, sha: "c".repeat(40) }), /当前修复/);
  assert.throws(() => f.action({ ...close, actorId: "owner" }), /独立非作者/);
  assert.throws(() => f.action(close), /逐必要环境/);
  const fact = f.verified(); f.action({ ...close, verificationEventIds: [fact.eventId] }); assert.equal(f.issue().status, "closed");
  f.ingest({ sequence: 3 }); assert.equal(f.issue().status, "open"); assert.equal(f.issue().recurrence, 1);
});
test("重复问题的新版证据递增revision，旧通知被替换、旧动作拒绝", (t) => {
  const f = fixture(t); f.ingest(); const first = f.issue(); f.ingest({ sequence: 2 });
  assert.equal(f.issue().revision, first.revision + 1);
  assert.equal(Object.values(f.state().outbox).filter((x) => x.status === "superseded").length, 1);
  const preview = outboxGovernance({ ...f, now }); assert.equal(preview.messages.length, 1); assert.equal(preview.messages[0].ids.length, 1);
  assert.throws(() => f.action({ action: "claim", actorId: "owner", issueId: first.id, expectedRevision: first.revision }), /旧动作/);
});
test("scope完整passed才待复验，invalid建立执行问题", (t) => {
  const f = fixture(t); f.ingest({ status: "invalid", findings: [], mutate: (r) => r.checks[0].status = "invalid" }); assert.equal(f.issue().ruleId, "GOV/CHECK-INVALID");
  f.ingest({ sequence: 2, status: "passed", findings: [] }); assert.equal(f.issue().status, "awaitingVerification");
});
test("漏跑对账和自然分钟SLA升级幂等，实际补跑后待复核", (t) => {
  const f = fixture(t); const e = { project: "demo", scope: "full", sha, sequence: 1, pipelineId: "pipeline-1", pipelineUrl: "https://quality.example.invalid/pipeline", dueAt: new Date(now - 1000).toISOString() };
  assert.equal(f.reconcile([e]).missing, 1); assert.equal(f.issue().ruleId, "GOV/NOT-RUN");
  assert.equal(f.reconcile([e], now + 120000).escalated, 2); assert.equal(f.reconcile([e], now + 120000).escalated, 0);
  f.ingest({ at: now + 120000 }); f.reconcile([e], now + 120000); assert.equal(Object.values(f.state().issues).find((x) => x.category === "missing").status, "awaitingVerification");
});
test("warning仅摘要；默认dispatch完全不联网；正文控制字符清理", async (t) => {
  const f = fixture(t); f.ingest({ status: "passed", findings: [{ fingerprint: digest("warning"), ruleId: "R\n@all", severity: "warning", file: "A\r\n伪造", status: "new" }] });
  assert.equal(outboxGovernance({ ...f, now }).messages.length, 0);
  let calls = 0; const result = await dispatchGovernance({ ...f, now, includeDigest: true, fetchImpl: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.messages.length, 1); assert.ok(!result.messages[0].text.includes("R\n@all"));
});
for (const type of ["feishu", "wecom"]) test(`${type}实际协议经模拟HTTP验签，provider接受才delivered`, async (t) => {
  const f = fixture(t, type); f.ingest();
  const result = await dispatchGovernance({ ...f, send: true, now, env: f.env, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); assert.equal(options.redirect, "error"); assert.equal(url, f.env.GROUP_WEBHOOK);
    if (type === "feishu") assert.equal(body.sign, createHmac("sha256", `${body.timestamp}\n${f.env.GROUP_SECRET}`).update("").digest("base64"));
    else assert.equal(body.msgtype, "text"); return { ok: true, json: async () => type === "feishu" ? { code: 0 } : { errcode: 0 } };
  } }); assert.equal(result.results[0].status, "delivered"); assert.equal(Object.values(f.state().outbox)[0].status, "delivered"); assert.ok(!JSON.stringify(f.state()).includes("mock-secret"));
});
test("服务失败/冲突返回码按预算重试至死信，后续无新消息仍显式失败", async (t) => {
  const f = fixture(t); f.ingest(); const fetchImpl = async () => ({ ok: true, json: async () => ({ code: 0, StatusCode: 1 }) });
  assert.equal((await dispatchGovernance({ ...f, now, send: true, env: f.env, fetchImpl })).results[0].status, "provider-rejected");
  const result = await dispatchGovernance({ ...f, now: now + 1000, send: true, env: f.env, fetchImpl }); assert.equal(result.deadLetters.length, 1);
  assert.equal((await dispatchGovernance({ ...f, now: now + 2000, send: true, env: f.env, fetchImpl })).deadLetters.length, 1);
});
test("网络结果未知不会盲目重复投递，运维核实后可按attempt恢复", async (t) => {
  const f = fixture(t); f.ingest(); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("secret request detail"); };
  const result = await dispatchGovernance({ ...f, send: true, now, env: f.env, fetchImpl }); assert.equal(result.unknownDeliveries.length, 1);
  await dispatchGovernance({ ...f, send: true, now, env: f.env, fetchImpl }); assert.equal(calls, 1);
  const item = Object.values(f.state().outbox)[0]; f.action({ action: "retry-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "已向消息平台核实未收到" });
  assert.equal(Object.values(f.state().outbox)[0].status, "pending"); assert.ok(!JSON.stringify(f.state()).includes("secret request detail"));
});
test("活跃投递租约内拒绝人工重试，第二dispatcher也不重复发送", async (t) => {
  const f = fixture(t); f.ingest(); let release, started; const entered = new Promise((r) => started = r), wait = new Promise((r) => release = r);
  const sending = dispatchGovernance({ ...f, send: true, now, env: f.env, fetchImpl: async () => { started(); await wait; return { ok: true, json: async () => ({ code: 0 }) }; } });
  await entered; const item = Object.values(f.state().outbox)[0];
  assert.throws(() => f.action({ action: "retry-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "重复点击" }), /有效投递租约/);
  const second = await dispatchGovernance({ ...f, send: true, now, env: f.env, fetchImpl: async () => { assert.fail("duplicate fetch"); } }); assert.equal(second.unknownDeliveries.length, 1);
  release(); await sending;
});
test("台账配置/授权/渠道公钥固定，损坏和遗留写入锁均不重置", (t) => {
  const f = fixture(t); f.ingest(); const original = readFileSync(f.configFile, "utf8"); f.config.projects.demo.owner = "other"; writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.throws(() => outboxGovernance({ ...f, now }), /身份不一致/); writeFileSync(f.configFile, original);
  mkdirSync(f.stateFile + ".lock"); assert.throws(() => f.reconcile(), /写入锁/); rmSync(f.stateFile + ".lock", { recursive: true });
  writeFileSync(f.stateFile, "{broken"); assert.throws(() => f.reconcile()); assert.equal(readFileSync(f.stateFile, "utf8"), "{broken");
});
test("不允许webhook重定向/非官方地址或报告凭据链接", async (t) => {
  const f = fixture(t); f.ingest(); const delivery = await dispatchGovernance({ ...f, send: true, now, env: { ...f.env, GROUP_WEBHOOK: "https://evil.invalid/hook" }, fetchImpl: async () => { assert.fail("must not send"); } });
  assert.equal(delivery.networkExecuted, false); assert.equal(delivery.results[0].status, "configuration-error");
  const r = f.ingest({ sequence: 2 }); assert.throws(() => ingestGovernance({ ...f, eventFile: f.receipt({ ...r.payload, reportUrl: "https://quality.example.invalid/report?token=secret" }), summaryFile: r.summaryFile, now }), /凭据不合法/);
});
test("passed缺少JUnit原始证据独立验收拒绝，漂移/failFast invalid仅建立执行异常", (t) => {
  const f = fixture(t);
  assert.throws(() => f.ingest({ status: "passed", findings: [], mutate: (r) => r.checks[0].tool = "junit" }), /原始测试报告证据/);
  f.ingest({ status: "invalid", findings: [], mutate: (r) => { r.run.project = "unknown"; r.run.commitSha = null; r.checks = [{ checkId: "SOURCE-DRIFT", status: "invalid" }]; delete r.policy; } });
  assert.equal(f.issue().category, "execution"); assert.equal(f.issue().status, "open");
});
test("损坏台账深字段拒绝，不靠NaN或缺省值继续", (t) => {
  const f = fixture(t); f.ingest(); const original = readFileSync(f.stateFile, "utf8");
  for (const change of [(s) => Object.values(s.issues)[0].revision = 0, (s) => Object.values(s.issues)[0].severity = "green", (s) => Object.values(s.outbox)[0].attempts = -1, (s) => Object.values(s.outbox)[0].nextAttemptAt = "broken", (s) => Object.values(s.events)[0].digest = "bad"] ) {
    const s = JSON.parse(original); change(s); writeFileSync(f.stateFile, JSON.stringify(s)); assert.throws(() => outboxGovernance({ ...f, now }));
  }
});
test("CLI预览已有未知投递返回2；输出symlink/断链不能覆盖输入或创建外部文件", async (t) => {
  const f = fixture(t); f.ingest(); await dispatchGovernance({ ...f, send: true, now, env: f.env, fetchImpl: async () => { throw new Error("unknown"); } });
  const cli = fileURLToPath(new URL("../../bin/wl-skills-gate.js", import.meta.url));
  const args = [cli, "governance", "outbox", "--config", f.configFile, "--state", f.stateFile];
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 2);
  const original = readFileSync(f.configFile, "utf8"), alias = path.join(f.dir, "alias.json"); symlinkSync(f.configFile, alias);
  assert.equal(spawnSync(process.execPath, [...args, "--out", alias], { encoding: "utf8" }).status, 2); assert.equal(readFileSync(f.configFile, "utf8"), original);
  const absent = path.join(f.dir, "absent.json"), dangling = path.join(f.dir, "dangling.json"); symlinkSync(absent, dangling);
  assert.equal(spawnSync(process.execPath, [...args, "--out", dangling], { encoding: "utf8" }).status, 2); assert.equal(existsSync(absent), false);
});
test("取投递锁前问题revision变化时不发送已过期快照", async (t) => {
  const f = fixture(t); f.ingest(); const issue = f.issue(); let changed = false, calls = 0;
  const env = { GROUP_SECRET: f.env.GROUP_SECRET, get GROUP_WEBHOOK() { if (!changed) { changed = true; f.action({ action: "claim", actorId: "owner", issueId: issue.id, expectedRevision: issue.revision }); } return f.env.GROUP_WEBHOOK; } };
  await dispatchGovernance({ ...f, send: true, now, env, fetchImpl: async () => { calls++; assert.fail("stale message"); } }); assert.equal(calls, 0);
  assert.equal(outboxGovernance({ ...f, now }).messages.length, 1);
});
test("顺序投递的每个组使用新时间/有效租约，后组不能被并发重试", async (t) => {
  const f = fixture(t); f.ingest({ findings: [1,2].map((n) => ({ fingerprint: digest(`f-${n}`), ruleId: `R-${n}`, severity: "error", file: "src/Main.java", status: "new" })) });
  let elapsed = 0, calls = 0;
  await dispatchGovernance({ ...f, send: true, now, clock: () => elapsed, env: f.env, fetchImpl: async (url, options) => {
    calls++; if (calls === 1) elapsed = 90000;
    else { const item = Object.values(f.state().outbox).find((x) => x.status === "attempting"); assert.equal(Date.parse(item.attemptedAt), now + 90000); assert.equal(JSON.parse(options.body).timestamp, String(Math.floor((now + 90000) / 1000)));
      assert.throws(() => f.action({ action: "retry-delivery", actorId: "operator", messageId: item.id, expectedAttemptId: item.attemptId, reason: "仍在发送" }, now + elapsed), /有效投递租约/); }
    return { ok: true, json: async () => ({ code: 0 }) };
  } }); assert.equal(calls, 2);
});
test("Object原型同名合法eventId正常去重，不产生伪冲突", (t) => { const f = fixture(t); assert.equal(f.ingest({ eventId: "toString" }).status, "ingested"); assert.equal(f.ingest({ eventId: "toString" }).status, "duplicate"); });
test("CLI不覆盖配置公钥/硬链接，坏快照复验证据链接拒绝", (t) => {
  const f = fixture(t); f.ingest(); f.ingest({ sequence: 2, status: "passed", findings: [] });
  const publicFile = f.config.publicKeyFile, before = readFileSync(publicFile, "utf8"), ledger = readFileSync(f.stateFile, "utf8");
  const alias = path.join(f.dir, "public-alias.pem"); linkSync(publicFile, alias);
  const cli = fileURLToPath(new URL("../../bin/wl-skills-gate.js", import.meta.url));
  for (const out of [publicFile, alias]) assert.equal(spawnSync(process.execPath, [cli, "governance", "outbox", "--config", f.configFile, "--state", f.stateFile, "--out", out], { encoding: "utf8" }).status, 2);
  assert.equal(readFileSync(publicFile, "utf8"), before); assert.equal(readFileSync(f.stateFile, "utf8"), ledger);
  const s = f.state(); const item = Object.values(s.outbox).find((x) => x.snapshot.pendingEvidence); item.snapshot.pendingEvidence.reportUrl = "https://evil.invalid/?token=secret"; writeFileSync(f.stateFile, JSON.stringify(s)); assert.throws(() => outboxGovernance({ ...f, now }), /凭据不合法/);
});

test("必要环境的旧验证不能覆盖同通道新失败，其他环境与候选均不能替代", (t) => {
  const f = fixture(t); f.ingest(); f.ingest({ sequence: 2, status: "passed", findings: [] });
  const issue = f.issue(), fact = f.verified();
  const close = { action: "close", actorId: "reviewer", issueId: issue.id, expectedRevision: issue.revision, sha, reportHash: issue.pendingEvidence.reportHash, environment: "sit", result: "passed", reason: "业务复验", verificationUrl: "https://quality.example.invalid/verification", verificationEventIds: [fact.eventId] };
  f.verified({ sequence: 2, eventId: "deployment-failed", status: "failed" });
  assert.throws(() => f.action(close), /最新有效部署验证/); assert.equal(f.issue().status, "awaitingVerification");
  const wrong = f.verified({ sequence: 3, eventId: "wrong-sha", sha: "c".repeat(40) });
  assert.throws(() => f.action({ ...close, verificationEventIds: [wrong.eventId] }), /当前候选/);
  const valid = f.verified({ sequence: 4, eventId: "valid-current" });
  f.action({ ...close, verificationEventIds: [valid.eventId] }); assert.equal(f.issue().closeEvidence.verified[0].deploymentId, valid.deploymentId);
});

test("旧配置缺必要环境仍可读账，但不能关闭；精确授权迁移后才能继续", (t) => {
  const f = fixture(t); delete f.config.projects.demo.scopes.full.closurePolicy; writeFileSync(f.configFile, JSON.stringify(f.config));
  f.ingest(); f.ingest({ sequence: 2, status: "passed", findings: [] });
  const issue = f.issue(), close = { action: "close", actorId: "reviewer", issueId: issue.id, expectedRevision: issue.revision, sha, reportHash: issue.pendingEvidence.reportHash, environment: "sit", result: "passed", reason: "复验", verificationUrl: "https://quality.example.invalid/verification", verificationEventIds: [] };
  assert.throws(() => f.action(close), /未批准必要环境/);
  const newConfigFile = path.join(f.dir, "new-config.json"), next = structuredClone(f.config);
  next.projects.demo.scopes.full.closurePolicy = { requiredEnvironments: ["sit", "uat"], deploymentLane: "release", requireDeployment: true }; writeFileSync(newConfigFile, JSON.stringify(next));
  const authorization = { schemaVersion: 1, kind: "governance-migration", eventId: "migration-1", actorId: "operator", reason: "补齐必要部署验证环境", expectedRevision: f.state().revision, oldConfigHash: governanceConfigIdentity(f), newConfigHash: governanceConfigIdentity({ configFile: newConfigFile }) };
  assert.throws(() => migrateGovernanceConfig({ ...f, newConfigFile, authorizationFile: f.receipt({ ...authorization, actorId: "reviewer" }), now }), /运维/);
  const migrated = migrateGovernanceConfig({ ...f, newConfigFile, authorizationFile: f.receipt(authorization), now }); assert.equal(migrated.status, "migrated");
  assert.throws(() => outboxGovernance(f), /身份不一致/); assert.equal(outboxGovernance({ ...f, configFile: newConfigFile }).messages.length, 1);
});

test("一个渠道配置失效只记该组可恢复失败，不阻断另一群；长中文消息保留完整处理链接", async (t) => {
  const f = fixture(t, "wecom");
  f.config.channels.second = { type: "wecom", webhookEnv: "SECOND_WEBHOOK" };
  f.config.projects.second = { ...structuredClone(f.config.projects.demo), channel: "second" }; writeFileSync(f.configFile, JSON.stringify(f.config));
  f.ingest({ findings: [{ fingerprint: digest("long"), ruleId: "很长的规则".repeat(100), file: "很长的中文路径".repeat(100), severity: "error", status: "new" }] });
  const first = f.issue(), state = f.state(), copy = structuredClone(first); copy.project = "second"; copy.id = digest(`second:full:${copy.fingerprint}`); state.issues[copy.id] = copy;
  const oldMessage = Object.values(state.outbox)[0], item = { ...structuredClone(oldMessage), issueId: copy.id, channel: "second", snapshot: copy }; item.id = digest(`${copy.id}:${copy.revision}:${item.kind}`); state.outbox[item.id] = item; writeFileSync(f.stateFile, JSON.stringify(state));
  const preview = outboxGovernance({ ...f, now }); assert.ok(preview.messages.every((m) => Buffer.byteLength(m.text, "utf8") <= 1800)); assert.ok(preview.messages.every((m) => m.text.includes(f.config.projects.demo.issueBaseUrl)));
  let calls = 0; const result = await dispatchGovernance({ ...f, send: true, now, env: { SECOND_WEBHOOK: f.env.GROUP_WEBHOOK }, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ errcode: 0 }) }; } });
  assert.equal(calls, 1); assert.deepEqual(result.results.map((r) => r.status), ["configuration-error", "delivered"]); assert.equal(result.unknownDeliveries.length, 0);
});

test("超过100条的警告摘要分组保留所有消息，不把尾部永久漏发", (t) => {
  const f = fixture(t); f.ingest({ status: "passed", findings: Array.from({ length: 105 }, (_, n) => ({ fingerprint: digest(`warn-${n}`), ruleId: `WARN-${n}`, file: "src/Main.java", severity: "warning", status: "new" })) });
  const messages = outboxGovernance({ ...f, includeDigest: true, now }).messages;
  assert.equal(messages.length, 2); assert.equal(new Set(messages.flatMap((m) => m.ids)).size, 105);
});

test("同流水线取消后补跑更高generation消除漏跑，其他pipeline成功不能替代", (t) => {
  const f = fixture(t), expected = { project: "demo", scope: "full", sha, sequence: 1, pipelineId: "pipeline-1", pipelineUrl: "https://quality.example.invalid/pipeline", dueAt: new Date(now - 1).toISOString() };
  f.reconcile([expected]); assert.equal(f.issue().status, "open");
  const run = f.ingest({ sequence: 2, status: "passed", findings: [] });
  f.reconcile([expected]); assert.equal(f.issue().status, "open");
  const event = { ...run.payload, eventId: "same-run-retried", reportEventId: run.payload.eventId, pipelineId: "pipeline-1", sequence: 3 };
  ingestGovernance({ ...f, eventFile: f.receipt(event), summaryFile: run.summaryFile, now });
  f.reconcile([expected]); assert.equal(f.issue().status, "awaitingVerification"); assert.equal(f.issue().pendingEvidence.reportHash, run.payload.reportHash);
  assert.equal(f.state().events[event.eventId].reportEventId, run.payload.eventId);
  assert.throws(() => ingestGovernance({ ...f, eventFile: f.receipt({ ...event, eventId: "wrong-report", sequence: 4, reportEventId: "other-report" }), summaryFile: run.summaryFile, now }), /runId/);
});
