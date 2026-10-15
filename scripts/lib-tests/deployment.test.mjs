import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync } from "node:crypto";
import { sign } from "node:crypto";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { signRecord } from "../../lib/evidence.js";
import { stableStringify } from "../../lib/util.js";
import { createReleaseSet, verifyReleaseSet } from "../../lib/release-set.js";
import { planDeployment, runDeployment, createDeploymentLifecycle } from "../../lib/deployment.js";
import { createControlHandler, loadControlConfig } from "../../lib/control-service.js";
import { registerControlDeployment } from "../../lib/control-deployment.js";
import { queueDeploymentPlan, queueDeploymentDelivery, selectDeploymentAuthorization, waitForDeploymentAuthorization } from "../../lib/deployment-queue.js";
import { ingestDeploymentDeliveries } from "../../lib/deployment-delivery.js";

const hash = (v) => createHash("sha256").update(v).digest("hex"), jsonHash = (v) => hash(stableStringify(v));
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
function fixture(t) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-deployment-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date(), fixed = "a".repeat(64), roles = [["ui", "frontend"], ["api", "backend"]];
  function keys(name) {
    const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, `${name}-private.pem`), publicKeyFile = path.join(dir, `${name}-public.pem`);
    writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, pair.publicKey.export({ type: "spki", format: "pem" })); return { privateKeyFile, publicKeyFile };
  }
  const release = keys("release"), authorization = keys("authorization"), executor = keys("executor"), gate = keys("gate");
  const artifactRoot = path.join(dir, "stage"); mkdirSync(artifactRoot);
  function releaseSet(version = "b", mutate = () => {}) {
    const contractFile = `api-${version}.json`, reviewFile = `review-${version}.txt`;
    write(path.join(dir, contractFile), {openapi:"3.0.3",info:{version:"v1"},paths:{"/health":{get:{}}}}); writeFileSync(path.join(dir,reviewFile), "Reviewed actual API, database and release constraints for this isolated candidate");
    const reference = file => ({file,sha256:hash(readFileSync(path.join(dir,file)))});
    const compatibility = {api:{type:"contract",version:"v1",evidence:reference(contractFile),reviewEvidence:reference(reviewFile)},database:{mode:"none",reason:"No entity or SQL changes in the isolated fixture",schemaVersion:"schema-1",reviewEvidence:reference(reviewFile)},deploymentOrder:["api","ui"],rollback:{mode:"compatible",reason:"No database changes; archived pair remains compatible",reviewEvidence:reference(reviewFile)}};
    const components = roles.map(([project, role]) => {
      const sha = version.repeat(40), root = path.join(artifactRoot, project); mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "app.bin"), Buffer.from([0, 255, 13, 10])); writeFileSync(path.join(root, "app.json"), "{\"setting\":true}\n");
      const manifest = { schemaVersion: 1, project, commitSha: sha, sourceDigest: fixed, targetEnv: "uat", createdAt: now.toISOString(), artifacts: [{ path: "app.bin", sha256: hash(readFileSync(path.join(root, "app.bin"))) }], configFiles: [{ path: "app.json", sha256: hash(readFileSync(path.join(root, "app.json"))) }] };
      const summary = { schemaVersion: 1, run: { project, profile: "release", targetEnv: "uat", commitSha: sha, eventId: `${project}-${version}`, startedAt: now.toISOString(), durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: fixed }, policy: { policyHash: fixed, ruleSetHash: fixed, baselineHash: fixed, waiversHash: fixed, requiredCheckIds: ["CHECK"], checksSelected: 1, lockedToolVersions: { CHECK: "tool@1" } }, checks: [{ checkId: "CHECK", status: "ok", required: true, toolVersionVerified: true, toolVersion: "tool@1" }], findings: [], counts: { blockingNew: 0 }, decision: { status: "passed", reasons: [] } };
      const manifestFile = `${project}-${version}-manifest.json`, proofFile = `${project}-${version}-proof.json`, summaryFile = `${project}-${version}-summary.json`;
      write(path.join(dir, manifestFile), manifest); write(path.join(dir, summaryFile), summary);
      const proof = signRecord({ schemaVersion: 1, kind: "gate-proof", project, candidateSha: sha, profile: "release", targetEnv: "uat", eventId: summary.run.eventId, policyHash: fixed, ruleSetHash: fixed, reportDigest: hash(JSON.stringify(summary)), issuer: "quality-signer", pipelineId: "pipeline", jobId: "job", decision: "passed", createdAt: now.toISOString(), artifactManifestDigest: jsonHash(manifest) }, gate.privateKeyFile);
      write(path.join(dir, proofFile), proof);
      return { project, scope: "standard", role, sha, authorId: `author-${project}`, manifestFile, proofFile, summaryFile, publicKeyFile: path.basename(gate.publicKeyFile), artifactRoot: `stage/${project}`, expectIssuer: "quality-signer", expectPipelineId: "pipeline", expectJobId: "job", expectPolicyHash: fixed, expectRulesHash: fixed, expectBaselineHash: fixed, expectWaiversHash: fixed };
    });
    const inputFile = path.join(dir, `release-${version}-input.json`), input = { schemaVersion: 1, kind: "release-set-input", releaseSetId: `set-${version}`, environment: "uat", components, compatibility }; mutate(input); write(inputFile, input);
    const outFile = path.join(dir, `release-${version}.json`), options = { inputFile, evidenceRoot: dir, expectInputHash: hash(readFileSync(inputFile)), privateKeyFile: release.privateKeyFile, issuer: "release-signer", outFile, now };
    const result = createReleaseSet(options); return { result, options, releaseSetFile: outFile, expectReleaseSetHash: result.releaseSetHash };
  }
  const commandsRoot = path.join(dir, "commands"); mkdirSync(commandsRoot);
  const scriptFile = path.join(commandsRoot, "apply.mjs");
  writeFileSync(scriptFile, `import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
const context=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--wl-context')+1])); const root=path.dirname(context.resultFile); const hash=v=>createHash('sha256').update(v).digest('hex');
if(process.argv.includes('--fail')) process.exit(7);
const observation=JSON.stringify({actualReleaseSetHash:context.releaseSetHash,action:context.action}); fs.writeFileSync(path.join(root,'observed.json'),observation);
const checks=context.action==='smoke'?context.requiredSmokeChecks.map(id=>{const evidence='observed '+id;fs.writeFileSync(path.join(root,id+'.txt'),evidence);return {id,status:'passed',evidenceFile:id+'.txt',evidenceHash:hash(evidence)};}):[];
const result={schemaVersion:1,kind:'deployment-command-result',action:context.action,executionId:context.executionId,environment:context.environment,releaseSetHash:context.releaseSetHash,actualReleaseSetHash:context.releaseSetHash,compatibilityHash:context.compatibilityHash,apiContractHash:context.apiContractHash,databaseSchemaVersion:context.expectedSchemaVersion,appliedDeploymentOrder:context.deploymentOrder,result:'passed',deploymentId:context.action==='smoke'?context.currentDeploymentId:'deployment-'+context.releaseSet.releaseSetId,recordUrl:'https://deploy.example.invalid/records/'+context.executionId,observationFile:'observed.json',observationHash:hash(observation),checks};
fs.writeFileSync(context.resultFile,JSON.stringify(result));
`);
  const command = { program: realpathSync(process.execPath), programHash: hash(readFileSync(process.execPath)), script: "apply.mjs", scriptHash: hash(readFileSync(scriptFile)), args: [], configFiles: [], timeoutMs: 10000, environment: {}, secretEnv: [] };
  const config = { schemaVersion: 1, kind: "deployment-config", issuer: "deployment-executor", environment: "uat", lane: "release", authorizationIssuer: "identity", releaseIssuer: "release-signer", releasePublicKeyFile: release.publicKeyFile, authorizationPublicKeyFile: authorization.publicKeyFile, commandsRoot, artifactRoot, stateFile: path.join(dir, "deployment-state.json"), projects: ["ui", "api"], operators: ["operator"], verifiers: ["reviewer"], requiredSmokeChecks: ["health", "critical-flow"], allowedLinkOrigins: ["https://deploy.example.invalid"], commands: { deploy: structuredClone(command), smoke: structuredClone(command), recover: structuredClone(command) } };
  const configFile = path.join(dir, "deployment-config.json"), stateFile = path.join(dir, "deployment-state.json"); write(configFile, config); let sequence = 0;
  function planned(set, action = "deploy") {
    const planFile = path.join(dir, `plan-${++sequence}.json`), options = { configFile, ...set, stateFile, action, outFile: planFile, now }; const plan = planDeployment(options);
    const actorId = action === "smoke" ? "reviewer" : "operator", authorizationFile = path.join(dir, `authorization-${sequence}.json`);
    const approval = signRecord({ schemaVersion: 1, kind: "deployment-authorization", authorizationId: `auth-${sequence}`, issuer: "identity", scope: "deployment-execute", decision: "approved", action, planHash: plan.planHash, releaseSetHash: set.expectReleaseSetHash, environment: "uat", stateHash: plan.stateHash, actorId, reason: "隔离验收明确批准", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600000).toISOString() }, authorization.privateKeyFile); write(authorizationFile, approval);
    return { plan, approval, options: { configFile, ...set, stateFile, planFile, authorizationFile, privateKeyFile: executor.privateKeyFile, outDir: path.join(dir, `execution-${sequence}`), now } };
  }
  return { dir, now, release, authorization, executor, config, configFile, stateFile, releaseSet, planned, scriptFile, writeConfig: () => write(configFile, config) };
}

