import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync } from "node:crypto";
import { collectCiSource } from "../../lib/ci-source.js";
import { signCollectedReleaseProof } from "../../lib/lifecycle-source.js";
import { signRecord } from "../../lib/evidence.js";
import { buildReleaseInputPlan, applyReleaseInputPlan } from "../../lib/release-input.js";
import { validateReleaseSetInput, createReleaseSet, verifyReleaseSet } from "../../lib/release-set.js";
import { createReleaseReviewFixture } from "../test-support/release-review-fixture.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
const read = (file) => JSON.parse(readFileSync(file));
const files = (root) => readdirSync(root, { recursive: true }).sort();
async function fixture(t, system = "gitlab", emptyConfig = false) {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-release-input-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "release-evidence"), configFile = path.join(dir, "input-config.json"), now = new Date(), fixed = "a".repeat(64), origin = "https://ci.example.invalid";
  mkdirSync(root);
  const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, "proof-private.pem"), publicKeyFile = path.join(root, "keys/proof-public.pem");
  writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" })); mkdirSync(path.dirname(publicKeyFile)); writeFileSync(publicKeyFile, pair.publicKey.export({ type: "spki", format: "pem" }));
  const config = { schemaVersion: 1, kind: "release-input-config", releaseSetId: "produce-20261015", environment: "uat", evidenceRoot: "release-evidence", outputFile: "generated/release-set-input.json", reviewConfigFile: "release-evidence/release-review-trust.json", components: [], compatibilityFile: "compatibility/declaration.json" };
  for (const [index, project, role] of [[0, "wl-produce", "backend"], [1, "wl-ui-produce", "frontend"]]) {
    const sha = (index ? "b" : "c").repeat(40), authorId = `author-${project}`, jobPath = `${project}/build`;
    const summary = { schemaVersion: 1, run: { project, profile: "release", targetEnv: "uat", commitSha: sha, eventId: `${project}-1`, startedAt: now.toISOString(), durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: fixed }, policy: { policyHash: fixed, ruleSetHash: fixed, baselineHash: fixed, waiversHash: fixed, requiredCheckIds: ["CHECK"], checksSelected: 1, lockedToolVersions: { CHECK: "fixture@1" } }, checks: [{ checkId: "CHECK", status: "ok", required: true, toolVersionVerified: true, toolVersion: "fixture@1" }], findings: [], counts: { blockingNew: 0 }, decision: { status: "passed", reasons: [] } };
    const binary = Buffer.from([0, 255, 26, index]), runtime = emptyConfig ? "" : "runtime: fixture\n", manifest = { schemaVersion: 1, project, commitSha: sha, sourceDigest: fixed, targetEnv: "uat", createdAt: now.toISOString(), artifacts: [{ path: "build/app.bin", sha256: hash(binary) }], configFiles: [{ path: "deploy/runtime.yaml", sha256: hash(runtime) }] };
    const content = { "quality/summary.json": JSON.stringify(summary), "release/manifest.json": JSON.stringify(manifest), "build/app.bin": binary, "deploy/runtime.yaml": runtime };
    const sourceConfigFile = path.join(root, `sources/${project}.json`), outDir = path.join(root, `collected/${project}`), requestFile = path.join(dir, `${project}-request.json`);
    const sourceConfig = { schemaVersion: 1, system, project, scope: "standard", baseUrl: origin, tokenEnv: "CI_TOKEN", ref: system === "gitlab" ? "uat" : "origin/uat", requiredJobs: system === "gitlab" ? ["quality", "build"] : [jobPath], artifacts: { job: system === "gitlab" ? "build" : jobPath, paths: Object.keys(content) }, qualitySummary: "quality/summary.json", ...(system === "gitlab" ? { projectId: 12, trustedRunnerIds: [77] } : { jobPath, userEnv: "CI_USER", jobConfigHash: hash("<flow-definition/>") }) };
    write(sourceConfigFile, sourceConfig); write(requestFile, { sha, runId: 45, sequence: index + 1, authorId });
    const pipeline = { id: 45, project_id: 12, sha, ref: "uat", web_url: `${origin}/p/45` };
    const jobs = ["quality", "build"].map((name, i) => ({ id: 60 + i, name, pipeline: { id: 45 }, commit: { id: sha }, ref: "uat", runner: { id: 77 }, allow_failure: false, status: "success", web_url: `${origin}/j/${60 + i}` }));
    const build = { number: 45, building: false, result: "SUCCESS", actions: [{ lastBuiltRevision: { SHA1: sha, branch: [{ name: "origin/uat", SHA1: sha }] } }], artifacts: Object.keys(content).map((relativePath) => ({ relativePath })) };
    const collected = await collectCiSource({ configFile: sourceConfigFile, requestFile, outDir, now: now.getTime(), env: { CI_TOKEN: "secret", CI_USER: "reader" }, fetchImpl: async (url) => {
      const route = new URL(url).pathname;
      if (route.endsWith("/config.xml")) return new Response("<flow-definition/>");
      for (const [file, bytes] of Object.entries(content)) if (route.endsWith(`/artifacts/${file}`) || route.endsWith(`/artifact/${file}`)) return new Response(bytes);
      const value = route.endsWith("/pipelines/45") ? pipeline : route.endsWith("/jobs") ? jobs : route.endsWith("/jobs/61") ? jobs[1] : route.endsWith("/api/json") ? build : null;
      assert.ok(value, `unexpected fixture route: ${route}`); return new Response(JSON.stringify(value));
    } });
    const proofFile = path.join(root, `proofs/${project}.json`);
    signCollectedReleaseProof({ configFile: sourceConfigFile, sourceFile: collected.sourceFile, manifestPath: "release/manifest.json", env: "uat", sha, outFile: proofFile, privateKeyFile, issuer: "component-signer", expectPolicyHash: fixed, expectRulesHash: fixed, expectBaselineHash: fixed, expectWaiversHash: fixed, now: now.getTime() });
    const artifactRoot = `collected/${project}/artifacts`;
    const review = createReleaseReviewFixture({ root, project, sha, summary, now, authorId });
    config.components.push({ reviewFile: path.relative(root, review.recordFile), reviewEvidenceRoot: path.relative(root, review.evidenceRoot), project, scope: "standard", role, authorId, sourceConfigFile: `sources/${project}.json`, sourceConfigHash: hash(readFileSync(sourceConfigFile)), sourceFile: `collected/${project}/source.json`, proofFile: `proofs/${project}.json`, publicKeyFile: "keys/proof-public.pem", publicKeyHash: hash(readFileSync(publicKeyFile)), manifestFile: `${artifactRoot}/release/manifest.json`, summaryFile: `${artifactRoot}/quality/summary.json`, artifactRoot, expectIssuer: "component-signer", expectPolicyHash: fixed, expectRulesHash: fixed, expectBaselineHash: fixed, expectWaiversHash: fixed });
  }
  write(path.join(root, "compatibility/openapi.json"), { openapi: "3.0.3", info: { version: "v1" }, paths: { "/health": { get: {} } } });
  writeFileSync(path.join(root, "compatibility/review.txt"), "Fixture release owner reviewed this exact pair: API, no database change, deployment order and recovery constraints.");
  const ref = (file) => ({ file: `compatibility/${file}` });
  const declaration = { api: { type: "contract", version: "v1", evidence: ref("openapi.json"), reviewEvidence: ref("review.txt") }, database: { mode: "none", schemaVersion: "schema-1", reason: "No entity or SQL changes in this isolated pair", reviewEvidence: ref("review.txt") }, deploymentOrder: ["wl-produce", "wl-ui-produce"], rollback: { mode: "compatible", reason: "No schema changes; previous artifact pair remains compatible", reviewEvidence: ref("review.txt") } };
  const declarationFile = path.join(root, config.compatibilityFile); write(declarationFile, declaration); write(configFile, config);
  const options = { configFile, now }, output = path.join(root, config.outputFile);
  return { dir, root, now, reviewConfigFile: path.join(root, "release-review-trust.json"), config, configFile, output, options, declaration, declarationFile, privateKeyFile, publicKeyFile, saveConfig: () => write(configFile, config), saveDeclaration: () => write(declarationFile, declaration) };
}
for (const system of ["gitlab", "jenkins"]) test(`${system}真实采集→组件签发→自动组合预览→摘要确认生成→原签发器验收`, async (t) => {
  const f = await fixture(t, system), before = files(f.dir), plan = buildReleaseInputPlan(f.options);
  assert.equal(plan.status, "preview"); assert.equal(plan.written, false); assert.equal(plan.signed, false); assert.equal(plan.approved, false); assert.equal(existsSync(f.output), false); assert.deepEqual(files(f.dir), before);
  assert(plan.summary.components.every((component) => component.reviewId && component.reviewerId === "independent-reviewer" && /^[a-f0-9]{64}$/.test(component.reviewDigest)));
  assert.equal(plan.configHash, hash(readFileSync(f.configFile))); assert.equal(plan.inputHash, hash(JSON.stringify(plan.input, null, 2) + "\n")); assert.equal(plan.input.components.length, 2);
  assert.equal(plan.input.components[0].sha, "c".repeat(40)); assert.equal(plan.input.components[0].expectPipelineId, "45"); assert.equal(plan.input.components[0].expectJobId, system === "gitlab" ? "61" : "45");
  assert.equal(plan.input.compatibility.api.evidence.sha256, hash(readFileSync(path.join(f.root, "compatibility/openapi.json"))));
  const created = applyReleaseInputPlan({ ...f.options, expectConfigHash: plan.configHash, expectInputHash: plan.inputHash }); assert.equal(created.written, true); assert.equal(created.signed, false); assert.equal(hash(readFileSync(f.output)), plan.inputHash);
  const signed = createReleaseSet({ inputFile: f.output, evidenceRoot: f.root, reviewConfigFile: f.reviewConfigFile, expectInputHash: plan.inputHash, privateKeyFile: f.privateKeyFile, issuer: "release-signer", outFile: path.join(f.dir, "release-set.json"), now: f.now });
  assert.equal(verifyReleaseSet({ releaseSetFile: signed.releaseSetFile, publicKeyFile: f.publicKeyFile, reviewConfigFile: f.reviewConfigFile, expectIssuer: "release-signer", expectReleaseSetHash: signed.releaseSetHash, env: "uat", now: f.now }).ok, true);
  assert.throws(() => applyReleaseInputPlan({ ...f.options, expectConfigHash: plan.configHash, expectInputHash: plan.inputHash }), /已存在/);
});
test("签名前共用纯验证无需私钥、不落盘，坏证明不能经预览放行", async (t) => {
  const f = await fixture(t), plan = buildReleaseInputPlan(f.options), before = files(f.dir);
  assert.equal(validateReleaseSetInput({ input: plan.input, evidenceRoot: f.root, reviewConfigFile: f.reviewConfigFile, now: f.now }).components.length, 2); assert.deepEqual(files(f.dir), before);
  const proofFile = path.join(f.root, f.config.components[0].proofFile), proof = read(proofFile); proof.candidateSha = "d".repeat(40); write(proofFile, signRecord(proof, f.privateKeyFile));
  assert.throws(() => validateReleaseSetInput({ input: plan.input, evidenceRoot: f.root, reviewConfigFile: f.reviewConfigFile, now: f.now }), /组件.*证据无效/); assert.throws(() => buildReleaseInputPlan(f.options), /组件.*证据无效/); assert.equal(existsSync(f.output), false);
});
test("真实清单中的空配置原件按实际字节验证，不增加未声明的非空约束", async (t) => {
  const f = await fixture(t, "gitlab", true), plan = buildReleaseInputPlan(f.options);
  assert.equal(plan.input.components.length, 2);
  assert.equal(plan.input.inputProvenance.originals.filter((entry) => entry.file.endsWith("deploy/runtime.yaml") && entry.bytes === 0 && entry.sha256 === hash("")).length, 2);
});
test("确认绑定配置真实字节和全部原件，旧确认不能生成新输入", async (t) => {
  const f = await fixture(t), plan = buildReleaseInputPlan(f.options), approvals = { expectConfigHash: plan.configHash, expectInputHash: plan.inputHash };
  assert.throws(() => applyReleaseInputPlan(f.options), /明确确认/);
  writeFileSync(f.configFile, readFileSync(f.configFile, "utf8") + "\n");
  assert.throws(() => applyReleaseInputPlan({ ...f.options, ...approvals }), /旧 configHash/); assert.equal(existsSync(f.output), false);
  f.saveConfig(); f.declaration.rollback.reason = "Release owner revised the recovery constraints"; f.saveDeclaration();
  assert.throws(() => applyReleaseInputPlan({ ...f.options, ...approvals }), /旧 inputHash/); assert.equal(existsSync(f.output), false);
});
for (const [name, mutate] of [
  ["项目", (f, e) => e.project = "other"], ["角色", (f, e) => e.role = "unknown"], ["范围", (f, e) => e.scope = "other"], ["作者缺失", (f, e) => delete e.authorId], ["作者不符", (f, e) => e.authorId = "different-author"],
  ["错误SHA", (f, e) => e.sha = "e".repeat(40)], ["错误政策", (f, e) => e.expectPolicyHash = "0".repeat(64)], ["采集配置摘要", (f, e) => e.sourceConfigHash = "0".repeat(64)], ["公钥摘要", (f, e) => e.publicKeyHash = "0".repeat(64)],
  ["非采集制品目录", (f, e) => e.artifactRoot = "other/artifacts"], ["源码报告替换", (f, e) => e.summaryFile = e.manifestFile], ["执行命令", (f, e) => e.command = "do-not-execute"],
]) test(`自动构造拒绝${name}，不写输入`, async (t) => { const f = await fixture(t); mutate(f, f.config.components[0]); f.saveConfig(); assert.throws(() => buildReleaseInputPlan(f.options)); assert.equal(existsSync(f.output), false); });
test("真实二进制/配置/报告/来源篡改及过期均中止，不吞错变成功", async (t) => {
  for (const mode of ["binary", "runtime", "summary", "source", "expired"]) {
    const f = await fixture(t), entry = f.config.components[0], plan = buildReleaseInputPlan(f.options);
    if (mode === "binary") writeFileSync(path.join(f.root, entry.artifactRoot, "build/app.bin"), "changed");
    if (mode === "runtime") writeFileSync(path.join(f.root, entry.artifactRoot, "deploy/runtime.yaml"), "changed");
    if (mode === "summary") writeFileSync(path.join(f.root, entry.summaryFile), readFileSync(path.join(f.root, entry.summaryFile), "utf8") + "\n");
    if (mode === "source") { const value = read(path.join(f.root, entry.sourceFile)); value.jobStatus = "failed"; write(path.join(f.root, entry.sourceFile), value); }
    const options = { ...f.options, expectConfigHash: plan.configHash, expectInputHash: plan.inputHash, ...(mode === "expired" ? { now: new Date(f.now.getTime() + 2 * 86400000) } : {}) };
    assert.throws(() => applyReleaseInputPlan(options)); assert.equal(existsSync(f.output), false);
  }
});
test("原始API/数据库/顺序/回退要求由发布负责人声明，缺项不得补猜", async (t) => {
  for (const mode of ["missing-api", "missing-db", "order", "api-version", "wrong-digest", "bad-api", "failed-api-test", "recovery"]) {
    const f = await fixture(t), d = f.declaration;
    if (mode === "missing-api") delete d.api;
    if (mode === "missing-db") delete d.database;
    if (mode === "order") d.deploymentOrder = ["wl-produce", "wl-produce"];
    if (mode === "api-version") d.api.version = "v2";
    if (mode === "wrong-digest") d.api.evidence.sha256 = "0".repeat(64);
    if (mode === "bad-api") writeFileSync(path.join(f.root, "compatibility/openapi.json"), "{}");
    if (mode === "failed-api-test") { writeFileSync(path.join(f.root, "compatibility/api-tests.xml"), '<testsuite tests="1" failures="1"><testcase name="contract"><failure/></testcase></testsuite>'); d.api.type = "compatibility-test"; d.api.evidence = { file: "compatibility/api-tests.xml" }; }
    if (mode === "recovery") d.rollback.mode = "requires-approved-recovery";
    f.saveDeclaration(); assert.throws(() => buildReleaseInputPlan(f.options)); assert.equal(existsSync(f.output), false);
  }
});
test("非向后兼容DB迁移必须有迁移与恢复原件，自动计算摘要后可供原校验器验收", async (t) => {
  const f = await fixture(t), ref = (file) => ({ file: `compatibility/${file}` });
  writeFileSync(path.join(f.root, "compatibility/migrate.sql"), "ALTER TABLE fixture DROP COLUMN old;\n"); writeFileSync(path.join(f.root, "compatibility/recovery.sql"), "-- approved isolated restore procedure\n");
  f.declaration.database = { mode: "migrate", fromSchema: "schema-1", toSchema: "schema-2", backwardCompatible: false, migrations: [ref("migrate.sql")], reviewEvidence: ref("review.txt") }; f.saveDeclaration();
  assert.throws(() => buildReleaseInputPlan(f.options), /非向后兼容/);
  f.declaration.rollback = { mode: "requires-approved-recovery", reason: "Restore approved snapshot before old binaries", reviewEvidence: ref("review.txt"), recoveryEvidence: ref("recovery.sql") }; f.saveDeclaration();
  const plan = buildReleaseInputPlan(f.options); assert.equal(plan.summary.schemaVersion, "schema-2"); assert.equal(plan.input.compatibility.rollback.recoveryEvidence.sha256, hash(readFileSync(path.join(f.root, "compatibility/recovery.sql"))));
});
test("输出越界、链接、断链、证据链接和已存在输出都拒绝且保留原文件", async (t) => {
  for (const mode of ["escape", "absolute", "link", "broken-link", "original-link", "root-link", "existing"]) {
    const f = await fixture(t), entry = f.config.components[0];
    if (mode === "escape") f.config.outputFile = "../outside.json";
    if (mode === "absolute") f.config.outputFile = path.join(f.dir, "outside.json");
    if (["link", "broken-link"].includes(mode)) { mkdirSync(path.dirname(f.output)); symlinkSync(path.join(f.dir, mode === "link" ? "input-config.json" : "absent.json"), f.output); }
    if (mode === "original-link") { const file = path.join(f.root, entry.proofFile); rmSync(file); symlinkSync(f.publicKeyFile, file); }
    if (mode === "root-link") { symlinkSync(f.root, path.join(f.dir, "root-link")); f.config.evidenceRoot = "root-link"; }
    if (mode === "existing") { mkdirSync(path.dirname(f.output)); writeFileSync(f.output, "approved-existing-input"); }
    f.saveConfig(); assert.throws(() => buildReleaseInputPlan(f.options));
    if (mode === "existing") assert.equal(readFileSync(f.output, "utf8"), "approved-existing-input");
    assert.equal(existsSync(path.join(f.dir, "outside.json")), false);
  }
});
test("批准后 source.json 原始字节变化不能复用旧确认，即使业务字段未变", async (t) => {
  const f = await fixture(t), plan = buildReleaseInputPlan(f.options), sourceFile = path.join(f.root, f.config.components[0].sourceFile);
  writeFileSync(sourceFile, readFileSync(sourceFile, "utf8") + "\n");
  assert.throws(() => applyReleaseInputPlan({ ...f.options, expectConfigHash: plan.configHash, expectInputHash: plan.inputHash }), /旧 inputHash/); assert.equal(existsSync(f.output), false);
});
test("自动输入落盘后至签名前，全部原件仍按已批准真实字节复核", async (t) => {
  const f = await fixture(t), plan = buildReleaseInputPlan(f.options);
  applyReleaseInputPlan({ ...f.options, expectConfigHash: plan.configHash, expectInputHash: plan.inputHash });
  const sourceFile = path.join(f.root, f.config.components[0].sourceFile); writeFileSync(sourceFile, readFileSync(sourceFile, "utf8") + "\n");
  const outFile = path.join(f.dir, "must-not-sign.json");
  assert.throws(() => createReleaseSet({ inputFile: f.output, evidenceRoot: f.root, reviewConfigFile: f.reviewConfigFile, expectInputHash: plan.inputHash, issuer: "release-signer", privateKeyFile: "not-a-key.pem", outFile, now: f.now }), /原件字节发生变化/);
  assert.equal(existsSync(outFile), false);
});
test("自动输入原件绑定不能漏必需文件、重复、越界或伪造字节数", async (t) => {
  const f = await fixture(t), plan = buildReleaseInputPlan(f.options);
  for (const change of [
    (value) => value.inputProvenance.originals = value.inputProvenance.originals.filter((entry) => entry.file !== value.components[0].summaryFile),
    (value) => value.inputProvenance.originals.push(value.inputProvenance.originals[0]),
    (value) => value.inputProvenance.originals[0].file = "../outside.json",
    (value) => value.inputProvenance.originals[0].bytes += 1,
    (value) => value.inputProvenance.configHash = "unknown",
  ]) {
    const input = structuredClone(plan.input); change(input);
    assert.throws(() => validateReleaseSetInput({ input, evidenceRoot: f.root, reviewConfigFile: f.reviewConfigFile, now: f.now }));
  }
});
test("中央固定交付目录按两仓实际SHA自动选正式Review，不填动态文件名；新待确认版本使旧输入失效", async (t) => {
  const f = await fixture(t), catalogFile = path.join(f.root, "review-catalog.json"), publicationDir = path.join(f.root, "review-delivery"), catalog = { schemaVersion: 1, reviews: {}, latest: {} }, trust = read(f.reviewConfigFile);
  for (const entry of f.config.components) {
    const recordFile = path.join(f.root, entry.reviewFile), evidenceRoot = path.join(f.root, entry.reviewEvidenceRoot), formal = read(recordFile), draftRecordFile = path.join(evidenceRoot, "draft/review-draft.json"), provenanceFile = path.join(evidenceRoot, "publication-provenance.json"), registrationId = `${entry.project}-${formal.candidateSha.slice(0, 8)}`, collectorConfigFile = path.join(evidenceRoot, "collector.json");
    write(collectorConfigFile, { schemaVersion: 1, project: entry.project, ciConfigFile: path.join(f.root, entry.sourceConfigFile), reviewPolicyHash: trust.projects[entry.project].reviewPolicyHash, allowedAuthorIds: [entry.authorId], evidence: [] });
    // Isolated fixed publication metadata; the formal Review and nine-dimension
    // authorization signatures were produced by the real Review functions.
    write(provenanceFile, { kind: "isolated-publication-metadata", project: entry.project });
    const recordHash = hash(readFileSync(draftRecordFile)), provenanceHash = hash(readFileSync(provenanceFile));
    catalog.reviews[registrationId] = { reviewId: registrationId, project: entry.project, recordFile: draftRecordFile, evidenceRoot, recordHash, provenanceFile, provenanceHash };
    catalog.latest[`${entry.project}:standard:${formal.candidateSha}`] = { reviewId: registrationId, recordHash };
    Object.assign(trust.projects[entry.project], { evidenceRoots: [f.root], collectorConfigFile, controlCatalogFile: catalogFile });
    write(path.join(publicationDir, `${registrationId}.json`), { schemaVersion: 1, kind: "published-review-manifest", project: entry.project, scope: "standard", candidateSha: formal.candidateSha, registrationId, recordFile, evidenceRoot, recordHash: hash(readFileSync(recordFile)), draftRecordFile, provenanceFile, provenanceHash, collectorConfigFile, authorId: formal.authorId, reviewerId: formal.reviewerId });
    delete entry.reviewFile; delete entry.reviewEvidenceRoot; entry.reviewPublicationDir = "review-delivery";
  }
  write(f.reviewConfigFile, trust); write(catalogFile, catalog); f.saveConfig();
  const plan = buildReleaseInputPlan(f.options); assert.equal(plan.input.components.length, 2); assert(plan.input.components.every((entry) => entry.reviewPublicationFile?.startsWith("review-delivery/") && entry.reviewFile?.endsWith("formal.json")));
  assert(plan.input.inputProvenance.originals.some((entry) => entry.file.startsWith("review-delivery/")));
  const component = plan.input.components[0]; catalog.latest[`${component.project}:standard:${component.sha}`] = { reviewId: "new-pending-version" }; write(catalogFile, catalog);
  assert.throws(() => applyReleaseInputPlan({ ...f.options, expectConfigHash: plan.configHash, expectInputHash: plan.inputHash }), /尚无当前有效/); assert.equal(existsSync(f.output), false);
});
