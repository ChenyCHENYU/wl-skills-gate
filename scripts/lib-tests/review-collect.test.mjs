import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectCiSource } from '../../lib/ci-source.js';
import { autoReviewDraft } from '../../lib/review-auto.js';
import { REVIEW_DIMENSIONS } from '../../lib/review.js';
import { collectReviewEvidence, verifyCollectedReview } from '../../lib/review-collect.js';
import { stableStringify } from '../../lib/util.js';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = 'b'.repeat(40), digest = 'a'.repeat(64), now = Date.parse('2026-10-15T00:00:00Z'), origin = 'https://ci.example.invalid';
import { createReviewCollectFixture as fixture } from '../test-support/review-collect-fixture.mjs';
test('真实固定CI来源自动补齐原草稿九维证据，保留父链、认证作者和待授权状态', async (t) => {
  const f = await fixture(t), result = collectReviewEvidence(f.options), record = JSON.parse(readFileSync(result.recordFile));
  assert.equal(record.reviewId, 'gate-1'); assert.equal(record.authorId, 'author'); assert.equal(record.source, 'dev-feature'); assert.equal(record.target, 'dev');
  assert.equal(record.content.derivedFrom.reviewDigest, f.automatic.reviewDigest); assert.equal(record.content.dimensions.filter((d) => d.status === 'evidence-ready').length, 9);
  assert.equal(record.decision, 'pending-confirmation'); assert.equal(result.signed, false); assert.equal(result.approved, false);
  const verified = verifyCollectedReview({ ...f.options, recordFile: result.recordFile, provenanceFile: result.provenanceFile });
  assert.equal(verified.ok, true); assert.equal(verified.provenance.machineBusinessCorrectnessClaimed, false);
  rmSync(path.dirname(f.collection.sourceFile), { recursive: true });
  assert.equal(verifyCollectedReview({ ...f.options, recordFile: result.recordFile, provenanceFile: result.provenanceFile }).ok, true);
});
test('缺失工件留待补维度，机器阻断正文不被补证清零', async (t) => {
  const f = await fixture(t, { missing: true, failed: true }), result = collectReviewEvidence(f.options), record = JSON.parse(readFileSync(result.recordFile));
  assert.deepEqual(result.missingEvidenceIds, ['ui']); assert.equal(record.content.dimensions.find((d) => d.id === 'ui').status, 'pending-evidence');
  assert(record.unresolvedBlocking.some((v) => v.startsWith('finding:'))); assert(record.unresolvedBlocking.some((v) => v.startsWith('ci-job:')));
  assert.match(readFileSync(result.bodyFile, 'utf8'), /未处置阻断：2/);
});
for (const mode of ['artifact', 'source', 'author', 'gate', 'symlink', 'policy', 'dimension']) test(`采集前拒绝${mode}漂移且不留半成品`, async (t) => {
  const f = await fixture(t);
  if (mode === 'artifact') writeFileSync(path.join(path.dirname(f.collection.sourceFile), 'artifacts/review/tests.json'), 'tampered');
  if (mode === 'source' || mode === 'author') { const v = JSON.parse(readFileSync(f.collection.sourceFile)); if (mode === 'source') v.requiredJobs[0].status = 'failed'; else v.authorId = 'unverified-local-author'; write(f.collection.sourceFile, v); }
  if (mode === 'gate') { const v = structuredClone(f.summary); v.run.eventId = 'another'; write(path.join(path.dirname(f.collection.sourceFile), 'artifacts/quality/summary.json'), v); }
  if (mode === 'symlink') { const target = path.join(path.dirname(f.collection.sourceFile), 'artifacts/review/tests.json'); rmSync(target); symlinkSync(f.configFile, target); }
  if (mode === 'policy') { f.collector.reviewPolicyHash = 'c'.repeat(64); write(f.configFile, f.collector); }
  if (mode === 'dimension') { f.collector.evidence[0].dimensionIds = ['unknown']; write(f.configFile, f.collector); }
  assert.throws(() => collectReviewEvidence(f.options)); assert.equal(existsSync(f.options.outDir), false);
});
for (const mode of ['copied-artifact', 'copied-source', 'fixed-config', 'author', 'parent', 'record', 'provenance']) test(`复核登记或批准前拒绝${mode}篡改`, async (t) => {
  const f = await fixture(t), result = collectReviewEvidence(f.options), p = JSON.parse(readFileSync(result.provenanceFile));
  if (mode === 'copied-artifact') writeFileSync(path.join(f.options.outDir, 'ci/artifacts/review/tests.json'), 'tampered');
  if (mode === 'copied-source') { const v = JSON.parse(readFileSync(path.join(f.options.evidenceRoot, p.sourceFile))); v.sha = 'c'.repeat(40); write(path.join(f.options.evidenceRoot, p.sourceFile), v); }
  if (mode === 'fixed-config') { f.collector.allowedAuthorIds = ['reviewer']; write(f.configFile, f.collector); }
  if (mode === 'author' || mode === 'record') { const record = JSON.parse(readFileSync(result.recordFile)); if (mode === 'author') record.authorId = 'reviewer'; else record.content.target = 'prd'; write(result.recordFile, record); }
  if (mode === 'parent') writeFileSync(f.automatic.bodyFile, 'tampered original');
  if (mode === 'provenance') { p.additions[3].dimensionIds = ['scan']; write(result.provenanceFile, p); }
  assert.throws(() => verifyCollectedReview({ ...f.options, recordFile: result.recordFile, provenanceFile: result.provenanceFile }));
});
test('目录冲突不覆盖或删除原有工作成果', async (t) => {
  const f = await fixture(t); mkdirSync(f.options.outDir); writeFileSync(path.join(f.options.outDir, 'owner.txt'), 'existing');
  assert.throws(() => collectReviewEvidence(f.options), /EEXIST/); assert.equal(readFileSync(path.join(f.options.outDir, 'owner.txt'), 'utf8'), 'existing');
});
test('成功CI缺已批准optional人工UI/影响原件仍生成pending报告，不能当失败或已审通过', async (t) => {
  const f = await fixture(t, { optionalMissing: ['review/ui.json', 'review/review.json'] }), result = collectReviewEvidence(f.options), record = JSON.parse(readFileSync(result.recordFile));
  assert.deepEqual(result.missingEvidenceIds, ['ui', 'review']); assert.equal(record.unresolvedBlocking.length, 0);
  assert.equal(record.content.dimensions.filter((d) => d.status === 'pending-evidence').length, 2); assert.equal(record.decision, 'pending-confirmation');
  assert.equal(verifyCollectedReview({ ...f.options, recordFile: result.recordFile, provenanceFile: result.provenanceFile }).ok, true);
});