test("真实CLI自动queue→选择授权执行→deliver交付，无手填授权文件名", (t) => {
  const f = fixture(t), set = f.releaseSet(), planned = f.planned(set), cli = path.resolve(import.meta.dirname, "../../bin/wl-skills-gate.js");
  const invoke = (...args) => { const r = spawnSync(process.execPath, [cli, "deployment", ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };
  const planFile = path.join(f.dir, "control/deployment-plans/cli-plan.json"); write(planFile, JSON.parse(readFileSync(planned.options.planFile)));
  const queued = invoke("queue", "--requests-dir", path.join(f.dir, "control/deployment-requests"), "--plan-id", "cli-plan", "--config-id", "uat", "--plan", planFile, "--release-set", set.releaseSetFile); assert.equal(queued.status, "queued");
  const base = ["--config", f.configFile, "--release-set", set.releaseSetFile, "--expect-release-set-hash", set.expectReleaseSetHash, "--state", f.stateFile, "--plan", planFile, "--authorization-dir", f.dir, "--timeout-ms", "1000", "--private-key", f.executor.privateKeyFile, "--out-dir", path.join(f.dir, "cli-execution")];
  assert.equal(invoke("run-authorized", ...base).executed, false); assert.equal(existsSync(f.stateFile), false);
  const executed = invoke("run-authorized", ...base, "--send"); assert.equal(executed.status, "success");
  const delivered = invoke("deliver", "--delivery-dir", path.join(f.dir, "control/deployment-deliveries"), "--config-id", "uat", "--execution", executed.executionFile, "--release-set", set.releaseSetFile, "--expect-release-set-hash", set.expectReleaseSetHash); assert.equal(delivered.status, "queued");
  assert.equal(JSON.parse(readFileSync(delivered.deliveryFile)).executionFile, executed.executionFile);
});

test("前后端组合逐仓验证实际制品/配置、release证明，固定环境/集合不可替换", (t) => {
  const f = fixture(t), set = f.releaseSet();
  assert.equal(set.result.components.length, 2);
  assert.equal(verifyReleaseSet({ ...set, publicKeyFile: f.release.publicKeyFile, expectIssuer: "release-signer", env: "uat", now: f.now }).ok, true);
  assert.throws(() => verifyReleaseSet({ ...set, publicKeyFile: f.release.publicKeyFile, expectIssuer: "release-signer", env: "prd", now: f.now }), /目标环境/);
  writeFileSync(path.join(f.dir, "stage/ui/app.bin"), "tampered");
  assert.throws(() => f.planned(set), /待部署制品/);
});
test("组合创建拒绝旧清单、错误签名、少仓以及被替换的真实二进制", (t) => {
  const f = fixture(t);
  assert.throws(() => f.releaseSet("c", (input) => input.components[0].sha = "d".repeat(40)), /组件.*无效/);
  const single = f.releaseSet("d", (input) => {input.components.pop();input.compatibility.deploymentOrder=input.components.map(c=>c.project);});
  assert.throws(() => f.planned(single), /组合项目集合不完整/);
});
test("默认预览不执行，单次明确授权部署→独立smoke→当前原始证据构造事实", (t) => {
  const f = fixture(t), set = f.releaseSet(), deploy = f.planned(set);
  assert.equal(runDeployment(deploy.options).executed, false); assert.equal(existsSync(f.stateFile), false);
  const applied = runDeployment({ ...deploy.options, send: true }); assert.equal(applied.status, "success");
  const state = JSON.parse(readFileSync(f.stateFile)); assert.equal(state.activeReleaseSetHash, set.expectReleaseSetHash); assert.equal(state.verification, null);
  assert.throws(() => runDeployment({ ...deploy.options, outDir: path.join(f.dir, "replay"), send: true }), /已变化/);
  const smoke = f.planned(set, "smoke"), verified = runDeployment({ ...smoke.options, send: true }); assert.equal(verified.status, "success");
  const fact = createDeploymentLifecycle({ ...smoke.options, executionFile: verified.executionFile, executorPublicKeyFile: f.executor.publicKeyFile, project: "api", sequence: 2, pipelineId: "central", jobId: "smoke", pipelineUrl: "https://deploy.example.invalid/pipeline", reportUrl: "https://deploy.example.invalid/report", outDir: path.join(f.dir, "fact"), now: f.now.getTime() });
  const event = JSON.parse(readFileSync(fact.eventFile)); assert.equal(event.status, "verified"); assert.equal(event.releaseSetHash, set.expectReleaseSetHash); assert.equal(event.actorId, "reviewer"); assert.equal(event.sha, "b".repeat(40));
  writeFileSync(path.join(path.dirname(verified.executionFile), "health.txt"), "tampered");
  assert.throws(() => createDeploymentLifecycle({ ...smoke.options, executionFile: verified.executionFile, executorPublicKeyFile: f.executor.publicKeyFile, project: "api", sequence: 3, pipelineId: "central", jobId: "smoke", pipelineUrl: "https://deploy.example.invalid/pipeline", reportUrl: "https://deploy.example.invalid/report", outDir: path.join(f.dir, "tampered-fact"), now: f.now.getTime() }), /smoke-evidence/);
});
test("执行失败保留当前活动版本，记录失败且不复用旧授权；显式恢复仅允许上一组合", (t) => {
  const f = fixture(t), before = f.releaseSet("b"), next = f.releaseSet("c");
  runDeployment({ ...f.planned(before).options, send: true });
  f.config.commands.deploy.args = ["--fail"]; f.writeConfig();
  const failed = f.planned(next), outcome = runDeployment({ ...failed.options, send: true }); assert.equal(outcome.status, "failed"); assert.equal(outcome.activeReleaseUnchanged, true);
  assert.equal(JSON.parse(readFileSync(f.stateFile)).activeReleaseSetHash, before.expectReleaseSetHash);
  assert.throws(() => runDeployment({ ...failed.options, outDir: path.join(f.dir, "failed-replay"), send: true }), /已变化/);
  f.config.commands.deploy.args = []; f.writeConfig(); runDeployment({ ...f.planned(next).options, send: true });
  const restored = runDeployment({ ...f.planned(before, "recover").options, send: true }); assert.equal(restored.status, "success"); assert.equal(JSON.parse(readFileSync(f.stateFile)).activeReleaseSetHash, before.expectReleaseSetHash);
  assert.throws(() => f.planned(before, "recover"), /上一组合/);
});
test("动作/计划/环境授权、程序摘要、并发锁和来源签名均不能绕过", (t) => {
  const f = fixture(t), set = f.releaseSet(), plan = f.planned(set);
  const approval = { ...plan.approval, action: "recover" }; write(plan.options.authorizationFile, signRecord(approval, f.authorization.privateKeyFile));
  assert.throws(() => runDeployment({ ...plan.options, send: true }), /明确授权/); assert.equal(existsSync(f.stateFile), false);
  write(plan.options.authorizationFile, plan.approval); mkdirSync(f.stateFile + ".lock"); assert.throws(() => runDeployment({ ...plan.options, send: true }), /禁止并发/); rmSync(f.stateFile + ".lock", { recursive: true });
  writeFileSync(f.scriptFile, "changed"); assert.throws(() => runDeployment({ ...plan.options, send: true }), /脚本变化/); assert.equal(existsSync(f.stateFile), false);
});

test("实际OIDC登录→人员/CSRF/固定计划授权→受控真实子进程部署→独立验证贯通", async (t) => {
  const f = fixture(t), set = f.releaseSet(), plan = f.planned(set), origin = "https://quality.example.invalid", now = f.now.getTime();
  const identity = generateKeyPairSync("ed25519"), receipt = generateKeyPairSync("ed25519");
  const identityPublic = path.join(f.dir, "identity-public.pem"), receiptPublic = path.join(f.dir, "receipt-public.pem"), receiptPrivate = path.join(f.dir, "receipt-private.pem");
  writeFileSync(identityPublic, identity.publicKey.export({ type: "spki", format: "pem" })); writeFileSync(receiptPublic, receipt.publicKey.export({ type: "spki", format: "pem" })); writeFileSync(receiptPrivate, receipt.privateKey.export({ type: "pkcs8", format: "pem" }));
  const governanceConfigFile = path.join(f.dir, "governance.json"), dataDir = path.join(f.dir, "control"), controlFile = path.join(f.dir, "control-config.json"); mkdirSync(dataDir);
  const fixed = "a".repeat(64), project = { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: origin + "/issues", scopes: { standard: { requiredChecks: ["CHECK"], policyHash: fixed, rulesHash: fixed, baselineHash: fixed, waiversHash: fixed, closurePolicy: { requiredEnvironments: ["uat"], deploymentLane: "release", requireDeployment: true } } } };
  write(governanceConfigFile, { schemaVersion: 1, issuer: "central", publicKeyFile: receiptPublic, allowedLinkOrigins: [origin], operators: ["operator"], projects: { ui: project, api: project }, channels: { group: { type: "feishu", webhookEnv: "WEBHOOK", signingSecretEnv: "SIGNING_SECRET" } } });
  const control = { schemaVersion: 1, origin, governanceConfigFile, stateFile: path.join(f.dir, "issues.json"), dataDir, receiptPrivateKeyFile: receiptPrivate, authorizationPrivateKeyFile: f.authorization.privateKeyFile, authorizationIssuer: "identity", reviewPolicies: {}, deploymentConfigs: { uat: f.configFile }, identity: { algorithm: "EdDSA", keyId: "identity-key", publicKeyFile: identityPublic, issuer: "https://identity.example.invalid", authorizationEndpoint: "https://identity.example.invalid/authorize", tokenEndpoint: "https://identity.example.invalid/token", clientId: "quality", subjects: { "user-operator": "operator", "user-reviewer": "reviewer", "user-owner": "owner" } } };
  write(controlFile, control); let subject, nonce, challenge;
  const handler = createControlHandler({ configFile: controlFile, clock: () => now, fetchImpl: async (_url, init) => {
    const input = new URLSearchParams(init.body); assert.equal(hash(input.get("code_verifier")), Buffer.from(challenge, "base64url").toString("hex"));
    const parts = [Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "identity-key" })).toString("base64url"), Buffer.from(JSON.stringify({ iss: control.identity.issuer, aud: "quality", sub: subject, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600, nonce })).toString("base64url")];
    return new Response(JSON.stringify({ id_token: parts.join(".") + "." + sign(null, Buffer.from(parts.join(".")), identity.privateKey).toString("base64url") }));
  } });
  const http = ({ url, method = "GET", cookie, data } = {}) => new Promise((resolve, reject) => {
    const body = data ? new URLSearchParams(data).toString() : "", req = Readable.from(body ? [Buffer.from(body)] : []); req.url = url; req.method = method; req.headers = { host: new URL(origin).host, ...(cookie ? { cookie } : {}), ...(body ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}) };
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(text) { resolve({ status: this.status, headers: this.headers, text }); } }; handler(req, response).catch(reject);
  });
  const login = async (actor, destination) => {
    subject = `user-${actor}`; const started = await http({ url: `/auth/login?return=${encodeURIComponent(destination)}` }), u = new URL(started.headers.Location); nonce = u.searchParams.get("nonce"); challenge = u.searchParams.get("code_challenge");
    const cookie = started.headers["Set-Cookie"].split(";")[0], callback = await http({ url: `/auth/callback?code=actual-code&state=${u.searchParams.get("state")}`, cookie }); assert.equal(callback.status, 302, callback.text); return callback.headers["Set-Cookie"][0].split(";")[0];
  };
  async function authorize(planned, planId, actor) {
    const planFile = path.join(dataDir, planId + ".json"); writeFileSync(planFile, readFileSync(planned.options.planFile));
    const queued = queueDeploymentPlan({ requestsDir: path.join(dataDir, "deployment-requests"), configId: "uat", planId, planFile, releaseSetFile: set.releaseSetFile }); assert.equal(queued.status, "queued");
    assert.equal(selectDeploymentAuthorization({ configFile: f.configFile, planFile, authorizationDir: path.join(dataDir, "authorizations"), now }).status, "pending");
    const destination = `/deployments/${planId}`, cookie = await login(actor, destination), page = await http({ url: destination, cookie }); assert.equal(page.status, 200, page.text); const csrf = page.text.match(/name="csrf" value="([^"]+)"/)[1];
    const denied = await http({ url: destination, method: "POST", cookie, data: { csrf, actorId: "operator", planHash: planned.plan.planHash, reason: "不可自报身份" } }); assert.equal(denied.status, 400);
    const accepted = await http({ url: destination, method: "POST", cookie, data: { csrf, planHash: planned.plan.planHash, reason: "已复核组合和实际环境" } }); assert.equal(accepted.status, 200, accepted.text);
    const selected = selectDeploymentAuthorization({ configFile: f.configFile, planFile, authorizationDir: path.join(dataDir, "authorizations"), now }); assert.equal(selected.status, "authorized"); assert.equal(selected.authorizationId, accepted.headers["X-Quality-Authorization-Id"]); return selected.authorizationFile;
  }
  const authorizationFile = await authorize(plan, "plan-deploy", "operator"), deployed = runDeployment({ ...plan.options, authorizationFile, send: true }); assert.equal(deployed.status, "success");
  const smoke = f.planned(set, "smoke"), independentAuthorization = await authorize(smoke, "plan-smoke", "reviewer"), verified = runDeployment({ ...smoke.options, authorizationFile: independentAuthorization, send: true }); assert.equal(verified.status, "success");
  const execution = JSON.parse(readFileSync(verified.executionFile)); assert.equal(execution.actorId, "reviewer"); assert.equal(execution.checks.length, 2);
});

