import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationRecipients, notificationMentionWarning, responsibilityReminder} from '../../lib/notification-people.js';

const people={dev:{name:'执行人',feishu:{idType:'user_id',id:'verified-dev',verified:true}},manager:{name:'技术经理',feishu:{idType:'open_id',id:'ou_manager',verified:true}},observer:{name:'李月',employeeId:'028143',feishu:{idType:'user_id',id:'verified-observer',verified:true}}};
const project={technicalManager:'manager',managerSubmissionNotify:'observer'};
test('统一收件人契约始终保留执行人与技术经理，提醒不授予权限',()=>{
 const result=notificationRecipients('dev',project,people);
 assert.equal(result.complete,true);assert.deepEqual(result.mentions,['verified-dev','ou_manager']);
 assert.equal(notificationMentionWarning(result),'');
 const body=responsibilityReminder({...result,people,closed:true});
 for(const id of result.mentions)assert(body.includes(`<at id="${id}"></at>`));
 assert.match(body,/当前报告、修复证据与回归结果/);
});
test('经理本人及同ID别名提交，经理仍@一次，并额外@指定同步人',()=>{
 for(const actor of ['manager','alias']){
  const result=notificationRecipients(actor,project,{...people,alias:{...people.manager}});
  assert.equal(result.managerSubmission,true);assert.deepEqual(result.mentions,['ou_manager','verified-observer']);
  const body=responsibilityReminder({...result,people:{...people,alias:{...people.manager}}});
  assert.equal(body.split('<at id="ou_manager"></at>').length-1,1);
 }
 const noObserver=notificationRecipients('manager',{technicalManager:'manager'},people);
 assert.equal(noObserver.complete,false);assert.deepEqual(noObserver.mentions,['ou_manager']);
 assert.match(notificationMentionWarning(noObserver),/经理本人提交同步人.*未登记/);
});
test('缺一方不能静默称完整，保留另一方有效@；不从工号推导ID，不@all',()=>{
 const p={...people,dev:{name:'杨晨誉',employeeId:'409322'}};
 const result=notificationRecipients('dev',project,p);
 assert.deepEqual(result.mentions,['ou_manager']);assert.equal(result.complete,false);
 assert.deepEqual(result.missing,[{role:'执行人',actor:'dev',reason:'缺少有效的飞书身份映射'}]);
 assert.match(notificationMentionWarning(result),/通知尚未完成/);
 for(const id of ['all','<at id="all"></at>','name@example.invalid']){
  const bad={...people,dev:{name:'执行人',feishu:{idType:'user_id',id}}};
  const out=notificationRecipients('dev',project,bad);assert.equal(out.complete,false);assert.deepEqual(out.mentions,['ou_manager']);
  assert.doesNotMatch(responsibilityReminder({...out,people:bad}),/<at id="all"/);
 }
});
test('运维场景要求身份经过验证；语法正确的候选ID仍是待确认',()=>{
 const p=structuredClone(people);delete p.dev.feishu.verified;
 const result=notificationRecipients('dev',project,p,{requireVerified:true});
 assert.equal(result.complete,false);assert.deepEqual(result.mentions,['ou_manager']);assert.equal(result.missing[0].reason,'飞书身份尚未验证');
});
