import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { opsNotification, sendOpsNotification } from '../../lib/jenkins-ops-notification.js';

const report = () => ({ kind: 'jenkins-ops-report', checkedAt: '2026-10-22T01:02:03Z', jenkinsOrigin: 'https://jenkins.example.invalid/', runUrl: 'https://jenkins.example.invalid/job/doctor/7/', links:{status:'verified',reportUrl:'https://jenkins.example.invalid/job/doctor/7/artifact/wl-ops-public/index.html',logUrl:'https://jenkins.example.invalid/job/doctor/7/console'}, status: 'attention', globalGaps: [], projects: [{ key: 'p:test', project: 'wl-produce', branch: 'test', jobs: ['p-test'], status: 'attention', gaps: [{ id: 'gate-package-missing', message: '项目未安装Gate', action: '技术经理执行项目接入，再自动复检' }], technicalManager: 'manager', executor: 'author' }], remoteModified: false, qualityPassed: false, buildAuthorized: false });
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
  assert.match(content, /<at id=\\"verified-manager/); assert.match(content, /artifact\/wl-ops-public\/index.html/); assert.match(content, /详情/); assert.match(content, /日志/);
});
test('姓名工号不推断飞书身份；无真实ID仍发送缺项卡', () => {
  const c = config(); c.people.manager.feishu.verified = false; c.people.author = { name: '杨晨誉', employeeId: '409322' };
  const out = opsNotification(report(), c);
  assert.equal(out.mentionMappingComplete, false); assert.deepEqual(out.mentions, []);
  assert.doesNotMatch(json(out.payload), /<at /); assert.match(json(out.payload), /真实 @ 尚未配置/);
});
test('缺执行人或隐藏项目缺技术经理都不可误记提醒完整，保留已配置人员@',()=>{
  const r=report(),c=config();delete r.projects[0].executor;
  const out=opsNotification(r,c);assert.equal(out.mentionMappingComplete,false);assert.deepEqual(out.mentions,['verified-manager']);
  assert(out.mentionMissing.some(item=>item.role==='执行人'));
  assert.match(json(out.payload),/执行人.*责任人待登记/);
  r.projects=Array.from({length:4},(_,i)=>({...report().projects[0],key:'p'+i,project:'project-'+i}));
  delete r.projects[3].technicalManager;
  const hidden=opsNotification(r,c);assert.equal(hidden.notificationComplete,false);
  assert(hidden.mentionMissing.some(item=>item.project==='project-3'&&item.role==='技术经理'));
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
test('运维发送端热读显示配置并返回版本，缺项与@事实不被显示配置改变',async t=>{
 const dir=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-ops-presentation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'notification-presentation.json'),c={...config(),presentationFile:file};let sent;
 const fetchImpl=async(url,options)=>{sent=JSON.parse(options.body);return {status:200,text:async()=>'{"code":0}'};};
 const run=async revision=>{writeFileSync(file,JSON.stringify({schemaVersion:1,kind:'wl-notification-presentation',revision,brandSuffix:revision==='display-1'?'WL':'World Leading'}));return sendOpsNotification(report(),c,{env,fetchImpl});};
 const first=await run('display-1');assert.equal(first.notificationPresentation.revision,'display-1');assert.match(sent.card.header.title.content,/WL$/);
 const second=await run('display-2');assert.equal(second.notificationPresentation.revision,'display-2');assert.match(sent.card.header.title.content,/World Leading$/);assert.deepEqual(second.mentions,first.mentions);
 assert.match(json(sent),/项目未安装Gate/);for(const id of first.mentions)assert(json(sent).includes(`<at id=\\"${id}\\"></at>`));
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
  assert.equal(out.providerAccepted,true);assert.equal(out.notificationComplete,false);assert.equal(out.notificationStatus,'attention');
  assert.equal(out.mentionDeliveryConfirmed,false);assert(out.mentionMissing.length>0);assert.match(out.reason,/提醒尚未完成/);
});
test('缺项信息中的token或地址凭据去敏；报告类型无效拒绝', () => {
  const r = report(); r.projects[0].gaps[0].message = 'secret=really-private https://name:pass@internal.invalid/path?token=private';
  const content = json(opsNotification(r).payload); assert.doesNotMatch(content, /really-private|name:pass|token=private/);
  assert.throws(() => opsNotification({}), /真实运维接入检查报告/);
});

test('零项目认证失败只突出根因，内部任务及凭据编号不当作业务名称',()=>{
  const r=report(),c=config();r.projects=[];r.execution={job:'wl-quality-doctor',number:105};
  r.inventory={readerAccount:'existing-user',readVerified:false};
  r.globalGaps=[{id:'JENKINS-AUTH',message:'巡检凭据wl-jenkins-ci-readonly认证失败（HTTP 401）'},
    {id:'NO-TARGETS',message:'未识别业务项目'},{id:'REGISTRY',message:'项目登记未就绪：jenkins-bindings.json'}];
  r.links={status:'unverified',reason:'详情归档HTTP 401'};c.publicTasks={recipients:['author','manager']};
  const original=json(r),out=opsNotification(r,c),content=json(out.payload);
  assert.match(content,/公共巡检｜账号认证失败/);assert.match(content,/第105次/);
  assert.match(content,/existing-user/);assert.match(content,/真实Jenkins登录用户名/);
  assert.match(content,/未检查项目Gate/);assert.match(content,/未执行九维/);
  assert.doesNotMatch(content,/wl-quality-doctor|wl-jenkins-ci-readonly|jenkins-bindings|接入缺项 3|另有 2/);
  assert.doesNotMatch(content,/open_url/);assert.equal(json(r),original);
  assert.deepEqual(out.mentions.sort(),['verified-author','verified-manager']);
});

test('403、空范围和部分项目结果分别展示，避免错判认证失败或隐藏真实项目',()=>{
  const r=report();r.projects=[];r.globalGaps=[{id:'JENKINS-PERMISSION',message:'任务HTTP 403'}];
  let content=json(opsNotification(r,config()).payload);
  assert.match(content,/任务读取受限/);assert.match(content,/ExtendedRead/);assert.doesNotMatch(content,/HTTP 401/);
  r.globalGaps=[{id:'NO-TARGETS',message:'未找到目标分支'}];r.inventory={readVerified:true};
  content=json(opsNotification(r,config()).payload);assert.match(content,/尚未识别可检查/);assert.doesNotMatch(content,/本轮未读取业务项目/);
  r.projects=report().projects;r.globalGaps=[{id:'JENKINS-AUTH',message:'其他目录HTTP 401'}];
  content=json(opsNotification(r,config()).payload);assert.match(content,/wl-produce/);assert.match(content,/项目未安装Gate/);
});
