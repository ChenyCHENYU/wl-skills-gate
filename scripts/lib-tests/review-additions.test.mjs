import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createReviewCollectFixture } from '../test-support/review-collect-fixture.mjs';
import { collectReviewEvidence, verifyCollectedReview } from '../../lib/review-collect.js';
import { extendCollectedReview } from '../../lib/review-additions.js';
import { createReviewDraft, validateReviewEvidence } from '../../lib/review.js';
import { stableStringify } from '../../lib/util.js';

const now = Date.parse('2026-10-15T00:00:00Z'), origin = 'https://quality.example.invalid';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = (file) => JSON.parse(readFileSync(file));
const types = { submission: 'commit-check', branch: 'branch-check', ui: 'ui-verification', review: 'impact-review', tests: 'test-verification', cicd: 'pipeline-verification', governance: 'ownership-verification' };

async function fixture(t, options = {}) {
  const f = await createReviewCollectFixture(t, { optionalMissing: ['review/ui.json', 'review/review.json', 'review/tests.json', 'review/cicd.json', 'review/governance.json'], ...options });
  const policyFile = path.join(f.options.evidenceRoot, 'review-policy.json'), policy = read(policyFile);
  for (const d of policy.dimensions) d.requiredEvidenceTypes = [['coding', 'scan'].includes(d.id) ? 'gate-summary' : types[d.id]];
  write(policyFile, policy); f.collector.reviewPolicyHash = hash(stableStringify(policy));
  f.collector.evidence = f.collector.evidence.filter((e) => ['submission', 'branch', 'tests'].includes(e.id)).map((e) => ({ ...e, type: types[e.id] }));
  const authorizationPrivateKeyFile = path.join(f.root, 'auth-private.pem'), authorizationPublicKeyFile = path.join(f.root, 'auth-public.pem');
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(authorizationPrivateKeyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(authorizationPublicKeyFile, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const governanceConfigFile = path.join(f.root, 'governance.json');
  const governance = { schemaVersion: 1, issuer: 'central', publicKeyFile: authorizationPublicKeyFile, allowedLinkOrigins: [origin], operators: ['operator'],
    projects: { demo: { owner: 'owner', backup: 'backup', escalationOwner: 'manager', reviewers: ['reviewer', 'author'], channel: 'group', issueBaseUrl: origin + '/issues',
      scopes: { standard: { requiredChecks: ['CHECK'], policyHash: 'a'.repeat(64), rulesHash: 'a'.repeat(64), baselineHash: 'a'.repeat(64), waiversHash: 'a'.repeat(64) } } } }, channels: { group: { type: 'feishu', webhookEnv: 'GROUP_WEBHOOK', signingSecretEnv: 'GROUP_SECRET' } } };
  write(governanceConfigFile, governance);
  f.collector.supplement = { governanceConfigFile, authorizationPublicKeyFile, authorizationIssuer: 'identity-authority' }; write(f.configFile, f.collector);
  const input = read(f.automatic.inputFile), fresh = createReviewDraft({ input, evidenceRoot: f.options.evidenceRoot, outDir: path.join(f.options.evidenceRoot, 'fresh-original'), now: new Date(now) });
  const collected = collectReviewEvidence({ ...f.options, recordFile: fresh.recordFile });
  const optionsFor = (parent, name, extra = {}) => ({ configFile: f.configFile, recordFile: parent.recordFile, provenanceFile: parent.provenanceFile, evidenceRoot: f.options.evidenceRoot, outDir: path.join(f.options.evidenceRoot, name), now, ...extra });
  const human = { actorId: 'reviewer', identitySource: 'https://identity.example.invalid', entries: ['ui', 'review', 'tests'].map((dimensionId) => ({ dimensionId, conclusion: '已核验生产变更范围、实际用例结果和回归风险', verificationUrl: `${origin}/evidence/${dimensionId}` })) };
  return { ...f, collected, optionsFor, human, authorizationPrivateKeyFile, authorizationPublicKeyFile, governanceConfigFile, governance };
}

test('默认缺五维来源自动补真实CI和治理，认证人工补UI/影响/外部测试后九维就绪，批准仍独立', async (t) => {
  const f = await fixture(t), auto = extendCollectedReview(f.optionsFor(f.collected, 'central'));
  const first = verifyCollectedReview(f.optionsFor(auto, 'unused'));
  assert.deepEqual(first.record.content.dimensions.filter((d) => d.status === 'pending-evidence').map((d) => d.id), ['ui', 'review', 'tests']);
  assert.equal(first.provenance.sourceFile, read(f.collected.provenanceFile).sourceFile);
  assert.equal(first.observation.runId, '45');
  const result = extendCollectedReview(f.optionsFor(auto, 'authenticated', { human: f.human, authorizationPrivateKeyFile: f.authorizationPrivateKeyFile }));
  const checked = verifyCollectedReview(f.optionsFor(result, 'unused'));
  assert.equal(checked.record.content.dimensions.filter((d) => d.status === 'evidence-ready').length, 9);
  assert.equal(checked.record.decision, 'pending-confirmation'); assert.equal(result.approved, false); assert.equal(result.signed, false);
  assert.equal(checked.provenance.approved, false); assert.equal(checked.baseProvenance.kind, 'collected-review-provenance');
  assert(checked.record.content.evidence.length > first.record.content.evidence.length);
  const humanFact = read(path.join(f.options.evidenceRoot, checked.provenance.additions.find((e) => e.type === 'test-verification').file));
  assert.equal(humanFact.machineExecutionClaimed, false); assert.equal(humanFact.attestationKind, 'human-reviewed-external-report');
  assert.equal(humanFact.actorId, 'reviewer'); assert.equal(humanFact.reviewApproved, false);
  validateReviewEvidence(checked.record, { evidenceRoot: f.options.evidenceRoot, expectReviewPolicyHash: f.collector.reviewPolicyHash, project: 'demo', sha: checked.candidateSha });
});

for (const mode of ['author', 'unknown-reviewer', 'unsigned', 'wrong-key', 'unapproved-origin', 'unknown-dimension']) test(`认证补证拒绝${mode}且不留半成品`, async (t) => {
  const f = await fixture(t), human = structuredClone(f.human), extra = { human, authorizationPrivateKeyFile: f.authorizationPrivateKeyFile };
  if (mode === 'author') human.actorId = 'author';
  if (mode === 'unknown-reviewer') human.actorId = 'stranger';
  if (mode === 'unsigned') delete extra.authorizationPrivateKeyFile;
  if (mode === 'wrong-key') { const keys = generateKeyPairSync('ed25519'); const file = path.join(f.root, 'wrong.pem'); writeFileSync(file, keys.privateKey.export({ type: 'pkcs8', format: 'pem' })); extra.authorizationPrivateKeyFile = file; }
  if (mode === 'unapproved-origin') human.entries[0].verificationUrl = 'https://unapproved.example.invalid/test';
  if (mode === 'unknown-dimension') human.entries[0].dimensionId = 'scan';
  const options = f.optionsFor(f.collected, mode, extra); assert.throws(() => extendCollectedReview(options)); assert.equal(existsSync(options.outDir), false);
});

for (const mode of ['human-signature', 'human-author', 'automatic-state', 'governance-config', 'parent-provenance', 'public-key', 'cycle']) test(`统一复核拒绝补证${mode}篡改`, async (t) => {
  const f = await fixture(t), result = extendCollectedReview(f.optionsFor(f.collected, 'authenticated', { human: f.human, authorizationPrivateKeyFile: f.authorizationPrivateKeyFile }));
  const p = read(result.provenanceFile);
  if (mode === 'human-signature' || mode === 'human-author') {
    const file = path.join(f.options.evidenceRoot, p.additions.find((e) => e.type === 'ui-verification').file), fact = read(file);
    if (mode === 'human-signature') fact.conclusion = 'tampered'; else fact.actorId = 'author'; write(file, fact);
  }
  if (mode === 'automatic-state') { const file = path.join(f.options.evidenceRoot, p.additions.find((e) => e.type === 'pipeline-verification').file), fact = read(file); fact.status = 'success-forged'; write(file, fact); }
  if (mode === 'governance-config') { f.governance.projects.demo.reviewers = ['another']; write(f.governanceConfigFile, f.governance); }
  if (mode === 'parent-provenance') { const file = path.join(f.options.evidenceRoot, p.parentProvenanceFile), v = read(file); v.authorId = 'reviewer'; write(file, v); }
  if (mode === 'public-key') writeFileSync(f.authorizationPublicKeyFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  if (mode === 'cycle') { p.parentProvenanceFile = path.relative(f.options.evidenceRoot, result.provenanceFile); p.parentProvenanceHash = hash(readFileSync(result.provenanceFile)); write(result.provenanceFile, p); }
  assert.throws(() => verifyCollectedReview(f.optionsFor(result, 'unused')));
});

test('人工外部报告不能清除Gate与必需CI失败阻断', async (t) => {
  const f = await fixture(t, { failed: true, otherJobFailed: true }), result = extendCollectedReview(f.optionsFor(f.collected, 'authenticated', { human: f.human, authorizationPrivateKeyFile: f.authorizationPrivateKeyFile }));
  const checked = verifyCollectedReview(f.optionsFor(result, 'unused'));
  assert(checked.record.unresolvedBlocking.some((v) => v.startsWith('finding:')));
  assert(checked.record.unresolvedBlocking.some((v) => v.startsWith('ci-job:')));
  assert.throws(() => validateReviewEvidence(checked.record, { evidenceRoot: f.options.evidenceRoot, expectReviewPolicyHash: f.collector.reviewPolicyHash, project: 'demo', sha: checked.candidateSha }), /阻断/);
});

test('不可变补证父链最多八层，超限失败保留原记录', async (t) => {
  const f = await fixture(t); let previous = f.collected;
  for (let i = 0; i < 8; i++) previous = extendCollectedReview(f.optionsFor(previous, `layer-${i}`));
  const options = f.optionsFor(previous, 'too-deep'); assert.throws(() => extendCollectedReview(options), /深度|过深/);
  assert.equal(existsSync(options.outDir), false); assert.equal(verifyCollectedReview(f.optionsFor(previous, 'unused')).ok, true);
});
