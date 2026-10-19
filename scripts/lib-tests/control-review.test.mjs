import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createReviewCollectFixture } from '../test-support/review-collect-fixture.mjs';
import { collectReviewEvidence } from '../../lib/review-collect.js';
import { registerControlReview, createControlHandler } from '../../lib/control-service.js';
import { signReviewRecord, verifyReview } from '../../lib/evidence.js';
const hash = (value) => createHash('sha256').update(value).digest('hex'), now = Date.parse('2026-10-15T00:00:00Z'), origin = 'https://quality.example.invalid';
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
const authorizationCount = (f) => { const directory = path.join(f.c.dataDir, 'authorizations'); return existsSync(directory) ? readdirSync(directory).filter((v) => v.endsWith('.json')).length : 0; };
import { createControlReviewFixture as fixture } from '../test-support/control-review-fixture.mjs';
test('技术经理责任进入认证确认硬门；其他Reviewer不能代签，经理为执行人时必须非作者独立复核',async t=>{
  for(const manager of ['reviewer','author'])await t.test(manager,async sub=>{
    const f=await fixture(sub,{technicalManager:manager});await f.register();
    if(manager==='reviewer'){
      const cookie=await f.login('other'),session=JSON.parse(readFileSync(path.join(f.c.dataDir,'sessions.json'))).sessions[hash(cookie.split('=')[1])];
      const fields={csrf:session.csrf,reviewDigest:f.draft.reviewDigest,reason:'attempt independent reviewer substitution'};
      for(const d of JSON.parse(readFileSync(f.draft.recordFile)).content.dimensions){fields[`decision_${d.id}`]='approved';fields[`reason_${d.id}`]='actual fixture evidence checked';}
      const denied=await f.http({method:'POST',cookie,body:new URLSearchParams(fields).toString()});assert.equal(denied.status,400);assert.match(denied.text,/技术经理/);assert.equal(authorizationCount(f),0);
    }
    const cookie=await f.login('reviewer'),{fields}=await f.form(cookie),accepted=await f.http({method:'POST',cookie,body:new URLSearchParams(fields).toString()});
    assert.equal(accepted.status,200,accepted.text);assert.equal(authorizationCount(f),1);
    if(manager==='author'){const own=await f.login('author'),page=await f.http({cookie:own});assert.equal((page.text.match(/type="checkbox"/g)||[]).length,0);}
  });
});
test('可信CI→原自动草稿→补证→登记→OIDC独立逐维确认→原签发器接受，贯通同一证据链', async (t) => {
  const f = await fixture(t); assert.equal((await f.register()).status, 'registered');
  const cookie = await f.login(), { page, fields } = await f.form(cookie);
  assert.match(page.text, /待确认|Review确认/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 9);
  const record = JSON.parse(readFileSync(f.draft.recordFile));
  for (const evidence of record.content.evidence) {
    const downloaded = await f.http({ url: `/reviews/review-1/evidence/${evidence.id}`, cookie });
    assert.equal(downloaded.status, 200, String(downloaded.text)); assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
    assert.match(downloaded.headers['content-disposition'], /attachment/); assert.equal(hash(downloaded.text), evidence.sha256);
  }
  assert.equal((await f.http({ url: '/reviews/review-1/evidence/not-registered', cookie })).status, 400);
  assert.equal((await f.http({ url: '/reviews/review-1/evidence/..%2F..%2Fauthorization-private.pem', cookie })).status, 404);
  const authorized = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(authorized.status, 200, authorized.text);
  const authorizationFile = path.join(f.c.dataDir, 'authorizations', authorized.headers['x-quality-authorization-id'] + '.json');
  assert(existsSync(authorizationFile)); const auth = JSON.parse(readFileSync(authorizationFile)); assert.equal(auth.actorId, 'reviewer'); assert.equal(auth.authorId, 'author'); assert.equal(auth.dimensionDecisions.length, 9);
  const pins = { recordFile: f.draft.recordFile, evidenceRoot: f.options.evidenceRoot, authorizationFile, authorizationPublicKeyFile: path.join(f.root, 'authorization-public.pem'), expectAuthorizationIssuer: 'identity-authority', privateKeyFile: path.join(f.root, 'review-private.pem'), publicKeyFile: path.join(f.root, 'review-public.pem'), project: 'demo', sha: f.summary.run.commitSha, reviewerId: 'reviewer', authorId: 'author', expectReviewPolicyHash: f.collector.reviewPolicyHash, expectPolicyHash: 'a'.repeat(64), expectRulesHash: 'a'.repeat(64), expectBaselineHash: 'a'.repeat(64), expectWaiversHash: 'a'.repeat(64), now: new Date(now) };
  const signedFile = path.join(f.options.evidenceRoot, 'formal-review.json'); json(signedFile, signReviewRecord(pins));
  assert.equal(verifyReview({ ...pins, recordFile: signedFile }).decision, 'approved');
});
test('实际作者虽有复核权限仍不能自审，无授权落盘', async (t) => {
  const f = await fixture(t); await f.register(); const cookie = await f.login('author'), page = await f.http({ cookie });
  assert.equal(page.status, 200); assert.match(page.text, /当前身份不能批准/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 0);
  const session = JSON.parse(readFileSync(path.join(f.c.dataDir, 'sessions.json'))).sessions[hash(cookie.split('=')[1])];
  const fields = { csrf: session.csrf, reviewDigest: f.draft.reviewDigest, reason: 'self approve' };
  for (const d of JSON.parse(readFileSync(f.draft.recordFile)).content.dimensions) { fields[`decision_${d.id}`] = 'approved'; fields[`reason_${d.id}`] = 'self approval attempt'; }
  const denied = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() });
  assert.equal(denied.status, 400); assert.match(denied.text, /非作者/); assert.equal(authorizationCount(f), 0);
});
test('原件缺维/机器阻断只显示待补，不提供或接受发布批准', async (t) => {
  const f = await fixture(t, { missing: true, failed: true }); await f.register(); const cookie = await f.login(), page = await f.http({ cookie });
  assert.equal(page.status, 200); assert.match(page.text, /仍缺证据|阻断/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 0);
  const session = JSON.parse(readFileSync(path.join(f.c.dataDir, 'sessions.json'))).sessions[hash(cookie.split('=')[1])];
  const forced = { csrf: session.csrf, reviewDigest: f.draft.reviewDigest, reason: 'force missing evidence' };
  for (const d of JSON.parse(readFileSync(f.draft.recordFile)).content.dimensions) { forced[`decision_${d.id}`] = 'approved'; forced[`reason_${d.id}`] = 'force'; }
  assert.equal((await f.http({ method: 'POST', cookie, body: new URLSearchParams(forced).toString() })).status, 400);
  assert.equal(authorizationCount(f), 0);
});
test('少一维明确确认不签授权，正确九维仍可随后重试', async (t) => {
  const f = await fixture(t); await f.register(); const cookie = await f.login(), { fields } = await f.form(cookie); delete fields.decision_tests;
  const denied = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(denied.status, 400); assert.equal(authorizationCount(f), 0);
  fields.decision_tests = 'approved'; const accepted = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(accepted.status, 200, accepted.text);
});
for (const mode of ['provenance', 'original-evidence', 'body']) test(`登记后${mode}变化使已打开表单失效，零授权`, async (t) => {
  const f = await fixture(t); await f.register(); const cookie = await f.login(), { fields } = await f.form(cookie);
  if (mode === 'provenance') { const p = JSON.parse(readFileSync(f.draft.provenanceFile)); p.authorId = 'reviewer'; json(f.draft.provenanceFile, p); }
  if (mode === 'original-evidence') writeFileSync(path.join(f.options.outDir, 'ci/artifacts/review/tests.json'), 'tampered');
  if (mode === 'body') writeFileSync(f.draft.bodyFile, 'stale body replaced');
  assert.equal((await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() })).status, 400);
  assert.equal(authorizationCount(f), 0);
});
for (const mode of ['failed-retry', 'new-job-id', 'changed-artifact']) test(`旧Review表单授权时重新读取CI，拒绝${mode}并保留原始新快照`, async (t) => {
  const f = await fixture(t, { includeOtherJob: true }); await f.register(); const cookie = await f.login(), { fields } = await f.form(cookie);
  if (mode === 'failed-retry') f.ciState.otherJobFailed = true;
  if (mode === 'new-job-id') f.ciState.testsJobId = 62;
  if (mode === 'changed-artifact') f.ciContents['review/tests.json'] = JSON.stringify({ result: 'changed after opening form' });
  const rejected = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() });
  assert.equal(rejected.status, 400, rejected.text); assert.match(rejected.text, /CI当前/); assert.equal(authorizationCount(f), 0);
  const attempts = readdirSync(path.join(f.c.dataDir, 'auth-check')); assert.equal(attempts.length, 1);
  assert(existsSync(path.join(f.c.dataDir, 'auth-check', attempts[0], 'current/source.json'))); assert(existsSync(path.join(f.c.dataDir, 'auth-check', attempts[0], 'failure.json')));
});
test('授权时CI暂时不可用明确拒绝，服务恢复后同一真实表单可以成功重试', async (t) => {
  const f = await fixture(t); await f.register(); const cookie = await f.login(), { fields } = await f.form(cookie);
  f.ciState.unavailable = true; assert.equal((await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() })).status, 400);
  assert.equal(authorizationCount(f), 0);
  f.ciState.unavailable = false; const retried = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(retried.status, 200, retried.text);
  assert.equal(readdirSync(path.join(f.c.dataDir, 'auth-check')).length, 2); assert.equal(readdirSync(path.join(f.c.dataDir, 'authorizations')).length, 1);
});
test('成功CI仅缺optional人工证据仍可登记查看，独立复核人也不能强制批准', async (t) => {
  const f = await fixture(t, { optionalMissing: ['review/ui.json', 'review/review.json'] }); await f.register(); const cookie = await f.login(), page = await f.http({ cookie });
  assert.equal(page.status, 200); assert.match(page.text, /仍缺证据/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 0);
  const session = JSON.parse(readFileSync(path.join(f.c.dataDir, 'sessions.json'))).sessions[hash(cookie.split('=')[1])], fields = { csrf: session.csrf, reviewDigest: f.draft.reviewDigest, reason: 'force pending optional approval' };
  for (const d of JSON.parse(readFileSync(f.draft.recordFile)).content.dimensions) { fields[`decision_${d.id}`] = 'approved'; fields[`reason_${d.id}`] = 'attempt'; }
  assert.equal((await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() })).status, 400); assert.equal(authorizationCount(f), 0);
});
test('认证页实际补充UI、影响和外部测试记录→新不可变版本→九维独立确认→正式签发，无手写JSON', async (t) => {
  const f = await fixture(t, { optionalMissing: ['review/ui.json', 'review/review.json', 'review/tests.json'], supplement: true }); await f.register();
  const cookie = await f.login(), page = await f.http({ cookie }); assert.match(page.text, /补充实际验证记录/); assert.equal((page.text.match(/type="checkbox"/g) || []).length, 0);
  const fields = { csrf: page.text.match(/name="csrf" value="([^"]+)"/)[1], action: 'supplement', reviewDigest: f.draft.reviewDigest, conclusion_ui: '已核对本次页面截图及交互，列表、异常态和权限展示验证通过', verificationUrl_ui: origin + '/reports/actual-ui-123', conclusion_review: '已复核diff和调用链，接口消费者及异常分支兼容，关联必测已核验', verificationUrl_review: origin + '/reports/actual-impact-123', conclusion_tests: '已核对QA报告12条实际用例，创建、查询、权限和异常分支均通过，报告候选与本次一致', verificationUrl_tests: origin + '/reports/actual-qa-123' };
  const saved = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(saved.status, 303, saved.text); assert.match(saved.headers.location, /-human-/); assert.equal(authorizationCount(f), 0);
  const catalog = JSON.parse(readFileSync(path.join(f.c.dataDir, 'reviews.json'))), entry = catalog.reviews[saved.headers.location.split('/').at(-1)], record = JSON.parse(readFileSync(entry.recordFile)); assert.notEqual(entry.recordFile, f.draft.recordFile);
  assert.equal(JSON.parse(readFileSync(f.draft.recordFile)).reviewDigest, f.draft.reviewDigest); assert.equal(record.decision, 'pending-confirmation');
  const confirmation = await f.http({ url: saved.headers.location, cookie }); assert.equal(confirmation.status, 200, confirmation.text); assert.equal((confirmation.text.match(/type="checkbox"/g) || []).length, 9);
  const approve = { csrf: fields.csrf, reviewDigest: record.reviewDigest, reason: '逐维查看真实CI、变更与认证补证后确认发布' };
  for (const d of record.content.dimensions) { approve[`decision_${d.id}`] = d.applicable ? 'approved' : 'not-applicable'; approve[`reason_${d.id}`] = '本轮证据已核对，验证范围与候选一致'; }
  const approved = await f.http({ url: saved.headers.location, method: 'POST', cookie, body: new URLSearchParams(approve).toString() }); assert.equal(approved.status, 200, approved.text);
  const authorizationFile = path.join(f.c.dataDir, 'authorizations', approved.headers['x-quality-authorization-id'] + '.json');
  const formal = signReviewRecord({ recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot, authorizationFile, authorizationPublicKeyFile: path.join(f.root, 'authorization-public.pem'), expectAuthorizationIssuer: 'identity-authority', privateKeyFile: path.join(f.root, 'review-private.pem'), project: 'demo', sha: f.summary.run.commitSha, reviewerId: 'reviewer', authorId: 'author', expectReviewPolicyHash: f.collector.reviewPolicyHash, expectPolicyHash: 'a'.repeat(64), expectRulesHash: 'a'.repeat(64), expectBaselineHash: 'a'.repeat(64), expectWaiversHash: 'a'.repeat(64), now: new Date(now) });
  assert.equal(formal.decision, 'approved'); assert.equal(formal.content.dimensions.length, 9);
});
for (const actor of ['author', 'stale-ci']) test(`人工补证拒绝${actor}，不生成发布授权或可伪造事实`, async (t) => {
  const f = await fixture(t, { optionalMissing: ['review/ui.json', 'review/review.json'], supplement: true }); await f.register();
  const cookie = await f.login(actor === 'author' ? 'author' : 'reviewer'), session = JSON.parse(readFileSync(path.join(f.c.dataDir, 'sessions.json'))).sessions[hash(cookie.split('=')[1])];
  if (actor === 'stale-ci') f.ciState.unavailable = true;
  const fields = { csrf: session.csrf, action: 'supplement', reviewDigest: f.draft.reviewDigest, conclusion_ui: '已查看', verificationUrl_ui: origin + '/reports/ui', conclusion_review: '已查看', verificationUrl_review: origin + '/reports/impact' };
  const denied = await f.http({ method: 'POST', cookie, body: new URLSearchParams(fields).toString() }); assert.equal(denied.status, 400, denied.text); assert.equal(authorizationCount(f), 0); assert.equal(Object.keys(JSON.parse(readFileSync(path.join(f.c.dataDir, 'reviews.json'))).reviews).length, 1);
});
