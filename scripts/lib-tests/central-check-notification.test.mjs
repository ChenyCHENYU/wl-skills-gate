import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkSnapshot,centralCheckNotification} from '../../lib/central-check-notification.js';
const config={people:{dev:{name:'开发甲',feishu:{idType:'user_id',id:'test_dev'}},lead:{name:'经理乙',feishu:{idType:'user_id',id:'test_lead'}}},projects:{produce:{technicalManager:'lead',requireRiskMentions:true,scopes:{sit:{notification:{branch:'sit',surface:'project-summary'}}}}}};
function input(status='blocked'){
 const report={run:{startedAt:'2026-10-24T01:00:00Z',finishedAt:'2026-10-24T01:01:00Z',trace:{commits:[{subject:'fix(工单): 校验-补充输入边界'}]}},findings:Array.from({length:8},(_,i)=>({severity:i<5?'error':'warning',file:`src/Order${i}.java`,line:i+1,ruleId:'SQL/CONCAT',message:`风险${i}`,dimension:'coding'})),decision:{status}};
 const event={eventId:'one',project:'produce',scope:'sit',ref:'refs/heads/sit',sha:'a'.repeat(40),authorId:'dev',reportHash:'b'.repeat(64),reportUrl:'https://quality.example.invalid/one',pipelineUrl:'https://ci.example.invalid/job/1',jobId:'build',pipelineId:'1'};
 return {report,event};
}
test('中央检查失效不能把已有严重问题丢掉后显示数量改善',()=>{
 const {report,event}=input('invalid'),snapshot=checkSnapshot(report,event,config.projects.produce.scopes.sit.notification);
 assert.deepEqual(snapshot.totals,{blocker:0,error:5,warning:3,info:0});
 const result=centralCheckNotification(snapshot,config);assert.deepEqual(result.mentions,['test_dev','test_lead']);assert.equal(result.notificationComplete,true);
 assert.match(JSON.stringify(result.payload),/严重 5/);assert.match(JSON.stringify(result.payload),/当前检查结果 · 修复未核验/);
 assert.equal(result.payload.card.header.template,'red');assert.equal(snapshot.presentation.diagnosticCount,1);assert.match(JSON.stringify(result.payload),/检查失效/);
});
test('中央仅截取三项预览但统计保留全量、无重复检查失效标记，范围不符拒绝',()=>{
 const {report,event}=input('invalid');report.findings.push({severity:'error',ruleId:'GOV/CHECK-INVALID',file:'quality/policy',message:'失效'});
 const snapshot=checkSnapshot(report,event,config.projects.produce.scopes.sit.notification);assert.equal(snapshot.summary.findings.length,3);assert.equal(snapshot.totals.error,5);
 assert.throws(()=>checkSnapshot(report,{...event,ref:'refs/heads/main'},config.projects.produce.scopes.sit.notification),/实际分支/);
});
test('中央项目合并或CI通过消息依旧@双方，缺一人映射仍报告风险且不标通知完成',()=>{
 const {report,event}=input('passed');report.findings=[];
 const snapshot=checkSnapshot(report,event,config.projects.produce.scopes.sit.notification);
 const result=centralCheckNotification(snapshot,config);assert.deepEqual(result.mentions,['test_dev','test_lead']);
 const missing=structuredClone(config);delete missing.people.lead.feishu;
 const partial=centralCheckNotification(snapshot,missing);assert.deepEqual(partial.mentions,['test_dev']);assert.equal(partial.notificationComplete,false);
 assert.match(JSON.stringify(partial.payload),/责任人提醒未完成/);assert.equal(partial.payload.card.header.template,'orange');
});
