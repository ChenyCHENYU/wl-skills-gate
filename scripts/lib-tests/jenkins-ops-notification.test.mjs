import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { opsNotification, sendOpsNotification } from '../../lib/jenkins-ops-notification.js';

const report = () => ({ kind: 'jenkins-ops-report', checkedAt: '2026-10-22T01:02:03Z', jenkinsOrigin: 'https://jenkins.example.invalid/', runUrl: 'https://jenkins.example.invalid/job/doctor/7/', status: 'attention', globalGaps: [], projects: [{ key: 'p:test', project: 'wl-produce', branch: 'test', jobs: ['p-test'], status: 'attention', gaps: [{ id: 'gate-package-missing', message: '项目未安装Gate', action: '技术经理执行项目接入，再自动复检' }], technicalManager: 'manager', executor: 'author' }], remoteModified: false, qualityPassed: false, buildAuthorized: false });
const person = (name, id, verified = true) => ({ name, feishu: { idType: 'user_id', id, verified } });
const config = () => ({ people: { manager: person('经理', 'verified-manager'), author: person('执行人', 'verified-author'), observer: person('李月', 'verified-observer') }, owners: { 'wl-produce': { technicalManager: 'manager', managerSubmissionNotify: 'observer' } } });
const json = value => JSON.stringify(value);
const env = { WL_FEISHU_CI_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/ci-fixture', WL_FEISHU_CI_SECRET: 'fixture-secret' };

test('运维缺项通知无需项目配置：时间、缺项、动作与真实@；不冒充质量通过', () => {
  const out = opsNotification(report(), config()), content = json(out.payload);
  assert.deepEqual(out.mentions.sort(), ['verified-author', 'verified-manager']);
  assert.equal(out.mentionMappingComplete, true);
  assert.match(content, /2026年10月22日 09:02:03/);
  assert.match(content, /项目未安装Gate/); assert.match(content, /自动复检/); assert.match(content, /未接入不等于扫描通过/);
  assert.match(content, /<at id=\\"verified-manager/); assert.match(content, /查看本次接入检查/);
});
test('姓名工号不推断飞书身份；无真实ID仍发送缺项卡', () => {
  const c = config(); c.people.manager.feishu.verified = false; c.people.author = { name: '杨晨誉', employeeId: '409322' };
  const out = opsNotification(report(), c);
  assert.equal(out.mentionMappingComplete, false); assert.deepEqual(out.mentions, []);
  assert.doesNotMatch(json(out.payload), /<at /); assert.match(json(out.payload), /真实 @ 尚未配置/);
});
test('同一人员去重，经理本人提交才同步指定观察人', () => {
  const r = report(); r.projects[0].executor = 'manager';
  const out = opsNotification(r, config()), content = json(out.payload);
  assert.deepEqual(out.mentions.sort(), ['verified-manager', 'verified-observer']);
  assert.equal((content.match(/<at id=\\"verified-manager/g) || []).length, 1);
  assert.equal((content.match(/<at id=\\"verified-observer/g) || []).length, 1);
});
test('同一飞书ID的不同人员键去重；额外主责和公共兜底人都实际出现在卡片中', () => {
  const r = report(), c = config(); c.people.author.feishu.id = c.people.manager.feishu.id;
  c.people.ops = person('运维', 'verified-ops'); c.owners['wl-produce'].recipients = ['ops']; c.fallbackRecipients = ['observer'];
  const out = opsNotification(r, c), content = json(out.payload);
  assert.deepEqual(out.mentions.sort(), ['verified-manager', 'verified-observer', 'verified-ops']);
  for (const id of out.mentions) assert.equal((content.match(new RegExp('<at id=\\\\"' + id, 'g')) || []).length, 1);
});
test('项目限前三摘要，但所有项目责任人仍提醒；不修改输入', () => {
  const r = report(), c = config();
  r.projects = Array.from({ length: 5 }, (_, i) => ({ ...r.projects[0], key: 'project-' + i, project: 'project-' + i, technicalManager: 'm' + i, executor: 'a' + i }));
  for (let i = 0; i < 5; i++) { c.people['m' + i] = person('经理' + i, 'manager-' + i); c.people['a' + i] = person('执行人' + i, 'author-' + i); }
  const before = json(r), out = opsNotification(r, c), content = json(out.payload);
  assert.match(content, /3\/5/); assert.doesNotMatch(content, /project-3 ·/); assert.equal(out.mentions.length, 10); assert.equal(json(r), before);
});
test('仅真实同源HTTPS本次记录可点击，缺失地址不伪造详情页', () => {
  for (const url of [undefined, 'http://localhost:8090/', 'https://attacker.invalid/', 'https://jenkins.example.invalid/?token=private']) {
    const r = report(); r.runUrl = url; const out = opsNotification(r);
    assert.doesNotMatch(json(out.payload), /open_url/); assert.doesNotMatch(json(out.payload), /private/);
  }
});
test('全局缺项分类且限前两条；恢复卡绿色但仍要求九维和Review', () => {
  const r = report(); r.globalGaps = Array.from({ length: 4 }, (_, i) => ({ id: 'credential-' + i, message: '公共凭据缺项' + i, action: '配置受控凭据' }));
  assert.match(json(opsNotification(r).payload), /凭据／访问权限 4/);
  r.globalGaps = []; r.projects[0].status = 'ready'; r.projects[0].gaps = []; r.status = 'ready'; r.recovered = true;
  const out = opsNotification(r, config()); assert.equal(out.payload.card.header.template, 'green'); assert.match(json(out.payload), /转入现有九维检查与Review准入/);
  r.globalGaps = [{ id: 'missing-config', message: '仍然缺配置' }]; assert.notEqual(opsNotification(r).payload.card.header.template, 'green');
});
test('只读取CI机器人、正确签名和飞书确认；密钥不出现在回执中', async () => {
  let calls = 0;
  const out = await sendOpsNotification(report(), config(), { env: { ...env, WL_FEISHU_PROJECT_WEBHOOK: 'https://wrong.invalid/' }, now: 123000, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, env.WL_FEISHU_CI_WEBHOOK); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.timestamp, '123');
    assert.equal(body.sign, createHmac('sha256', '123\nfixture-secret').update('').digest('base64')); assert.doesNotMatch(options.body, /fixture-secret/);
    return { status: 200, text: async () => '{"code":0}' };
  } });
  assert.equal(calls, 1); assert.equal(out.status, 'sent'); assert.equal(out.qualityPassed, false); assert.doesNotMatch(json(out), /fixture-secret|ci-fixture/);
});
test('超时未知不重发；HTTP和provider错误不可记sent；异常文本去敏', async () => {
  let calls = 0;
  const unknown = await sendOpsNotification(report(), config(), { env, fetchImpl: async () => { calls++; throw new Error('private-secret-token'); } });
  assert.equal(calls, 1); assert.equal(unknown.status, 'unknown'); assert.doesNotMatch(json(unknown), /private-secret-token/);
  for (const response of [{ status: 403 }, { status: 200, text: async () => '{"code":19021}' }, { status: 200, text: async () => '{"code":19021,"StatusCode":0}' }, { status: 200, text: async () => '{}' }]) assert.equal((await sendOpsNotification(report(), {}, { env, fetchImpl: async () => response })).status, 'rejected');
  assert.equal((await sendOpsNotification(report(), {}, { env, fetchImpl: async () => ({ status: 200, text: async () => 'bad-json' }) })).status, 'unknown');
});
test('不降级项目机器人；带凭据地址拒绝；无@不会阻止有效CI消息送达', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return { status: 200, text: async () => '{"StatusCode":0}' }; };
  assert.equal((await sendOpsNotification(report(), {}, { env: { WL_FEISHU_PROJECT_WEBHOOK: env.WL_FEISHU_CI_WEBHOOK, WL_FEISHU_PROJECT_SECRET: env.WL_FEISHU_CI_SECRET }, fetchImpl })).status, 'not-sent');
  assert.equal((await sendOpsNotification(report(), {}, { env: { ...env, WL_FEISHU_CI_WEBHOOK: 'https://name:password@open.feishu.cn/open-apis/bot/v2/hook/ci' }, fetchImpl })).status, 'not-sent');
  assert.equal(calls, 0);
  const out = await sendOpsNotification(report(), {}, { env, fetchImpl }); assert.equal(out.status, 'sent'); assert.equal(out.mentionMappingComplete, false); assert.equal(calls, 1);
});
test('缺项信息中的token或地址凭据去敏；报告类型无效拒绝', () => {
  const r = report(); r.projects[0].gaps[0].message = 'secret=really-private https://name:pass@internal.invalid/path?token=private';
  const content = json(opsNotification(r).payload); assert.doesNotMatch(content, /really-private|name:pass|token=private/);
  assert.throws(() => opsNotification({}), /真实运维接入检查报告/);
});