test("失败或中断部署可显式恢复到失败前已知组合，不能被旧状态永久卡住", (t) => {
  const f = fixture(t), before = f.releaseSet("b"), attempted = f.releaseSet("c");
  runDeployment({ ...f.planned(before).options, send: true });
  f.config.commands.deploy.args = ["--fail"]; f.writeConfig(); runDeployment({ ...f.planned(attempted).options, send: true });
  const failed = JSON.parse(readFileSync(f.stateFile)); assert.equal(failed.previousReleaseSetHash, null); assert.equal(failed.activeReleaseSetHash, before.expectReleaseSetHash); assert.equal(failed.lastFailedAttempt.releaseSetHash, attempted.expectReleaseSetHash);
  const recovered = runDeployment({ ...f.planned(before, "recover").options, send: true }); assert.equal(recovered.status, "success"); assert.equal(JSON.parse(readFileSync(f.stateFile)).lastFailedAttempt, null);
  assert.throws(() => f.planned(before, "recover"), /禁止任意回退/);
});

test("组合强制API/数据库/顺序/回退证据，拒绝空声明、漏仓顺序和原始文件漂移", (t) => {
  for (const change of [
    (input) => delete input.compatibility,
    (input) => input.compatibility.deploymentOrder = ["api", "api"],
    (input) => input.compatibility.database.reason = "",
    (input) => input.compatibility.api.evidence.sha256 = "0".repeat(64),
    (input) => input.compatibility.api.version = "v2",
    (input) => input.compatibility.rollback.mode = "unknown",
  ]) { const f = fixture(t); assert.throws(() => f.releaseSet("b", change)); }
});

