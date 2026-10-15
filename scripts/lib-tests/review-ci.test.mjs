import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createControlReviewFixture } from '../test-support/control-review-fixture.mjs';
import { createCiReview } from '../../lib/review-ci.js';
const now = Date.parse('2026-10-15T00:00:00Z'), sha = 'b'.repeat(40), origin = 'https://quality.example.invalid';
const write = (file, value) => writeFileSync(file, JSON.stringify(value));
const candidate = { schemaVersion: 1, project: 'demo', source: 'dev-feature', target: 'dev', sourceSha: 'c'.repeat(40), targetBeforeSha: 'd'.repeat(40), candidateSha: sha };
async function fixture(t, options = {}) {
  const f = await createControlReviewFixture(t, options), configFile = path.join(f.root, 'review-ci.json');
  const config = { schemaVersion: 1, collectorConfigFile: f.configFile, reviewPolicyFile: path.join(f.root, 'quality/review-policy.json'), controlConfigFile: f.controlConfigFile,
    ...(options.candidateContext ? { sourceBranch: 'dev-feature', targetBranch: 'dev', candidateContextPath: 'review/candidate-context.json' } : {}) };
  write(configFile, config); return { ...f, configFile, config, run: (out = 'automatic-ci') => createCiReview({ configFile, sourceFile: f.collection.sourceFile, outDir: path.join(f.root, out), now }) };
}
test('可信CI一键生成同源草稿、补证并登记，无开发者input/record拼接，重复观察幂等', async (t) => {
  const f = await fixture(t), result = await f.run(), record = JSON.parse(readFileSync(result.recordFile));
  assert.match(result.registrationId, /^gate-1-[a-f0-9]{12}$/); assert.equal(result.url, origin + '/reviews/' + result.registrationId); assert.equal(result.reviewId, 'gate-1'); assert.equal(result.registered, true); assert.equal(record.authorId, 'author');
  assert.equal(record.decision, 'pending-confirmation'); assert.equal(record.content.dimensions.filter((d) => d.status === 'evidence-ready').length, 9);
  assert.deepEqual([record.source, record.target, record.sourceSha, record.targetBeforeSha], [null, null, null, null]); assert.equal(result.candidateContextVerified, false);
  assert.deepEqual(readFileSync(path.join(result.evidenceRoot, 'quality-summary.json')), readFileSync(path.join(path.dirname(f.collection.sourceFile), 'artifacts/quality/summary.json')));
  const again = await f.run('retry-ci'); assert.equal(again.reused, true); assert.equal(again.recordFile, result.recordFile); assert.equal(existsSync(path.join(f.root, 'retry-ci')), false);
  const session = await f.login(), page = await f.http({ url: '/reviews/' + result.registrationId, cookie: session }); assert.equal(page.status, 200, page.text); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 9);
});
test('固定CI候选工件自动填充四项并保留原件，身份授权和晋级仍独立', async (t) => {
  const f = await fixture(t, { candidateContext: candidate }), result = await f.run(), record = JSON.parse(readFileSync(result.recordFile));
  for (const key of ['source', 'target', 'sourceSha', 'targetBeforeSha']) assert.equal(record[key], candidate[key]);
  assert.equal(result.candidateContextVerified, true); assert.equal(result.promotionAuthorized, false); assert(record.content.evidence.some((e) => e.id === 'candidate-context'));
});
for (const key of ['candidateSha', 'source', 'target', 'sourceSha', 'targetBeforeSha']) test(`固定候选工件${key}错误零注册/零输出`, async (t) => {
  const changed = { ...candidate, [key]: key.includes('Sha') ? 'invalid' : 'other-branch' }, f = await fixture(t, { candidateContext: changed });
  await assert.rejects(f.run(), /候选上下文/); assert.equal(existsSync(path.join(f.root, 'automatic-ci')), false);
});
test('缺维仍自动登记待补，页面不能批准；程序失败清理自有半成品', async (t) => {
  const f = await fixture(t, { missing: true, failed: true }), result = await f.run(); assert.deepEqual(result.missingEvidenceIds, ['ui']);
  const cookie = await f.login(), page = await f.http({ url: '/reviews/' + result.registrationId, cookie }); assert.equal(page.status, 200); assert.match(page.text, /仍缺证据/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 0);
});
test('Gate通过但另一个必需CI作业失败不能借九维批准放行', async (t) => {
  const f = await fixture(t, { otherJobFailed: true }), result = await f.run(), record = JSON.parse(readFileSync(result.recordFile));
  assert(record.unresolvedBlocking.some((v) => v.includes('ci-job:tests:61:failed')));
  const cookie = await f.login(), page = await f.http({ url: '/reviews/' + result.registrationId, cookie }); assert.equal(page.status, 200); assert.match(page.text, /阻断/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 0);
});
test('固定策略和中央批准采集器不符先拒绝，已有目录不覆盖', async (t) => {
  const f = await fixture(t); mkdirSync(path.join(f.root, 'occupied')); writeFileSync(path.join(f.root, 'occupied/owner.txt'), 'existing');
  await assert.rejects(f.run('occupied'), /EEXIST/); assert.equal(readFileSync(path.join(f.root, 'occupied/owner.txt'), 'utf8'), 'existing');
  writeFileSync(f.config.reviewPolicyFile, '{}'); await assert.rejects(f.run(), /Review/); assert.equal(existsSync(path.join(f.root, 'automatic-ci')), false);
});
test('相同Gate候选的CI必需作业重试变化自动产生新入口，原种子ID和旧证据保留', async (t) => {
  const f = await fixture(t, { includeOtherJob: true }), first = await f.run(); f.ciState.otherJobFailed = true;
  const nextObservation = await f.recollect('ci-retry-observation');
  const changed = await createCiReview({ configFile: f.configFile, sourceFile: nextObservation.sourceFile, outDir: path.join(f.root, 'revision-two'), now });
  assert.notEqual(changed.registrationId, first.registrationId); assert.equal(changed.reviewId, first.reviewId); assert.equal(changed.reviewId, 'gate-1');
  assert(existsSync(first.recordFile)); assert(existsSync(changed.recordFile));
  const record = JSON.parse(readFileSync(changed.recordFile)); assert(record.unresolvedBlocking.some((v) => v.includes('ci-job:tests:61:failed')));
  const again = await createCiReview({ configFile: f.configFile, sourceFile: nextObservation.sourceFile, outDir: path.join(f.root, 'revision-retry'), now }); assert.equal(again.reused, true); assert.equal(again.registrationId, changed.registrationId);
});
test('批准supplement配置后CI自动补实际流水线和治理原件，缺人工/外部测试维度保持待补', async (t) => {
  const f = await fixture(t, { supplement: true, optionalMissing: ['review/ui.json', 'review/review.json', 'review/tests.json', 'review/cicd.json', 'review/governance.json'] });
  const result = await f.run(), record = JSON.parse(readFileSync(result.recordFile));
  assert.equal(JSON.parse(readFileSync(result.provenanceFile)).kind, 'extended-collected-review-provenance');
  assert.deepEqual(record.content.dimensions.filter((d) => d.status === 'pending-evidence').map((d) => d.id), ['ui', 'review', 'tests']);
  assert(record.content.evidence.some((e) => e.type === 'pipeline-verification')); assert(record.content.evidence.some((e) => e.type === 'ownership-verification'));
  assert.equal(record.decision, 'pending-confirmation'); assert.equal(result.automaticallyApproved, false);
  const again = await f.run('unchanged-supplement'); assert.equal(again.reused, true); assert.equal(again.recordFile, result.recordFile);
});
test('治理主责映射变更进入观察指纹，自动生成新不可变Review入口', async (t) => {
  const f = await fixture(t, { supplement: true }), first = await f.run();
  const governance = JSON.parse(readFileSync(f.c.governanceConfigFile)); governance.projects.demo.owner = 'new-owner'; write(f.c.governanceConfigFile, governance);
  const changed = await f.run('changed-governance'); assert.notEqual(changed.registrationId, first.registrationId);
  const record = JSON.parse(readFileSync(changed.recordFile)), evidence = record.content.evidence.find((e) => e.type === 'ownership-verification' && e.id.startsWith('central-'));
  assert.equal(JSON.parse(readFileSync(path.join(changed.evidenceRoot, evidence.file))).owner, 'new-owner'); assert(existsSync(first.recordFile));
});
