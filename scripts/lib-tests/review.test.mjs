import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReviewDraft, buildReviewInput, compareReviewSummaries, REVIEW_DIMENSIONS, validateReviewOutputLocation } from "../../lib/review.js";
import { signReviewRecord, verifyReview, signRecord } from "../../lib/evidence.js";
import { sha256, stableStringify } from "../../lib/util.js";

const sha = "b".repeat(40), previousSha = "a".repeat(40), hash = "c".repeat(64);
const now = new Date("2026-10-15T01:00:00Z");
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2));
function fixture(t, mutate = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wl-review-v2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519"), privateKeyFile = path.join(dir, "key.pem"), publicKeyFile = path.join(dir, "public.pem");
  writeFileSync(privateKeyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(publicKeyFile, pair.publicKey.export({ type: "spki", format: "pem" }));
  const identityKeys = generateKeyPairSync("ed25519"), authorizationPrivateKeyFile = path.join(dir, "identity-key.pem"), authorizationPublicKeyFile = path.join(dir, "identity-public.pem");
  writeFileSync(authorizationPrivateKeyFile, identityKeys.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(authorizationPublicKeyFile, identityKeys.publicKey.export({ type: "spki", format: "pem" }));
  const summary = { schemaVersion: 1, run: { project: "demo", profile: "standard", commitSha: sha, startedAt: now.toISOString(),
    durationMs: 10, tool: "gate", eventId: "run-after", sourceBound: true, sourceDigest: hash },
    policy: { policyHash: hash, ruleSetHash: hash, baselineHash: hash, waiversHash: hash, requiredCheckIds: ["SCAN"],
      lockedToolVersions: { SCAN: "scanner@1" }, checksSelected: 1 },
    checks: [{ checkId: "SCAN", required: true, tool: "cmd-json", status: "ok", toolVersion: "scanner@1", toolVersionVerified: true }],
    findings: [], decision: { status: "passed", reasons: [] } };
  const policy = { schemaVersion: 1, project: "demo", dimensions: REVIEW_DIMENSIONS.map((d) => ({ id: d.id, applicable: true,
    requiredEvidenceTypes: [d.id === "scan" || d.id === "coding" ? "gate-summary" : `${d.id}-evidence`] })) };
  const input = { schemaVersion: 1, kind: "review-input", project: "demo", authorId: "author", candidateSha: sha,
    source: "dev-409322-feature", target: "dev", sourceSha: sha, targetBeforeSha: previousSha, policyFile: "review-policy.json",
    evidence: [{ id: "gate", type: "gate-summary", source: "isolated-test/job/1", project: "demo", candidateSha: sha,
      file: "quality-summary.json", dimensionIds: ["coding", "scan"] },
      ...REVIEW_DIMENSIONS.filter((d) => !["coding", "scan"].includes(d.id)).map((d) => ({ id: d.id, type: `${d.id}-evidence`,
        source: "isolated-test/verified-by-reviewer", project: "demo", candidateSha: sha, file: `${d.id}.txt`, dimensionIds: [d.id] }))] };
  for (const e of input.evidence.filter((e) => e.type !== "gate-summary")) writeFileSync(path.join(dir, e.file), `isolated ${e.id} facts; not business evidence`);
  mutate({ input, policy, summary, dir });
  write(path.join(dir, "quality-summary.json"), summary); write(path.join(dir, "review-policy.json"), policy);
  const inputFile = path.join(dir, "input.json"); write(inputFile, input);
  const pins = { project: "demo", sha, expectPolicyHash: hash, expectRulesHash: hash, expectBaselineHash: hash,
    expectWaiversHash: hash, expectReviewPolicyHash: sha256(stableStringify(policy)), evidenceRoot: dir, now,
    privateKeyFile, publicKeyFile, reviewerId: "reviewer", authorId: "author", authorizationPublicKeyFile, expectAuthorizationIssuer: "identity-authority" };
  let draftNumber = 0;
  const draft = () => createReviewDraft({ inputFile, outDir: path.join(dir, `review-${draftNumber++}`), evidenceRoot: dir, now });
  const authorize = (recordFile) => {
    const record = JSON.parse(readFileSync(recordFile));
    const authorization = { schemaVersion: 1, kind: "review-authorization", authorizationId: "approval-1", identitySource: "isolated authenticated reviewer fixture",
      issuer: "identity-authority", scope: "review-publish", decision: "approved", actorId: "reviewer", authorId: "author", project: "demo", candidateSha: sha,
      reviewDigest: record.reviewDigest, bodyDigest: record.bodyDigest, evidenceDigest: record.evidenceDigest,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), reason: "独立逐维复核完成",
      dimensionDecisions: record.content.dimensions.map((d) => ({ id: d.id, decision: d.applicable ? "approved" : "not-applicable", reason: "已查看原始证据与变更影响" })) };
    const authorizationFile = path.join(dir, "authorization.json"); write(authorizationFile, signRecord(authorization, authorizationPrivateKeyFile));
    return { authorizationFile, authorization };
  };
  const sign = (recordFile, changes = {}) => signReviewRecord({ ...pins, recordFile, ...authorize(recordFile), ...changes });
  const signed = (record) => { const file = path.join(dir, "signed-review.json"); write(file, record); return file; };
  return { dir, input, policy, summary, inputFile, pins, draft, authorize, sign, signed, authorizationPrivateKeyFile };
}

test("九维草稿始终待确认；独立逐维授权后核验正文和原始证据", (t) => {
  const f = fixture(t), draft = f.draft();
  assert.equal(draft.status, "pending-confirmation"); assert.equal(draft.approved, false);
  assert.equal(draft.dimensions.length, 9); assert.ok(draft.dimensions.every((d) => d.status === "evidence-ready"));
  const signed = f.sign(draft.recordFile), verified = verifyReview({ ...f.pins, recordFile: f.signed(signed) });
  assert.equal(verified.decision, "approved");
  for (const flag of ["repairAuthorized", "promotionAuthorized", "deploymentAuthorized", "closureAuthorized"]) assert.equal(verified[flag], false);
});

test("只交扫描报告不能替代九维Review；草稿显示缺项且拒绝签发", (t) => {
  const f = fixture(t, ({ input }) => { input.evidence = input.evidence.filter((e) => e.type === "gate-summary"); });
  const draft = f.draft(); assert.equal(draft.dimensions.filter((d) => d.status === "pending-evidence").length, 7);
  assert.throws(() => f.sign(draft.recordFile), /仍缺证据/);
});

test("适用策略省略任一维度即拒绝", (t) => {
  const f = fixture(t, ({ policy }) => policy.dimensions.pop()); assert.throws(f.draft, /逐项声明九维/);
});

test("N/A须策略事实且独立逐维批准；不能用N/A绕过Review或门禁", (t) => {
  const f = fixture(t, ({ policy }) => { const ui = policy.dimensions.find((d) => d.id === "ui"); ui.applicable = false; ui.reason = "本次为纯后端接口且无UI变更"; });
  const draft = f.draft(), signed = f.sign(draft.recordFile); assert.equal(signed.authorization.dimensionDecisions.find((d) => d.id === "ui").decision, "not-applicable");
  const auth = f.authorize(draft.recordFile); auth.authorization.dimensionDecisions.find((d) => d.id === "ui").decision = "approved"; write(auth.authorizationFile, signRecord(auth.authorization, f.authorizationPrivateKeyFile));
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: draft.recordFile, authorizationFile: auth.authorizationFile }), /N\/A 未批准/);
  const bad = fixture(t, ({ policy }) => { policy.dimensions.find((d) => d.id === "scan").applicable = false; policy.dimensions.find((d) => d.id === "scan").reason = "跳过"; });
  assert.throws(bad.draft, /不能标为不适用/);
});