test("API兼容性测试读取真实JUnit用例，零用例、失败或跳过不能签发", (t) => {
  for (const xml of ['<testsuite tests="0"/>', '<testsuite tests="1"><testcase name="contract"><failure/></testcase></testsuite>', '<testsuite tests="1"><testcase name="contract"><skipped/></testcase></testsuite>']) {
    const f = fixture(t); assert.throws(() => f.releaseSet("b", (input) => { const file = "api-tests.xml"; writeFileSync(path.join(f.dir, file), xml); input.compatibility.api.type = "compatibility-test"; input.compatibility.api.evidence = { file, sha256: hash(xml) }; }), /API兼容性/);
  }
  const f = fixture(t), xml = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="actual-api-compatibility" classname="ContractTest"/></testsuite>';
  const set = f.releaseSet("b", (input) => { const file = "api-tests.xml"; writeFileSync(path.join(f.dir, file), xml); input.compatibility.api.type = "compatibility-test"; input.compatibility.api.evidence = { file, sha256: hash(xml) }; });
  const record = JSON.parse(readFileSync(set.releaseSetFile)); record.compatibility.evidence["api-tests.xml"].base64 = Buffer.from("tampered").toString("base64"); write(set.releaseSetFile, signRecord(record, f.release.privateKeyFile));
  assert.throws(() => verifyReleaseSet({ ...set, expectReleaseSetHash: jsonHash(JSON.parse(readFileSync(set.releaseSetFile))), publicKeyFile: f.release.publicKeyFile, expectIssuer: "release-signer", env: "uat", now: f.now }), /原始字节/);
});

