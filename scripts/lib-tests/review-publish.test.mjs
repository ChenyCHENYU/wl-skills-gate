import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createControlReviewFixture } from '../test-support/control-review-fixture.mjs';
import { publishReviewAuthorizations } from '../../lib/review-publish.js';
import { verifyReview, signRecord } from '../../lib/evidence.js';
const now = Date.parse('2026-10-15T00:00:00Z');
const write = (file, value) => writeFileSync(file, JSON.stringify(value));
async function fixture(t, extra = {}) {
  const f = await createControlReviewFixture(t, extra); await f.register(); const cookie = await f.login(), { fields } = await f.form(cookie);
  const accepted = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(accepted.status, 200, accepted.text);
  const configFile = path.join(f.root, 'review-publish.json'), config = { schemaVersion: 1,
    controlCatalogFile: path.join(f.c.dataDir, 'reviews.json'), authorizationDir: path.join(f.c.dataDir, 'authorizations'),
    stateFile: path.join(f.root, 'publisher-state.json'), manifestDir: path.join(f.root, 'review-delivery'),
    reviewPrivateKeyFile: path.join(f.root, 'review-private.pem'), reviewPublicKeyFile: path.join(f.root, 'review-public.pem'),
    authorizationPublicKeyFile: path.join(f.root, 'authorization-public.pem'), authorizationIssuer: 'identity-authority',
    projects: { demo: { evidenceRoots: [f.options.evidenceRoot], reviewers: ['reviewer'], collectorConfigFile: f.configFile,
      reviewPolicyFile: path.join(f.root, 'quality/review-policy.json'), reviewPolicyHash: f.collector.reviewPolicyHash,
      policyHash: 'a'.repeat(64), rulesHash: 'a'.repeat(64), baselineHash: 'a'.repeat(64), waiversHash: 'a'.repeat(64), profile: 'standard' } } };
  write(configFile, config); const fixtureClock = Date.now(); const run = (opts = {}) => publishReviewAuthorizations({ configFile, env: { TOKEN: 'secret' }, fetchImpl: f.fetchImpl, now: now + Date.now() - fixtureClock, ...opts });
  return { ...f, publishConfigFile: configFile, publishConfig: config, run };
}
test('实际OIDC九维授权由独立作业自动签发正式Review和交付manifest，重复幂等', async (t) => {
  const f = await fixture(t), result = await f.run(); assert.equal(result.status, 'ok', JSON.stringify(result.errors)); assert.equal(result.published.length, 1);
  const manifest = JSON.parse(readFileSync(result.published[0].manifestFile)); assert.equal(manifest.kind, 'published-review-manifest');
  assert.equal(manifest.registrationId, 'review-1'); assert.equal(manifest.authorId, 'author'); assert.equal(manifest.reviewerId, 'reviewer');
  const formal = verifyReview({ ...manifest, recordFile: manifest.recordFile, project: manifest.project, sha: manifest.candidateSha, now: new Date(now + 10000) }); assert.equal(formal.kind, 'review-record');
  for (const key of ['repairAuthorized', 'promotionAuthorized', 'deploymentAuthorized', 'closureAuthorized']) assert.equal(formal[key], false);
  const before = readFileSync(manifest.recordFile), again = await f.run(); assert.equal(again.published.length, 0); assert.equal(again.reused.length, 1); assert.deepEqual(readFileSync(manifest.recordFile), before);
});
test('签发作业不加载身份服务/事件私钥，只持有独立Review私钥与授权公钥', async (t) => {
  const f = await fixture(t); rmSync(path.join(f.root, 'identity-private.pem')); rmSync(path.join(f.root, 'receipt-private.pem')); rmSync(path.join(f.root, 'authorization-private.pem'));
  const result = await f.run(); assert.equal(result.published.length, 1, JSON.stringify(result.errors));
});
for (const stage of ['record-written', 'manifest-written']) test(`${stage}后中断保留证据，下轮从checkpoint恢复不覆盖或重复签发`, async (t) => {
  const f = await fixture(t); let interrupted = false;
  const first = await f.run({ afterStage: (s) => { if (s === stage && !interrupted) { interrupted = true; throw new Error('isolated crash'); } } }); assert.equal(first.errors.length, 1);
  const state = JSON.parse(readFileSync(f.publishConfig.stateFile)), progress = Object.values(state.authorizations)[0], original = readFileSync(progress.recordFile);
  const recovered = await f.run(); assert.equal(recovered.published.length, 1, JSON.stringify(recovered.errors)); assert.deepEqual(readFileSync(progress.recordFile), original);
});
test('坏授权文件隔离，不阻塞有效授权；不接受自报approved', async (t) => {
  const f = await fixture(t); write(path.join(f.publishConfig.authorizationDir, '00-bad.json'), { authorizationId: 'forged', kind: 'review-authorization', project: 'demo', decision: 'approved' });
  const result = await f.run(); assert.equal(result.status, 'partial'); assert.equal(result.errors.length, 1); assert.equal(result.published.length, 1);
});
test('批准后CI重试失败/新版本事实不匹配拒签，原授权不能发布旧绿', async (t) => {
  const f = await fixture(t, { includeOtherJob: true }); f.ciState.otherJobFailed = true;
  const result = await f.run(); assert.equal(result.published.length, 0); assert.match(result.errors[0].reason, /CI当前/);
  assert.equal(readdirSync(f.publishConfig.manifestDir).filter((v) => v.endsWith('.json')).length, 0);
});
test('CI短暂不可用不签发，恢复后自动重试相同授权成功', async (t) => {
  const f = await fixture(t); f.ciState.unavailable = true; assert.equal((await f.run()).published.length, 0); f.ciState.unavailable = false;
  assert.equal((await f.run()).published.length, 1);
});
for (const mode of ['body', 'provenance', 'authorization', 'checkpoint']) test(`拒绝${mode}篡改，正式记录不可覆盖`, async (t) => {
  const f = await fixture(t);
  if (mode === 'body') writeFileSync(f.draft.bodyFile, 'tampered');
  if (mode === 'provenance') { const p = JSON.parse(readFileSync(f.draft.provenanceFile)); p.authorId = 'reviewer'; write(f.draft.provenanceFile, p); }
  if (mode === 'authorization') { const file = path.join(f.publishConfig.authorizationDir, readdirSync(f.publishConfig.authorizationDir)[0]), auth = JSON.parse(readFileSync(file)); auth.actorId = 'author'; write(file, auth); }
  if (mode === 'checkpoint') { f.ciState.unavailable = true; await f.run(); f.ciState.unavailable = false; const state = JSON.parse(readFileSync(f.publishConfig.stateFile)); Object.values(state.authorizations)[0].recordFile = path.join(f.root, 'outside.json'); write(f.publishConfig.stateFile, state); }
  const result = await f.run(); assert.equal(result.published.length, 0); assert.equal(result.errors.length, 1); assert.equal(existsSync(path.join(f.root, 'outside.json')), false);
});
test('正式Review已签发后被篡改不覆盖，也不能仅凭checkpoint报成功', async (t) => {
  const f = await fixture(t), first = await f.run(); writeFileSync(first.published[0].recordFile, '{}'); const next = await f.run();
  assert.equal(next.reused.length, 0); assert.equal(next.errors.length, 1); assert.equal(readFileSync(first.published[0].recordFile, 'utf8'), '{}');
});
test('CI复验期间身份授权被替换拒绝串用，不能输出错误授权归属manifest', async (t) => {
  const f = await fixture(t), authorizationFile = path.join(f.publishConfig.authorizationDir, readdirSync(f.publishConfig.authorizationDir)[0]);
  const result = await f.run({ afterStage: (stage) => { if (stage === 'live-verified') { const auth = JSON.parse(readFileSync(authorizationFile)); auth.authorizationId = 'replaced'; write(authorizationFile, auth); } } });
  assert.equal(result.published.length, 0); assert.match(result.errors[0].reason, /授权已变化/);
});
test('完成项暂停25小时后仍按历史签名/原字节幂等跳过，不因CI历史快照过期永久报错', async (t) => {
  const f = await fixture(t), initial = await f.run(), before = readFileSync(initial.published[0].recordFile); f.ciState.unavailable = true;
  const resumed = await f.run({ now: now + 25 * 3600000 }); assert.equal(resumed.status, 'ok', JSON.stringify(resumed.errors)); assert.equal(resumed.reused.length, 1);
  assert.equal(resumed.published.length, 0); assert.deepEqual(readFileSync(initial.published[0].recordFile), before);
});
for (const stage of ['record-written', 'manifest-written']) test(`按时${stage}后暂停2小时可恢复交付，不能误作过期首次签发`, async (t) => {
  const f = await fixture(t); let stopped = false;
  await f.run({ afterStage: (s) => { if (s === stage && !stopped) { stopped = true; throw new Error('paused after on-time signature'); } } });
  const state = JSON.parse(readFileSync(f.publishConfig.stateFile)), before = readFileSync(Object.values(state.authorizations)[0].recordFile);
  const resumed = await f.run({ now: now + 2 * 3600000 }); assert.equal(resumed.published.length, 1, JSON.stringify(resumed.errors));
  assert.deepEqual(readFileSync(resumed.published[0].recordFile), before);
});
test('同目录合法部署授权由部署消费者处理，Review作业验签后跳过且仍发布有效Review', async (t) => {
  const f = await fixture(t), authorizationId = 'deploy-authorization-known';
  write(path.join(f.publishConfig.authorizationDir, '00-deployment.json'), signRecord({ schemaVersion: 1, kind: 'deployment-authorization', scope: 'deployment-execute', issuer: 'identity-authority', authorizationId,
    decision: 'approved', actorId: 'reviewer', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString() }, path.join(f.root, 'authorization-private.pem')));
  const result = await f.run(); assert.equal(result.status, 'ok', JSON.stringify(result.errors)); assert.equal(result.published.length, 1); assert.equal(result.skipped.length, 1); assert.equal(result.skipped[0].authorizationId, authorizationId);
});