for (const [label, mutate] of [
  ["自审", (auth) => { auth.actorId = "author"; }], ["授权范围扩展", (auth) => { auth.scope = "deploy"; }],
  ["旧正文", (auth) => { auth.bodyDigest = "d".repeat(64); }], ["错误候选", (auth) => { auth.candidateSha = previousSha; }],
  ["少一维确认", (auth) => { auth.dimensionDecisions.pop(); }], ["授权过期", (auth) => { auth.expiresAt = new Date(now.getTime() - 1).toISOString(); }]
]) test(`拒绝${label}`, (t) => {
  const f = fixture(t), draft = f.draft(), auth = f.authorize(draft.recordFile); mutate(auth.authorization); write(auth.authorizationFile, signRecord(auth.authorization, f.authorizationPrivateKeyFile));
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: draft.recordFile, authorizationFile: auth.authorizationFile }));
});

test("没有明确授权、受控适用策略或九维v2记录均拒绝签发", (t) => {
  const f = fixture(t), draft = f.draft();
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: draft.recordFile }), /独立授权文件/);
  assert.throws(() => f.sign(draft.recordFile, { expectReviewPolicyHash: undefined }), /受控适用策略/);
  const legacy = path.join(f.dir, "legacy.json"); write(legacy, { decision: "approved", authorId: "author", reviewerId: "reviewer", candidateSha: sha, project: "demo", unresolvedBlocking: [] });
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: legacy }), /本轮待确认草稿/);
});

