import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createControlReviewFixture } from "../test-support/control-review-fixture.mjs";
import { createReleaseReviewFixture } from "../test-support/release-review-fixture.mjs";
import { createReviewDraft } from "../../lib/review.js";
import { createCiReview } from "../../lib/review-ci.js";
import { publishReviewAuthorizations } from "../../lib/review-publish.js";
import { signRecord, verifyReview } from "../../lib/evidence.js";
import { verifyReleaseReview, selectReleaseReview } from "../../lib/release-review.js";
import { createReleaseSet, verifyReleaseSet, validateReleaseSetInput } from "../../lib/release-set.js";
import { planDeployment, runDeployment, createDeploymentLifecycle } from "../../lib/deployment.js";
import { stableStringify } from "../../lib/util.js";
const now = new Date("2026-10-15T00:00:00Z"), fixed = "a".repeat(64), sha = "b".repeat(40);
const hash = (v) => createHash("sha256").update(v).digest("hex"), jsonHash = (v) => hash(stableStringify(v));
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
const read = (file) => JSON.parse(readFileSync(file));
function evidence(name, value) { const dir = process.env.WL_FULL_CHAIN_EVIDENCE_DIR; if (dir) write(path.join(dir, `${name}.json`), value); }
function fixture(t, now = new Date("2026-10-15T00:00:00Z")) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-prevention-chain-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = {};
  for (const name of ["gate", "release", "authorization", "executor"]) { const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, `${name}-private.pem`), publicKeyFile = path.join(dir, `${name}-public.pem`); writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, pair.publicKey.export({ type: "spki", format: "pem" })); keys[name] = { privateKeyFile, publicKeyFile }; }
  const root = path.join(dir, "artifacts/demo"); mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, "app.bin"), Buffer.from([0, 255, 4, 12]));
  const summary = { schemaVersion: 1, run: { project: "demo", profile: "release", targetEnv: "uat", commitSha: sha, eventId: "release-run", startedAt: now.toISOString(), durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: fixed }, policy: { policyHash: fixed, ruleSetHash: fixed, baselineHash: fixed, waiversHash: fixed, requiredCheckIds: ["CHECK"], checksSelected: 1, lockedToolVersions: { CHECK: "tool@1" } }, checks: [{ checkId: "CHECK", status: "ok", required: true, toolVersionVerified: true, toolVersion: "tool@1" }], findings: [], counts: { blockingNew: 0 }, decision: { status: "passed", reasons: [] } };
  const review = createReleaseReviewFixture({ root: dir, project: "demo", sha, summary, now });
  const manifest = { schemaVersion: 1, project: "demo", commitSha: sha, sourceDigest: fixed, targetEnv: "uat", createdAt: now.toISOString(), artifacts: [{ path: "app.bin", sha256: hash(readFileSync(path.join(root, "app.bin"))) }], configFiles: [] };
  write(path.join(dir, "summary.json"), summary); write(path.join(dir, "manifest.json"), manifest);
  write(path.join(dir, "proof.json"), signRecord({ schemaVersion: 1, kind: "gate-proof", project: "demo", candidateSha: sha, profile: "release", targetEnv: "uat", eventId: summary.run.eventId, policyHash: fixed, ruleSetHash: fixed, reportDigest: hash(JSON.stringify(summary)), issuer: "component-signer", pipelineId: "pipeline", jobId: "job", decision: "passed", createdAt: now.toISOString(), artifactManifestDigest: jsonHash(manifest) }, keys.gate.privateKeyFile));
  write(path.join(dir, "api.json"), { openapi: "3.0.3", info: { version: "v1" }, paths: { "/health": { get: {} } } }); writeFileSync(path.join(dir, "compatibility.txt"), "Explicit isolated API/schema/recovery review for this exact candidate");
  const ref = (file) => ({ file, sha256: hash(readFileSync(path.join(dir, file))) });
  const input = { schemaVersion: 1, kind: "release-set-input", releaseSetId: "isolated-chain", environment: "uat", components: [{ project: "demo", role: "service", scope: "standard", sha, authorId: "author-demo", summaryFile: "summary.json", manifestFile: "manifest.json", proofFile: "proof.json", publicKeyFile: "gate-public.pem", artifactRoot: "artifacts/demo", expectIssuer: "component-signer", expectPipelineId: "pipeline", expectJobId: "job", expectPolicyHash: fixed, expectRulesHash: fixed, expectBaselineHash: fixed, expectWaiversHash: fixed, reviewFile: path.relative(dir, review.recordFile), reviewEvidenceRoot: path.relative(dir, review.evidenceRoot) }], compatibility: { api: { type: "contract", version: "v1", evidence: ref("api.json"), reviewEvidence: ref("compatibility.txt") }, database: { mode: "none", schemaVersion: "schema-1", reason: "No SQL or entities changed in this fixture", reviewEvidence: ref("compatibility.txt") }, deploymentOrder: ["demo"], rollback: { mode: "compatible", reason: "Same schema and explicit isolated pair", reviewEvidence: ref("compatibility.txt") } } };
  const inputFile = path.join(dir, "input.json"), outFile = path.join(dir, "release-set.json");
  const validate = (value = input, extra = {}) => validateReleaseSetInput({ input: value, evidenceRoot: dir, reviewConfigFile: review.trustFile, now, ...extra });
  const release = () => { write(inputFile, input); return createReleaseSet({ inputFile, evidenceRoot: dir, reviewConfigFile: review.trustFile, expectInputHash: hash(readFileSync(inputFile)), issuer: "release-signer", privateKeyFile: keys.release.privateKeyFile, outFile, now }); };
  return { dir, root, input, review, keys, summary, manifest, inputFile, outFile, validate, release };
}
test("扫描通过与制品签名不能替代正式九维Review，缺授权/旧SHA/错误固定信任都在签组合前拦截", (t) => {
  const f = fixture(t), missing = structuredClone(f.input); delete missing.components[0].reviewFile;
  assert.throws(() => f.validate(missing), /正式 Review/); assert.throws(() => f.validate(f.input, { reviewConfigFile: undefined }), /review-config/);
  const draft = read(f.review.draft.recordFile); write(f.review.recordFile, draft); assert.throws(() => f.validate(), /签名/);
  write(f.review.recordFile, f.review.record); assert.throws(() => verifyReleaseReview({ configFile: f.review.trustFile, project: "demo", sha: "c".repeat(40), recordFile: f.review.recordFile, evidenceRoot: f.review.evidenceRoot, now }), /候选/);
  const trust = read(f.review.trustFile); trust.projects.demo.reviewers = ["unapproved-person"]; write(f.review.trustFile, trust); assert.throws(() => f.validate(), /批准名单/);
  assert.equal(existsSync(f.outFile), false);
  evidence("release-prevention", { scanPassed: true, componentProofSigned: true, missingReviewBlocked: true, missingTrustBlocked: true, unsignedReviewBlocked: true, wrongCandidateBlocked: true, unknownReviewerBlocked: true, releaseWritten: false });
});
test("组合归档实际正式签名与正文原件，消费时拒绝伪造布尔/旧组合/替换原件/任意公钥", (t) => {
  const f = fixture(t), result = f.release(), options = { releaseSetFile: result.releaseSetFile, expectReleaseSetHash: result.releaseSetHash, publicKeyFile: f.keys.release.publicKeyFile, expectIssuer: "release-signer", reviewConfigFile: f.review.trustFile, env: "uat", now };
  assert.equal(verifyReleaseSet(options).ok, true);
  const original = read(f.outFile);
  for (const change of [(r) => { r.components[0].review = { approved: true }; }, (r) => { delete r.components[0].review; }, (r) => { const name = Object.keys(r.components[0].review.files)[0]; r.components[0].review.files[name].base64 = Buffer.from("tampered").toString("base64"); }, (r) => { r.components[0].review.trustHash = "0".repeat(64); }]) {
    const record = structuredClone(original); change(record); const signed = signRecord(record, f.keys.release.privateKeyFile); write(f.outFile, signed);
    assert.throws(() => verifyReleaseSet({ ...options, expectReleaseSetHash: jsonHash(signed) }));
  }
  write(f.outFile, original); const trust = read(f.review.trustFile); trust.projects.demo.publicKeyFile = f.keys.gate.publicKeyFile; write(f.review.trustFile, trust); assert.throws(() => verifyReleaseSet(options), /信任/);
});
test("同候选修复证据改变必须重新Review；旧授权/正式记录不能覆盖新原件且缺失不被修复脚本掩盖", (t) => {
  const f = fixture(t), body = readFileSync(path.join(f.review.evidenceRoot, f.review.record.bodyFile));
  writeFileSync(path.join(f.review.evidenceRoot, f.review.record.bodyFile), "changed repair report"); assert.throws(() => f.validate(), /正文/); assert.equal(existsSync(f.outFile), false);
  writeFileSync(path.join(f.review.evidenceRoot, f.review.record.bodyFile), body); assert.equal(f.validate().components.length, 1);
  const next = new Date(now.getTime() + 25 * 3600000); assert.throws(() => f.validate(f.input, { now: next }), /过期/);
});
test("正式Review→组合签发→独立部署→实际子进程冒烟→签名复验事实，授权不能重放或跨动作", (t) => {
  const f = fixture(t), set = f.release(), commandsRoot = path.join(f.dir, "commands"), script = path.join(commandsRoot, "apply.mjs"); mkdirSync(commandsRoot);
  writeFileSync(script, `import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';const c=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--wl-context')+1]));const hash=v=>createHash('sha256').update(v).digest('hex');const dir=path.dirname(c.resultFile);const raw=JSON.stringify({release:c.releaseSetHash,action:c.action});fs.writeFileSync(path.join(dir,'observed.json'),raw);const checks=c.action==='smoke'?c.requiredSmokeChecks.map(id=>{fs.writeFileSync(path.join(dir,id+'.txt'),'passed '+id);return{id,status:'passed',evidenceFile:id+'.txt',evidenceHash:hash('passed '+id)}}):[];fs.writeFileSync(c.resultFile,JSON.stringify({schemaVersion:1,kind:'deployment-command-result',action:c.action,executionId:c.executionId,environment:c.environment,releaseSetHash:c.releaseSetHash,actualReleaseSetHash:c.releaseSetHash,compatibilityHash:c.compatibilityHash,apiContractHash:c.apiContractHash,databaseSchemaVersion:c.expectedSchemaVersion,appliedDeploymentOrder:c.deploymentOrder,result:'passed',deploymentId:c.action==='smoke'?c.currentDeploymentId:'isolated-deployment',recordUrl:'https://deploy.example.invalid/record/'+c.executionId,observationFile:'observed.json',observationHash:hash(raw),checks}));`);
  const command = { program: realpathSync(process.execPath), programHash: hash(readFileSync(process.execPath)), script: "apply.mjs", scriptHash: hash(readFileSync(script)), args: [], timeoutMs: 10000, configFiles: [], environment: {}, secretEnv: [] };
  const stateFile = path.join(f.dir, "state.json"), configFile = path.join(f.dir, "deployment.json"), config = { schemaVersion: 1, kind: "deployment-config", issuer: "executor", environment: "uat", lane: "release", releaseIssuer: "release-signer", authorizationIssuer: "identity", releasePublicKeyFile: f.keys.release.publicKeyFile, authorizationPublicKeyFile: f.keys.authorization.publicKeyFile, reviewConfigFile: f.review.trustFile, commandsRoot, artifactRoot: path.join(f.dir, "artifacts"), stateFile, projects: ["demo"], operators: ["operator"], verifiers: ["verifier"], requiredSmokeChecks: ["health", "critical-flow"], allowedLinkOrigins: ["https://deploy.example.invalid"], commands: { deploy: command, smoke: command, recover: command } }; write(configFile, config);
  let n = 0;
  const planned = (action) => { n++; const planFile = path.join(f.dir, `plan-${n}.json`), common = { configFile, stateFile, releaseSetFile: set.releaseSetFile, expectReleaseSetHash: set.releaseSetHash, now }, plan = planDeployment({ ...common, action, outFile: planFile }), authorizationFile = path.join(f.dir, `authorization-${n}.json`); write(authorizationFile, signRecord({ schemaVersion: 1, kind: "deployment-authorization", authorizationId: `approval-${n}`, issuer: "identity", scope: "deployment-execute", decision: "approved", actorId: action === "smoke" ? "verifier" : "operator", action, planHash: plan.planHash, releaseSetHash: set.releaseSetHash, environment: "uat", stateHash: plan.stateHash, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600000).toISOString(), reason: "Explicit isolated fixture approval" }, f.keys.authorization.privateKeyFile)); return { ...common, planFile, authorizationFile, privateKeyFile: f.keys.executor.privateKeyFile, outDir: path.join(f.dir, `execution-${n}`) }; };
  const deploy = planned("deploy"); assert.equal(runDeployment(deploy).executed, false); assert.equal(existsSync(stateFile), false);
  const applied = runDeployment({ ...deploy, send: true }); assert.equal(applied.status, "success"); assert.equal(read(stateFile).verification, null);
  assert.throws(() => runDeployment({ ...deploy, send: true, outDir: path.join(f.dir, "replay") }), /已变化/);
  const smoke = planned("smoke"), verified = runDeployment({ ...smoke, send: true }); assert.equal(verified.status, "success");
  const fact = createDeploymentLifecycle({ ...smoke, executionFile: verified.executionFile, executorPublicKeyFile: f.keys.executor.publicKeyFile, project: "demo", sequence: 2, pipelineId: "isolated", jobId: "smoke", pipelineUrl: "https://deploy.example.invalid/pipeline", reportUrl: "https://deploy.example.invalid/report", outDir: path.join(f.dir, "fact"), now: now.getTime() }); assert.equal(read(fact.eventFile).status, "verified");
  writeFileSync(path.join(path.dirname(verified.executionFile), "health.txt"), "tampered"); assert.throws(() => createDeploymentLifecycle({ ...smoke, executionFile: verified.executionFile, executorPublicKeyFile: f.keys.executor.publicKeyFile, project: "demo", sequence: 3, pipelineId: "isolated", jobId: "smoke", pipelineUrl: "https://deploy.example.invalid/pipeline", reportUrl: "https://deploy.example.invalid/report", outDir: path.join(f.dir, "bad-fact"), now: now.getTime() }), /smoke-evidence/);
  evidence("authorized-release-deployment", { formalReviewVerified: true, embeddedReviewEvidence: true, releaseSetSigned: true, previewExecuted: false, deploymentExecuted: true, deploymentAloneClosed: false, independentSmokeExecuted: true, verificationFact: "verified", authorizationReplayBlocked: true, tamperedSmokeBlocked: true, realRemoteDeployment: false });
});
test("可信CI→自动九维入口→认证逐项授权→必需作业重试使旧授权失效→新观察独立确认后自动签发", async (t) => {
  const f = await createControlReviewFixture(t, { includeOtherJob: true }), ciConfigFile = path.join(f.root, "review-ci-chain.json");
  write(ciConfigFile, { schemaVersion: 1, collectorConfigFile: f.configFile, reviewPolicyFile: path.join(f.root, "quality/review-policy.json"), controlConfigFile: f.controlConfigFile });
  const first = await createCiReview({ configFile: ciConfigFile, sourceFile: f.collection.sourceFile, outDir: path.join(f.root, "chain-review-1"), now: now.getTime() });
  const publishConfigFile = path.join(f.root, "review-publisher-chain.json"), publisher = { schemaVersion: 1, controlCatalogFile: path.join(f.c.dataDir, "reviews.json"), authorizationDir: path.join(f.c.dataDir, "authorizations"), stateFile: path.join(f.root, "publisher-state.json"), manifestDir: path.join(f.root, "review-delivery"), reviewPrivateKeyFile: path.join(f.root, "review-private.pem"), reviewPublicKeyFile: path.join(f.root, "review-public.pem"), authorizationPublicKeyFile: path.join(f.root, "authorization-public.pem"), authorizationIssuer: "identity-authority", projects: { demo: { evidenceRoots: [f.root], reviewers: ["reviewer"], collectorConfigFile: f.configFile, reviewPolicyFile: path.join(f.root, "quality/review-policy.json"), reviewPolicyHash: f.collector.reviewPolicyHash, policyHash: fixed, rulesHash: fixed, baselineHash: fixed, waiversHash: fixed, profile: "standard" } } };
  write(publishConfigFile, publisher); mkdirSync(publisher.authorizationDir, { recursive: true });
  const publish = () => publishReviewAuthorizations({ configFile: publishConfigFile, env: { TOKEN: "isolated-readonly-secret" }, fetchImpl: f.fetchImpl, now: now.getTime() });
  assert.equal((await publish()).published.length, 0); assert.equal(readdirSync(publisher.authorizationDir).length, 0);
  const cookie = await f.login();
  const approve = async (result) => { const url = `/reviews/${result.registrationId}`, page = await f.http({ url, cookie }); assert.equal(page.status, 200, page.text); const record = read(result.recordFile), fields = { csrf: page.text.match(/name="csrf" value="([^"]+)"/)?.[1], reviewDigest: record.reviewDigest, reason: "已查看本次九维原始证据与具体影响" }; for (const d of record.content.dimensions) { fields[`decision_${d.id}`] = d.applicable ? "approved" : "not-applicable"; fields[`reason_${d.id}`] = "独立查看本维度具体原件后确认"; } const response = await f.http({ url, method: "POST", cookie, body: new URLSearchParams(fields).toString() }); assert.equal(response.status, 200, response.text); };
  await approve(first);
  f.ciState.otherJobFailed = true; f.ciState.testsJobId = 62;
  const failed = await publish(); assert.equal(failed.published.length, 0); assert.equal(failed.errors.length, 1); assert.match(failed.errors[0].reason, /CI当前/);
  const failedSource = await f.recollect("failed-current-ci"), pending = await createCiReview({ configFile: ciConfigFile, sourceFile: failedSource.sourceFile, outDir: path.join(f.root, "chain-review-2"), now: now.getTime() });
  const pendingPage = await f.http({ url: `/reviews/${pending.registrationId}`, cookie }); assert.match(pendingPage.text, /阻断/); assert.equal((pendingPage.text.match(/type="checkbox"/g) || []).length, 0);
  f.ciState.otherJobFailed = false; f.ciState.testsJobId = 63;
  const repairedSource = await f.recollect("repaired-current-ci"), current = await createCiReview({ configFile: ciConfigFile, sourceFile: repairedSource.sourceFile, outDir: path.join(f.root, "chain-review-3"), now: now.getTime() });
  assert.notEqual(current.registrationId, first.registrationId); assert.equal(existsSync(first.recordFile), true); assert.equal(existsSync(pending.recordFile), true);
  const old = await publish(); assert.equal(old.published.length, 0); assert.match(old.errors[0].reason, /新版本替代|CI当前/);
  await approve(current); const completed = await publish(); assert.equal(completed.published.length, 1, JSON.stringify(completed.errors)); assert.equal(completed.errors.length, 1);
  const manifest = read(completed.published[0].manifestFile), formal = verifyReview({ ...manifest, recordFile: manifest.recordFile, project: "demo", sha, now: new Date(now.getTime() + 10000) });
  assert.equal(formal.kind, "review-record"); assert.equal(formal.content.dimensions.length, 9); assert.equal(manifest.registrationId, current.registrationId);
  assert.equal(formal.repairAuthorized, false); assert.equal(formal.deploymentAuthorized, false);
  const again = await publish(); assert.equal(again.published.length, 0); assert.equal(again.reused.length, 1);
  const releaseTrustFile = path.join(f.root, "release-review-trust.json");
  write(releaseTrustFile, { schemaVersion: 1, kind: "release-review-trust", projects: { demo: { publicKeyFile: publisher.reviewPublicKeyFile, authorizationPublicKeyFile: publisher.authorizationPublicKeyFile, authorizationIssuer: publisher.authorizationIssuer, reviewers: ["reviewer"], reviewPolicyHash: f.collector.reviewPolicyHash, policyHash: fixed, rulesHash: fixed, baselineHash: fixed, waiversHash: fixed, profile: "standard", evidenceRoots: [f.root], collectorConfigFile: f.configFile, controlCatalogFile: publisher.controlCatalogFile } } });
  const select = (extra = {}) => selectReleaseReview({ configFile: releaseTrustFile, project: "demo", sha, publicationDir: publisher.manifestDir, outDir: path.join(f.root, "build-live-checks"), now: new Date(now.getTime() + 10000), env: { TOKEN: "isolated-readonly-secret" }, fetchImpl: f.fetchImpl, ...extra });
  let selected; chmodSync(publisher.manifestDir, 0o500); try { selected = await select(); } finally { chmodSync(publisher.manifestDir, 0o700); } assert(selected.liveCheckDirectory.startsWith(path.join(f.root, "build-live-checks"))); assert.equal(selected.liveVerified, true); assert.equal(selected.recordFile, manifest.recordFile);
  await assert.rejects(select({ sha: "d".repeat(40) }), /尚无当前有效/);
  f.ciState.otherJobFailed = true; await assert.rejects(select(), /CI当前/); f.ciState.otherJobFailed = false;
  const originalManifest = readFileSync(completed.published[0].manifestFile); const alteredManifest = read(completed.published[0].manifestFile); alteredManifest.recordFile = path.join(path.dirname(f.root), "outside.json"); write(completed.published[0].manifestFile, alteredManifest); await assert.rejects(select(), /批准证据根/); writeFileSync(completed.published[0].manifestFile, originalManifest);
  f.ciState.testsJobId = 64; const newestSource = await f.recollect("newer-pending-ci"); await createCiReview({ configFile: ciConfigFile, sourceFile: newestSource.sourceFile, outDir: path.join(f.root, "chain-review-4"), now: now.getTime() }); await assert.rejects(select(), /尚无当前有效/);
  evidence("automatic-build-review-selection", { selectByActualSha: true, dynamicRecordPathCopiedByHuman: false, independentSignatureVerified: true, currentCiRequeried: true, missingShaBlocked: true, changedRequiredJobBlocked: true, outsideEvidenceRootBlocked: true, newerPendingReviewSupersedesOldFormal: true, liveChecksArchived: true, centralPublicationDirectoryReadOnly: true });
  evidence("ci-review-repair-revalidation", { registeredAutomatically: true, dimensions: 9, withoutAuthorizationPublished: 0, identityFlow: "OIDC-PKCE-isolated-signed-id-token", independentNineDecisions: true, failedRequiredJobBlockedOldApproval: true, missingNewApprovalAfterRepairPublished: 0, originalReviewsRetained: true, freshReviewAuthorizedAndPublished: true, repeatedPublication: "reused-immutable-record", realCIQueried: false, realFeishuSent: false });
});

test("真实CLI摘要不泄露正文/信任详情；Jenkins原脚本在无当前Review时输出阻断报告且准备/构建阶段不可到达", (t) => {
  const f = fixture(t, new Date()), cli = path.resolve(import.meta.dirname, "../../bin/wl-skills-gate.js");
  const args = [cli, "verify-release-review", "--config", f.review.trustFile, "--project", "demo", "--sha", sha, "--record", f.review.recordFile, "--evidence-root", f.review.evidenceRoot];
  const accepted = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.equal(accepted.status, 0, accepted.stderr); const summary = JSON.parse(accepted.stdout); assert.equal(summary.status, "verified"); assert.equal(summary.record, undefined); assert.equal(summary.trust, undefined);
  const template = readFileSync(path.resolve(import.meta.dirname, "../../templates/ci/Jenkinsfile"), "utf8"), start = template.indexOf("stage('Verify this checkout"), prepare = template.indexOf("stage('Prepare approved dependencies')"), build = template.indexOf("stage('Build approved artifact')"); assert(start >= 0 && start < prepare && prepare < build);
  const stage = template.slice(start, prepare), script = stage.match(/sh '''([\s\S]*?)'''/)[1];
  const publicationDir = path.join(f.dir, "empty-publications"), catalogFile = path.join(f.dir, "catalog.json"); mkdirSync(publicationDir); write(catalogFile, { schemaVersion: 1, reviews: {} }); const trust = read(f.review.trustFile); Object.assign(trust.projects.demo, { evidenceRoots: [f.dir], collectorConfigFile: path.join(f.dir, "collector.json"), controlCatalogFile: catalogFile }); write(f.review.trustFile, trust);
  const rejected = spawnSync("sh", ["-c", script], { cwd: f.dir, encoding: "utf8", env: { ...process.env, WL_APPROVED_GATE_CLI: cli, WL_APPROVED_REVIEW_TRUST_CONFIG: f.review.trustFile, WL_APPROVED_REVIEW_PUBLICATION_DIR: publicationDir, WL_PROJECT: "demo", WL_CHECKED_SHA: sha } }); assert.notEqual(rejected.status, 0); const report = read(path.join(f.dir, "quality-reports/release-review-verification.json")); assert.equal(report.status, "blocked"); assert.equal(report.stage, "before-prepare-and-build"); assert.match(readFileSync(path.join(f.dir, "quality-reports/release-review-verification.log"), "utf8"), /尚无当前有效/);
  evidence("jenkins-before-build-guard", { actualTemplateShellExecuted: true, cliSignaturePositiveControl: true, missingCurrentReviewExit: rejected.status, blockedReportArchived: true, guardBeforeDependencyPreparation: true, guardBeforeArtifactBuild: true, summaryIncludesPrivateKeyOrBody: false, realJenkinsMutated: false });
});

test("直接给旧正式Review文件也不能绕过当前版本；新发布/部署拒绝，显式历史复验只消费原签名", (t) => {
  const f = fixture(t), ciFile = path.join(f.dir, "ci-source.json"), collectorFile = path.join(f.dir, "collector.json"), catalogFile = path.join(f.dir, "catalog.json"), key = `demo:standard:${sha}`;
  write(ciFile, { schemaVersion: 1, system: "gitlab", project: "demo", scope: "standard", baseUrl: "https://ci.example.invalid", tokenEnv: "CI_TOKEN", ref: "uat", requiredJobs: ["quality"], artifacts: { job: "quality", paths: ["summary.json"] }, qualitySummary: "summary.json", projectId: 12, trustedRunnerIds: [77] });
  const trust = read(f.review.trustFile); write(collectorFile, { schemaVersion: 1, project: "demo", ciConfigFile: ciFile, reviewPolicyHash: trust.projects.demo.reviewPolicyHash, allowedAuthorIds: ["author-demo"], evidence: [] });
  Object.assign(trust.projects.demo, { evidenceRoots: [f.dir], collectorConfigFile: collectorFile, controlCatalogFile: catalogFile }); write(f.review.trustFile, trust);
  const first = { reviewId: "first", project: "demo", recordFile: f.review.draft.recordFile, recordHash: hash(readFileSync(f.review.draft.recordFile)) }, catalog = { schemaVersion: 1, reviews: { first }, latest: { [key]: { reviewId: "first", recordHash: first.recordHash } } }; write(catalogFile, catalog);
  assert.equal(f.validate().components.length, 1); const set = f.release(), options = { releaseSetFile: set.releaseSetFile, expectReleaseSetHash: set.releaseSetHash, publicKeyFile: f.keys.release.publicKeyFile, expectIssuer: "release-signer", reviewConfigFile: f.review.trustFile, env: "uat", now };
  const current = createReviewDraft({ input: { schemaVersion: 1, kind: "review-input", project: "demo", authorId: "author-demo", candidateSha: sha, policyFile: "policy.json", evidence: f.review.record.content.evidence, notes: { ui: "New isolated pending review note requires its own independent confirmation" } }, evidenceRoot: f.review.evidenceRoot, outDir: path.join(f.review.evidenceRoot, "new-pending"), now });
  catalog.reviews.current = { reviewId: "current", project: "demo", recordFile: current.recordFile, recordHash: hash(readFileSync(current.recordFile)) }; catalog.latest[key] = { reviewId: "current", recordHash: catalog.reviews.current.recordHash }; write(catalogFile, catalog);
  assert.throws(() => f.validate(), /当前 Review 已变化/); assert.throws(() => verifyReleaseSet(options), /当前 Review 已变化/); assert.equal(verifyReleaseSet({ ...options, allowHistoricalReview: true }).ok, true);
  evidence("direct-old-review-bypass-blocked", { directOldFormalInputBlocked: true, ordinaryReleaseSetConsumptionBlocked: true, explicitHistoricalVerificationStillValid: true, createReleaseSetHasHistoricalBypassFlag: false, historicalReviewGrantsDeploymentOrClosure: false });
});
