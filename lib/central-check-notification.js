import {pipelineCheckNotification} from './pipeline-notification.js';
import {findingPreview} from './notification-style.js';
import {sha256,stableStringify} from './util.js';

export const scopeNotification=(config,project,scope)=>config.projects[project].scopes[scope].notification;
export const scopeChannel=(config,project,scope)=>scopeNotification(config,project,scope)?.channel || config.projects[project].channel;
const branch=ref=>ref?.replace(/^(?:refs\/remotes\/origin\/|refs\/heads\/|origin\/)/,'');
const short=(value,max=500)=>typeof value==='string'?[...value].slice(0,max).join(''):value;

// Immutable, bounded view of an already validated full source report. The full
// nine-dimensional report stays archived; one outbox row per run, not per risk.
export function checkSnapshot(report,event,notification){
  const findings=report.decision.status==='invalid'?[{severity:'error',ruleId:'GOV/CHECK-INVALID',file:'quality/policy',message:'检查执行失效，修复接线后重跑',dimension:'scan'}]:report.findings;
  const totals=Object.fromEntries(['blocker','error','warning','info'].map(level=>[level,findings.filter(f=>f.severity===level).length]));
  const preview=findingPreview(findings).visible.map(f=>Object.fromEntries(['severity','ruleId','file','line','endLine','message','suggestion','dimension'].filter(k=>f[k]!==undefined).map(k=>[k,short(f[k])])));
  const actualBranch=branch(event.ref);
  if(actualBranch!==notification.branch)throw Error('质量事件实际分支与通知批准分支不一致');
  const commit=report.run.trace?.commits?.[0];
  return {schemaVersion:1,kind:'quality-check-notification',eventId:event.eventId,project:event.project,scope:event.scope,sha:event.sha,authorId:event.authorId,reportHash:event.reportHash,
    reportUrl:event.reportUrl,pipelineUrl:event.pipelineUrl,totals,
    summary:{run:{project:event.project,commitSha:event.sha,stage:'ci',eventId:event.reportEventId || event.eventId,startedAt:report.run.startedAt,...(report.run.finishedAt?{finishedAt:report.run.finishedAt}:{}),
      trace:{branch:actualBranch,...(commit?{commits:[{subject:short(commit.subject,250)}]}:{})}},decision:{status:report.decision.status},findings:preview},
    presentation:{submitterId:event.authorId,reportUrl:event.reportUrl,pipelineLabel:`${event.jobId} · 运行 ${event.pipelineId}`,surface:notification.surface,approvedBranch:notification.branch,validationBranch:notification.validationBranch===true,requireResolvedFindings:notification.requireResolvedFindings===true,
      executionStates:[{name:'完整代码检查',status:report.decision.status==='passed'?'passed':'blocked',result:report.decision.status==='passed'?'机器结果已记录':'未通过，修复后复扫'},{name:'正式Review / 业务构建',status:'pending',result:'本条仅为检查结果；以独立正式记录为准'}]}};
}
export function checkSnapshotHash(snapshot){return sha256(stableStringify(snapshot));}
export function centralCheckNotification(snapshot,config){
  const project=config.projects[snapshot.project],n=scopeNotification(config,snapshot.project,snapshot.scope);
  const viewConfig={...config,projects:{...config.projects,[snapshot.project]:{...project,...(n.technicalManager?{technicalManager:n.technicalManager}:{})}}};
  const result=pipelineCheckNotification({summary:snapshot.summary,notificationTotals:snapshot.totals,presentation:snapshot.presentation},viewConfig);
  if(!result.payload)throw Error('批准检查消息被错误跳过');
  return result;
}