test("正文和原始证据任意字节变化使已签Review失效", (t) => {
  const f = fixture(t), draft = f.draft(), signed = f.signed(f.sign(draft.recordFile));
  const body = readFileSync(draft.bodyFile); writeFileSync(draft.bodyFile, "替换过的正文");
  assert.throws(() => verifyReview({ ...f.pins, recordFile: signed }), /实际正文/);
  writeFileSync(draft.bodyFile, body); writeFileSync(path.join(f.dir, "submission.txt"), "替换过的原始证据");
  assert.throws(() => verifyReview({ ...f.pins, recordFile: signed }), /原始证据已变化/);
});

test("Gate实际阻断、漏执行、工具未验证均不可被人工approved覆盖", (t) => {
  for (const mutate of [(s) => { s.decision.status = "blocked"; }, (s) => { s.checks[0].status = "invalid"; }, (s) => { s.checks[0].toolVersionVerified = false; }]) {
    const f = fixture(t, ({ summary }) => mutate(summary)); assert.throws(() => f.sign(f.draft().recordFile));
  }
});

test("缺失或未经批准的扫描规则摘要不可签发Review", (t) => {
  const f = fixture(t, ({ summary }) => { summary.policy.ruleSetHash = "d".repeat(64); });
  assert.throws(() => f.sign(f.draft().recordFile), /ruleSetHash/);
});

test("Review不授予修复/部署/关闭；已正式记录不能再作草稿签发", (t) => {
  const f = fixture(t), draft = f.draft(), record = JSON.parse(readFileSync(draft.recordFile)); record.deploymentAuthorized = true; write(draft.recordFile, record);
  assert.throws(() => f.sign(draft.recordFile), /不能扩展/);
  const fresh = f.draft(), formal = f.sign(fresh.recordFile), signed = f.signed(formal);
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: signed }), /本轮待确认草稿/);
  write(signed, signRecord({ ...formal, closureAuthorized: true }, f.pins.privateKeyFile));
  assert.throws(() => verifyReview({ ...f.pins, recordFile: signed }), /不能扩展/);
});

test("证据路径越界与符号链接被拒绝", (t) => {
  const f = fixture(t); f.input.evidence[0].file = "../outside.json"; write(f.inputFile, f.input); assert.throws(f.draft, /相对文件/);
  symlinkSync("quality-summary.json", path.join(f.dir, "linked-summary.json")); f.input.evidence[0].file = "linked-summary.json"; write(f.inputFile, f.input);
  assert.throws(f.draft, /符号链接/);
});

test("前后报告同口径才报告可比；规则/范围/工具变化明确标注", (t) => {
  const f = fixture(t), before = structuredClone(f.summary); before.run.commitSha = previousSha;
  before.findings = [{ fingerprint: hash, ruleId: "R", severity: "error", file: "src.java", status: "new" }];
  const same = compareReviewSummaries(before, f.summary); assert.equal(same.comparable, true); assert.equal(same.disappeared.length, 1);
  const changed = structuredClone(f.summary); changed.policy.ruleSetHash = "e".repeat(64); changed.run.scope = "staged";
  const different = compareReviewSummaries(before, changed); assert.equal(different.comparable, false); assert.ok(different.changedBasis.includes("ruleSetHash"));
  assert.match(different.meaning, /不能认定质量改善/);
});

test("授权身份必须来自独立签名receipt，不能自报或共用Review私钥", (t) => {
  const f = fixture(t), draft = f.draft(), auth = f.authorize(draft.recordFile);
  write(auth.authorizationFile, auth.authorization);
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: draft.recordFile, authorizationFile: auth.authorizationFile }), /签名无效/);
  assert.throws(() => f.sign(draft.recordFile, { authorizationPublicKeyFile: f.pins.publicKeyFile }), /密钥必须分离/);
  assert.throws(() => f.sign(draft.recordFile, { expectAuthorizationIssuer: "forged-issuer" }), /issuer不匹配/);
});

test("草稿输出写前拒绝越界、已有目录及符号链接，原始证据不变", (t) => {
  const f = fixture(t), before = readFileSync(path.join(f.dir, "quality-summary.json"));
  const run = (outDir) => createReviewDraft({ inputFile: f.inputFile, evidenceRoot: f.dir, outDir, now });
  assert.throws(() => run(f.dir), /新位置/);
  assert.throws(() => run(path.join(f.dir, "quality-summary.json")), /已存在/);
  const outside = path.join(f.dir, "..", `wl-review-outside-${path.basename(f.dir)}`);
  assert.throws(() => run(outside), /新位置/); assert.equal(existsSync(outside), false);
  mkdirSync(path.join(f.dir, "existing")); assert.throws(() => run(path.join(f.dir, "existing")), /已存在/);
  symlinkSync("existing", path.join(f.dir, "linked")); assert.throws(() => run(path.join(f.dir, "linked", "draft")), /符号链接/);
  assert.deepEqual(readFileSync(path.join(f.dir, "quality-summary.json")), before);
});