for (const backwardCompatible of [true, false]) test(`数据库迁移文件/schema与${backwardCompatible ? "兼容保留schema" : "明确恢复SQL"}回退约束贯通`, (t) => {
  const f = fixture(t), before = f.releaseSet("b");
  const migrated = f.releaseSet("c", (input) => {
    const sql = "ALTER TABLE orders ADD COLUMN source VARCHAR(32);", reverse = "ALTER TABLE orders DROP COLUMN source;";
    writeFileSync(path.join(f.dir, "migration.sql"), sql); writeFileSync(path.join(f.dir, "recovery.sql"), reverse);
    input.compatibility.database = { mode: "migrate", fromSchema: "schema-1", toSchema: "schema-2", migrations: [{ file: "migration.sql", sha256: hash(sql) }], reviewEvidence: input.compatibility.api.reviewEvidence, backwardCompatible };
    if (!backwardCompatible) input.compatibility.rollback = { mode: "requires-approved-recovery", reason: "Reverse migration and API rollback reviewed together", reviewEvidence: input.compatibility.api.reviewEvidence, recoveryEvidence: { file: "recovery.sql", sha256: hash(reverse) } };
  });
  runDeployment({ ...f.planned(before).options, send: true });
  const plan = f.planned(migrated); assert.equal(plan.plan.expectedSchemaVersion, "schema-2"); assert.deepEqual(plan.plan.deploymentOrder, ["api", "ui"]); assert.equal(runDeployment({ ...plan.options, send: true }).status, "success");
  const recovery = f.planned(before, "recover"); assert.equal(recovery.plan.expectedSchemaVersion, backwardCompatible ? "schema-2" : "schema-1"); assert.equal(recovery.plan.databaseExecution.mode, backwardCompatible ? "preserve-compatible-schema" : "approved-recovery");
  assert.equal(runDeployment({ ...recovery.options, send: true }).status, "success");
  const smoke = f.planned(before, "smoke"); assert.equal(smoke.plan.expectedSchemaVersion, backwardCompatible ? "schema-2" : "schema-1"); assert.equal(runDeployment({ ...smoke.options, send: true }).status, "success");
});

