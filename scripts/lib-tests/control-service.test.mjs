import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { loadControlConfig, createControlHandler } from "../../lib/control-service.js";
import { verifyIdentityToken, validateIdentityConfig } from "../../lib/identity.js";
import { signPlatformReceipt, ingestGovernance, ingestLifecycleGovernance, readGovernanceState } from "../../lib/governance.js";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const sha = "b".repeat(40), pin = "a".repeat(64), now = Date.parse("2026-10-15T00:00:00Z"), origin = "https://quality.example.invalid";
const json = (file, data) => writeFileSync(file, JSON.stringify(data));
function fixture(t) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-control-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = {};
  for (const name of ["receipt", "authorization", "identity"]) { const pair = generateKeyPairSync("ed25519"); keys[name] = pair; for (const [type, key] of [["private", pair.privateKey], ["public", pair.publicKey]]) writeFileSync(path.join(dir, `${name}-${type}.pem`), key.export({ type: type === "private" ? "pkcs8" : "spki", format: "pem" })); }
  const governanceConfigFile = path.join(dir, "governance.json"), stateFile = path.join(dir, "ledger.json"), configFile = path.join(dir, "control.json");
  const g = { schemaVersion: 1, issuer: "central", publicKeyFile: path.join(dir, "receipt-public.pem"), allowedLinkOrigins: [origin], operators: ["operator"], projects: { demo: { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: origin + "/issues", scopes: { full: { requiredChecks: ["CHECK"], policyHash: pin, rulesHash: pin, baselineHash: pin, waiversHash: pin, closurePolicy: { requiredEnvironments: ["sit"], deploymentLane: "release", requireDeployment: true } } } } }, channels: { group: { type: "feishu", webhookEnv: "GROUP_WEBHOOK", signingSecretEnv: "GROUP_SECRET" } } };
  json(governanceConfigFile, g);
  const c = { schemaVersion: 1, origin, governanceConfigFile, stateFile, dataDir: path.join(dir, "control"), receiptPrivateKeyFile: path.join(dir, "receipt-private.pem"), authorizationPrivateKeyFile: path.join(dir, "authorization-private.pem"), authorizationIssuer: "identity-authority", reviewPolicies: {}, identity: { algorithm: "EdDSA", keyId: "id-key", publicKeyFile: path.join(dir, "identity-public.pem"), issuer: "https://identity.example.invalid", authorizationEndpoint: "https://identity.example.invalid/authorize", tokenEndpoint: "https://identity.example.invalid/token", clientId: "quality", subjects: { "user-owner": "owner", "user-reviewer": "reviewer", "user-operator": "operator" } } };
  json(configFile, c); let nonce, challenge, sub = "user-owner", ticks = 0;
  const jwt = (payload = {}, header = {}) => {
    const parts = [Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "id-key", ...header })).toString("base64url"), Buffer.from(JSON.stringify({ iss: c.identity.issuer, aud: "quality", sub, iat: now / 1000, exp: now / 1000 + 3600, nonce, ...payload })).toString("base64url")];
    return parts.join(".") + "." + sign(null, Buffer.from(parts.join(".")), keys.identity.privateKey).toString("base64url");
  };
  const handler = createControlHandler({ configFile, clock: () => now, fetchImpl: async (url, init) => {
    assert.equal(url, c.identity.tokenEndpoint); assert.equal(init.redirect, "error"); const form = new URLSearchParams(init.body);
    assert.equal(form.get("code"), "valid-code"); assert.equal(hash(form.get("code_verifier")), Buffer.from(challenge, "base64url").toString("hex"));
    assert.equal(form.get("redirect_uri"), origin + "/auth/callback"); return new Response(JSON.stringify({ id_token: jwt() }));
  } });
  const start = async () => {};
  const http = ({ url = "/issues", method = "GET", cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []); req.url = url; req.method = method;
    req.headers = Object.fromEntries(Object.entries({ Host: new URL(origin).host, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } : {}), ...headers }).map(([k,v]) => [k.toLowerCase(), v]));
    const response = { writeHead(status, headers) { this.status = status; this.headers = Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(), k.toLowerCase() === "set-cookie" && !Array.isArray(v) ? [v] : v])); }, end(text) { resolve({ status: this.status, headers: this.headers, text }); } };
    handler(req, response).catch(reject);
  });
  const login = async (actor = "owner", returnTo = "/issues") => {
    sub = `user-${actor}`; const response = await http({ url: `/auth/login?return=${encodeURIComponent(returnTo)}` }), u = new URL(response.headers.location);
    nonce = u.searchParams.get("nonce"); challenge = u.searchParams.get("code_challenge"); const cookie = response.headers["set-cookie"][0].split(";")[0];
    assert.match(response.headers["set-cookie"][0], /HttpOnly; Secure; SameSite=Lax/);
    const callback = `/auth/callback?code=valid-code&state=${u.searchParams.get("state")}`;
    const accepted = await http({ url: callback, cookie }); assert.equal(accepted.status, 302, accepted.text);
    return { cookie: accepted.headers["set-cookie"][0].split(";")[0], callback, loginCookie: cookie };
  };
  const receipt = (payload) => { const file = path.join(dir, `receipt-${ticks++}.json`); json(file, signPlatformReceipt(payload, { privateKeyFile: c.receiptPrivateKeyFile, issuer: "central", createdAt: new Date(now).toISOString() })); return file; };
  const ingest = (passed = false, sequence = 1) => {
    const report = { schemaVersion: 1, run: { project: "demo", profile: "standard", startedAt: new Date(now).toISOString(), durationMs: 1, commitSha: sha, tool: "gate", eventId: `run-${sequence}`, sourceBound: true, sourceDigest: pin }, policy: { policyHash: pin, ruleSetHash: pin, baselineHash: pin, waiversHash: pin, requiredCheckIds: ["CHECK"], checksSelected: 1, lockedToolVersions: { CHECK: "fixture@1" } }, checks: [{ checkId: "CHECK", required: true, status: "ok", toolVersionVerified: true, toolVersion: "fixture@1" }], findings: passed ? [] : [{ fingerprint: pin, ruleId: "R", severity: "error", file: "src/A.java", line: 1, status: "new" }], counts: { blockingNew: passed ? 0 : 1 }, decision: { status: passed ? "passed" : "blocked", reasons: [] } };
    const summaryFile = path.join(dir, `summary-${sequence}.json`); json(summaryFile, report);
    const event = { schemaVersion: 1, kind: "quality-event", eventId: `run-${sequence}`, project: "demo", scope: "full", sha, sequence, authorId: "owner", pipelineId: "pipeline-1", jobId: "quality", jobStatus: passed ? "success" : "failed", reportHash: hash(readFileSync(summaryFile)), reportUrl: origin + "/report", pipelineUrl: origin + "/pipeline" };
    return ingestGovernance({ configFile: governanceConfigFile, stateFile, eventFile: receipt(event), summaryFile, now });
  };
  return { dir, c, configFile, keys, jwt, start, http, login, ingest, receipt, state: () => readGovernanceState({ configFile: governanceConfigFile, stateFile }), mutateConfig: () => json(configFile, c) };
}
test("HTTP登录处理链绑定浏览器/state/PKCE/nonce，回调只能使用一次，不信任身份请求头", async (t) => {
  const f = fixture(t); await f.start(); f.ingest();
  assert.equal((await f.http({ headers: { "X-Actor-Id": "owner", Authorization: "Bearer forged" } })).status, 302);
  const session = await f.login(); assert.equal((await f.http({ cookie: session.cookie })).status, 200);
  assert.equal((await f.http({ url: session.callback, cookie: session.loginCookie })).status, 400);
  assert.equal((await f.http({ url: "/auth/login?return=https%3A%2F%2Fevil.invalid" })).status, 400);
  assert.equal((await f.http({ cookie: session.cookie, headers: { Host: "evil.invalid" } })).status, 400);
  assert.ok(!JSON.stringify(f.state()).includes("valid-code"));
});
for (const [label, payload, header] of [["过期", { exp: now / 1000 }, {}], ["错误issuer", { iss: "https://evil.invalid" }, {}], ["错误受众", { aud: "other" }, {}], ["未知sub", { sub: "attacker" }, {}], ["未来iat", { iat: now / 1000 + 120 }, {}], ["算法降级", {}, { alg: "none" }], ["换密钥URL", {}, { jku: "https://evil.invalid" }]]) test(`身份令牌拒绝${label}`, (t) => { const f = fixture(t); assert.throws(() => verifyIdentityToken(f.jwt(payload, header), validateIdentityConfig(f.c.identity), { now })); });
test("三种身份/事件/授权密钥逐对隔离", (t) => {
  const f = fixture(t); f.c.identity.publicKeyFile = path.join(f.dir, "receipt-public.pem"); f.mutateConfig(); assert.throws(() => loadControlConfig(f.configFile), /必须分离/);
  f.c.identity.publicKeyFile = path.join(f.dir, "identity-public.pem"); f.c.authorizationPrivateKeyFile = f.c.receiptPrivateKeyFile; f.mutateConfig(); assert.throws(() => loadControlConfig(f.configFile), /必须分离/);
});
test("认证认领保护CSRF/旧revision/自报actor；实际复扫后按同SHA环境事实独立关闭", async (t) => {
  const f = fixture(t); await f.start(); f.ingest(); let issue = Object.values(f.state().issues)[0];
  const owner = await f.login(), detail = await f.http({ url: `/issues/${issue.id}`, cookie: owner.cookie }), csrf = detail.text.match(/name="csrf" value="([^"]+)"/)[1];
  const action = (values, session = owner, headers = {}) => f.http({ url: `/issues/${issue.id}`, method: "POST", cookie: session.cookie, body: new URLSearchParams(values).toString(), headers });
  assert.equal((await action({ action: "claim", revision: issue.revision, csrf: "forged" })).status, 400);
  assert.equal((await action({ action: "claim", revision: issue.revision, csrf, actorId: "owner" })).status, 400);
  assert.equal((await action({ action: "claim", revision: issue.revision, csrf }, owner, { Origin: "https://evil.invalid" })).status, 400);
  assert.equal((await action({ action: "claim", revision: issue.revision, csrf })).status, 303);
  assert.equal((await action({ action: "claim", revision: issue.revision, csrf })).status, 400);
  assert.equal(Object.values(f.state().issues)[0].assignee, "owner"); f.ingest(true, 2); issue = Object.values(f.state().issues)[0];
  const reviewer = await f.login("reviewer"), closePage = await f.http({ url: `/issues/${issue.id}`, cookie: reviewer.cookie }), reviewerCsrf = closePage.text.match(/name="csrf" value="([^"]+)"/)[1];
  const close = { action: "close", revision: issue.revision, csrf: reviewerCsrf, sha, reportHash: issue.pendingEvidence.reportHash, reason: "实际验证完成", verificationUrl: origin + "/verification", verification_sit: "actual-smoke" };
  assert.equal((await action(close, reviewer)).status, 400);
  const sourceFile = path.join(f.dir, "smoke.json"); json(sourceFile, { kind: "isolated-real-fact-test", result: "passed" });
  const event = { schemaVersion: 1, kind: "lifecycle-event", eventId: "actual-smoke", category: "deploy", project: "demo", scope: "full", lane: "release", environment: "sit", status: "verified", sha, sequence: 1, authorId: "owner", actorId: "reviewer", deploymentId: "actual-deploy", authorizationId: "deployment-authorization", artifactHash: pin, manifestHash: pin, releaseSetHash: pin, executionHash: pin, verificationHash: pin, verificationUrl: origin + "/verification", pipelineId: "deploy-1", jobId: "smoke", reportUrl: origin + "/report", pipelineUrl: origin + "/pipeline", occurredAt: new Date(now).toISOString(), source: { system: "deployment", recordId: "smoke", recordHash: hash(readFileSync(sourceFile)), observedAt: new Date(now).toISOString(), url: origin + "/executor" } };
  ingestLifecycleGovernance({ configFile: f.c.governanceConfigFile, stateFile: f.c.stateFile, eventFile: f.receipt(event), sourceFile, now });
  assert.equal((await action(close, reviewer)).status, 303); assert.equal(Object.values(f.state().issues)[0].status, "closed");
  assert.ok(readdirSync(path.join(f.c.dataDir, "actions")).length >= 3); assert.equal(readdirSync(path.join(f.c.dataDir, "authorizations")).length, 0);
});
test("认证入口显示中央采集异常原件身份，关闭选择器只展示本轮修复后的环境验证", async (t) => {
  const f = fixture(t); f.ingest(); f.ingest(true, 2);
  const sourceFile = path.join(f.dir, "collector-health.json"); json(sourceFile, { kind: "automation-source-health", errorStages: ["source"], status: "attention" });
  const health = { schemaVersion: 1, kind: "lifecycle-event", eventId: "health-1", category: "collection", status: "attention", project: "demo", scope: "full", lane: "demo-full", sourceId: "demo-full", executionId: "tick-health-1", sequence: 1, errorCount: 1, errorStages: ["source"], firstFailureAt: new Date(now).toISOString(), occurredAt: new Date(now).toISOString(), reportUrl: origin + "/issues", source: { system: "gitlab", recordId: "tick-health-1", recordHash: hash(readFileSync(sourceFile)), observedAt: new Date(now).toISOString(), url: origin } };
  ingestLifecycleGovernance({ configFile: f.c.governanceConfigFile, stateFile: f.c.stateFile, eventFile: f.receipt(health), sourceFile, now });
  const reviewer = await f.login("reviewer"), index = await f.http({ cookie: reviewer.cookie }); assert.match(index.text, /采集执行异常/); assert.match(index.text, /tick-health-1/); assert.match(index.text, /恢复不代表项目质量通过/);
  const smoke = path.join(f.dir, "smoke-current-repair.json"); json(smoke, { result: "passed" });
  const event = { schemaVersion: 1, kind: "lifecycle-event", eventId: "old-verification", category: "deploy", project: "demo", scope: "full", lane: "release", environment: "sit", status: "verified", sha, sequence: 1, authorId: "owner", actorId: "reviewer", deploymentId: "old-deploy", authorizationId: "deployment-authorization", artifactHash: pin, manifestHash: pin, releaseSetHash: pin, executionHash: pin, verificationHash: pin, verificationUrl: origin + "/verification", pipelineId: "deploy-1", jobId: "smoke", reportUrl: origin + "/report", pipelineUrl: origin + "/pipeline", occurredAt: new Date(now - 1000).toISOString(), source: { system: "deployment", recordId: "smoke", recordHash: hash(readFileSync(smoke)), observedAt: new Date(now).toISOString(), url: origin + "/executor" } };
  const ingest = (fact) => ingestLifecycleGovernance({ configFile: f.c.governanceConfigFile, stateFile: f.c.stateFile, eventFile: f.receipt(fact), sourceFile: smoke, now });
  ingest(event); const issue = Object.values(f.state().issues)[0];
  const stale = await f.http({ url: `/issues/${issue.id}`, cookie: reviewer.cookie }); assert(!stale.text.includes('value="old-verification"'));
  ingest({ ...event, eventId: "current-verification", sequence: 2, occurredAt: new Date(now).toISOString() });
  const current = await f.http({ url: `/issues/${issue.id}`, cookie: reviewer.cookie }); assert(current.text.includes('value="current-verification"'));
});