test("草稿两文件在新目录一次交付，写锁冲突不留半成品，签发不覆盖证据", (t) => {
  const f = fixture(t), target = path.join(f.dir, "locked-draft"); writeFileSync(`${target}.review-lock`, "held");
  assert.throws(() => createReviewDraft({ inputFile: f.inputFile, evidenceRoot: f.dir, outDir: target, now }), /EEXIST/);
  assert.equal(existsSync(target), false);
  const draft = f.draft(); assert.ok(existsSync(draft.bodyFile) && existsSync(draft.recordFile));
  assert.throws(() => validateReviewOutputLocation({ outFile: path.join(f.dir, "quality-summary.json"), evidenceRoot: f.dir, recordFile: draft.recordFile }), /已存在/);
  assert.throws(() => validateReviewOutputLocation({ outFile: draft.bodyFile, evidenceRoot: f.dir, recordFile: draft.recordFile }), /已存在/);
  assert.equal(validateReviewOutputLocation({ outFile: path.join(f.dir, "formal.json"), evidenceRoot: f.dir, recordFile: draft.recordFile }), path.join(realpathSync(f.dir), "formal.json"));
});

test("项目/CI可直接从本轮原始报告自动组装草稿，其他维度保持待补", (t) => {
  const f = fixture(t);
  const input = buildReviewInput({ summaryFile: path.join(f.dir, "quality-summary.json"), policyFile: path.join(f.dir, "review-policy.json"),
    evidenceRoot: f.dir, authorId: "author", context: { source: "actual-collector/isolated-fixture" } });
  const draft = createReviewDraft({ input, evidenceRoot: f.dir, outDir: path.join(f.dir, "automatic-review"), now });
  assert.equal(draft.dimensions.filter((d) => d.status === "pending-evidence").length, 7); assert.equal(draft.approved, false);
  assert.equal(input.candidateSha, sha); assert.equal(input.evidence.length, 1);
});

test("缺必需执行或源码绑定的前报告不声明同口径改善", (t) => {
  const f = fixture(t), missing = structuredClone(f.summary); missing.checks = [];
  assert.equal(compareReviewSummaries(missing, f.summary).comparable, false);
  const unbound = structuredClone(f.summary); unbound.run.sourceBound = false;
  assert.equal(compareReviewSummaries(unbound, f.summary).comparable, false);
});

test("按时正式签发后身份receipt过期不误撤销Review；消费仍受正式记录24小时有效期约束", (t) => {
  const f = fixture(t), draft = f.draft(), auth = f.authorize(draft.recordFile);
  auth.authorization.expiresAt = new Date(now.getTime() + 15 * 60000).toISOString();
  write(auth.authorizationFile, signRecord(auth.authorization, f.authorizationPrivateKeyFile));
  const formal = signReviewRecord({ ...f.pins, recordFile: draft.recordFile, authorizationFile: auth.authorizationFile });
  const formalFile = f.signed(formal);
  assert.equal(verifyReview({ ...f.pins, recordFile: formalFile, now: new Date(now.getTime() + 2 * 3600000) }).decision, 'approved');
  assert.throws(() => verifyReview({ ...f.pins, recordFile: formalFile, now: new Date(now.getTime() + 25 * 3600000) }), /过期/);
  assert.throws(() => signReviewRecord({ ...f.pins, recordFile: draft.recordFile, authorizationFile: auth.authorizationFile, now: new Date(now.getTime() + 16 * 60000) }), /授权已过期/);
});
for (const mode of ['before-authorization', 'after-receipt-expiry', 'future']) test(`Review即使重签也拒绝${mode}签发时间`, (t) => {
  const f = fixture(t), draft = f.draft(), formal = f.sign(draft.recordFile);
  if (mode === 'before-authorization') formal.signedAt = new Date(now.getTime() - 1000).toISOString();
  if (mode === 'after-receipt-expiry') formal.signedAt = new Date(now.getTime() + 3600001).toISOString();
  if (mode === 'future') formal.signedAt = new Date(now.getTime() + 20000).toISOString();
  const signed = f.signed(signRecord(formal, f.pins.privateKeyFile)), consumedAt = mode === 'after-receipt-expiry' ? new Date(now.getTime() + 2 * 3600000) : now;
  assert.throws(() => verifyReview({ ...f.pins, recordFile: signed, now: consumedAt }));
});