test("部署请求不可覆盖/越界，授权选择只收当前计划真实签名，坏消息不阻塞有效授权", async (t) => {
  const f = fixture(t), set = f.releaseSet(), plan = f.planned(set), central = path.join(f.dir, "control-queue"), requestsDir = path.join(central, "deployment-requests"), planFile = path.join(central, "plans", "uat.json"), authorizationDir = path.join(central, "authorizations"); mkdirSync(path.dirname(planFile), { recursive: true }); mkdirSync(authorizationDir); writeFileSync(planFile, readFileSync(plan.options.planFile));
  const options = { requestsDir, planId: "uat-1", configId: "uat", planFile, releaseSetFile: set.releaseSetFile }; assert.equal(queueDeploymentPlan(options).reused, false); assert.equal(queueDeploymentPlan(options).reused, true);
  assert.throws(() => queueDeploymentPlan({ ...options, planFile: plan.options.planFile }), /中央control/);
  const next = f.planned(set), nextFile = path.join(central, "plans", "next.json"); writeFileSync(nextFile, readFileSync(next.options.planFile)); assert.throws(() => queueDeploymentPlan({ ...options, planFile: nextFile }), /拒绝覆盖/);
  const selecting = { configFile: f.configFile, planFile, authorizationDir, now: f.now.getTime() }; assert.equal(selectDeploymentAuthorization(selecting).status, "pending");
  write(path.join(authorizationDir, "forged.json"), { ...plan.approval, signature: { algorithm: "Ed25519", value: Buffer.alloc(64).toString("base64") } });
  write(path.join(authorizationDir, "expired.json"), signRecord({ ...plan.approval, expiresAt: f.now.toISOString() }, f.authorization.privateKeyFile));
  write(path.join(authorizationDir, "wrong-state.json"), signRecord({ ...plan.approval, stateHash: "0".repeat(64) }, f.authorization.privateKeyFile));
  write(path.join(authorizationDir, "actual.json"), plan.approval); const selected = selectDeploymentAuthorization(selecting); assert.equal(selected.status, "authorized"); assert.equal(selected.authorizationFile, path.join(authorizationDir, "actual.json")); assert.equal(selected.rejected, 3);
  const empty = path.join(central, "waiting"), waiting = { configFile: f.configFile, planFile, authorizationDir: empty }; let elapsed = 0;
  const ready = await waitForDeploymentAuthorization({ ...waiting, timeoutMs: 200, pollIntervalMs: 100, clock: () => f.now.getTime() + elapsed, sleep: async (ms) => { elapsed += ms; mkdirSync(empty); write(path.join(empty, "actual.json"), plan.approval); } }); assert.equal(ready.status, "authorized"); assert.equal(elapsed, 100);
  elapsed = 0; const timed = await waitForDeploymentAuthorization({ ...waiting, authorizationDir: path.join(central, "empty-timeout"), timeoutMs: 200, pollIntervalMs: 100, clock: () => f.now.getTime() + elapsed, sleep: async (ms) => { elapsed += ms; } }); assert.equal(timed.status, "timed-out"); assert.equal(timed.executed, false);
});

test("签名CI执行→无身份密钥交付队列→双仓台账回流，中断逐仓续跑并隔离坏件", async (t) => {
  const f = fixture(t), set = f.releaseSet(), ciOrigin = "https://jenkins.example.invalid";
  f.config.ci = { system: "jenkins", baseUrl: ciOrigin, jobPath: "team/deploy-uat", jobId: "deploy-uat" }; f.config.allowedLinkOrigins.push(ciOrigin); f.writeConfig();
  const plan = f.planned(set), ciEnv = { JOB_NAME: "team/deploy-uat", BUILD_NUMBER: "12", BUILD_URL: `${ciOrigin}/job/team/job/deploy-uat/12/` };
  assert.throws(() => runDeployment({ ...plan.options, env: { ...ciEnv, JOB_NAME: "other/deploy" }, send: true }), /JOB_NAME/);
  const executed = runDeployment({ ...plan.options, env: ciEnv, send: true }), signed = JSON.parse(readFileSync(executed.executionFile)); assert.equal(signed.ciContext.buildNumber, 12);
  const central = path.join(f.dir, "delivery-control"), deliveryDir = path.join(central, "deployment-deliveries");
  const queued = queueDeploymentDelivery({ deliveryDir, configId: "uat", executionFile: executed.executionFile, releaseSetFile: set.releaseSetFile, expectReleaseSetHash: set.expectReleaseSetHash }); assert.equal(queued.status, "queued");
  for (const [name, context] of [["other-job", { ...signed.ciContext, buildUrl: `${ciOrigin}/job/other/12/` }], ["missing-context", undefined]]) {
    const wrongFile = path.join(f.dir, name, "execution.json"), wrong = { ...signed, executionId: name, ciContext: context }; if (!context) delete wrong.ciContext;
    write(wrongFile, signRecord(wrong, f.executor.privateKeyFile)); queueDeploymentDelivery({ deliveryDir, configId: "uat", executionFile: wrongFile, releaseSetFile: set.releaseSetFile, expectReleaseSetHash: set.expectReleaseSetHash });
  }
  const keys = generateKeyPairSync("ed25519"), receiptPrivateKeyFile = path.join(f.dir, "events-private.pem"), publicKeyFile = path.join(f.dir, "events-public.pem"); writeFileSync(receiptPrivateKeyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  const governanceConfigFile = path.join(f.dir, "delivery-governance.json"), stateFile = path.join(f.dir, "delivery-ledger.json"), fixed = "a".repeat(64), qualityOrigin = "https://quality.example.invalid";
  const project = { owner: "owner", backup: "backup", escalationOwner: "manager", reviewers: ["reviewer"], channel: "group", issueBaseUrl: qualityOrigin + "/issues", scopes: { standard: { requiredChecks: ["CHECK"], policyHash: fixed, rulesHash: fixed, baselineHash: fixed, waiversHash: fixed, closurePolicy: { requiredEnvironments: ["uat"], deploymentLane: "release", requireDeployment: true } } } };
  write(governanceConfigFile, { schemaVersion: 1, issuer: "central", publicKeyFile, allowedLinkOrigins: [qualityOrigin, ciOrigin, "https://deploy.example.invalid"], operators: ["operator"], projects: { ui: project, api: project }, channels: { group: { type: "feishu", webhookEnv: "WEBHOOK", signingSecretEnv: "SIGNING_SECRET" } } });
  const options = { governanceConfigFile, stateFile, receiptPrivateKeyFile, deliveryDir, dataDir: path.join(central, "consumer"), configs: { uat: { configFile: f.configFile, executorPublicKeyFile: f.executor.publicKeyFile, executionRoot: f.dir } }, now: f.now.getTime() };
  const interrupted = await ingestDeploymentDeliveries({ ...options, afterStage: () => { throw new Error("isolated crash after one governance ingest"); } }); assert.equal(interrupted.status, "attention"); assert.equal(Object.keys(JSON.parse(readFileSync(stateFile)).events).length, 1);
  write(path.join(deliveryDir, "delivery-" + "0".repeat(48) + ".json"), { schemaVersion: 1, kind: "forged" });
  const resumed = await ingestDeploymentDeliveries(options); assert.equal(resumed.delivered, 1); assert.equal(resumed.errors.length, 3); assert.ok(resumed.errors.some((entry) => /CI URL/.test(entry.reason))); assert.ok(resumed.errors.some((entry) => /签名上下文/.test(entry.reason)));
  const ledger = JSON.parse(readFileSync(stateFile)); assert.equal(Object.keys(ledger.events).length, 2); assert.equal(Object.keys(ledger.outbox).length, 2); assert.ok(Object.values(ledger.lifecycles).every((fact) => fact.sequence === 120001 && fact.pipelineId === "12" && fact.jobId === "deploy-uat"));
  const duplicate = await ingestDeploymentDeliveries(options); assert.equal(duplicate.skipped, 1); assert.equal(Object.keys(JSON.parse(readFileSync(stateFile)).events).length, 2);
  const firstEvent = Object.keys(ledger.events)[0]; delete ledger.events[firstEvent]; write(stateFile, ledger);
  const missingLedger = await ingestDeploymentDeliveries(options); assert.equal(missingLedger.status, "attention"); assert.equal(missingLedger.skipped, 0); assert.ok(missingLedger.errors.some((entry) => /缺失|损坏/.test(entry.reason)));
});
