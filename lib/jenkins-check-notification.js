// Trusted post-check presentation. Never called while project scripts execute.
import path from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {controlledPath,readControlledJson,lockedJson} from './control-store.js';
import {inspectJenkinsBinding,assertBoundCheckout,digest,inside} from './jenkins-integration.js';
import {assertNativeProof,ENTRY_CONTEXT_PATH,entryPointHash} from './jenkins-entry-contract.js';
import {publicationInput,verifyPublishedQualityReport} from './report-publication.js';
import {loadOpsDirectory,mergeOpsDirectory} from './ops-responsibility.js';
import {pipelineCheckNotification} from './pipeline-notification.js';
import {deliverCiNotification} from './jenkins-ops-notification.js';
import {git,safePath} from './source-state.js';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const findings=report=>(report.findings||[]).filter(f=>f.ruleId!=='GOV/CHECK-INVALID');

// Across different commits this describes observations, never claims a repair or closure.
export function checkObservations(before,after,{ancestorVerified=false}={}){
 if(!before||!ancestorVerified)return null;
 if(before.run.project!==after.run.project||before.run.stage!=='ci'||after.run.stage!=='ci'||before.run.profile!==after.run.profile)return null;
 for(const key of ['policyHash','ruleSetHash','baselineHash','waiversHash'])if(!before.policy?.[key]||before.policy[key]!==after.policy?.[key])return null;
 const prior=findings(before),current=findings(after),ids=new Set(prior.map(f=>f.fingerprint)),next=new Set(current.map(f=>f.fingerprint));
 if([...prior,...current].some(f=>!/^[a-f0-9]{64}$/.test(f.fingerprint||'')))return null;
 const absent=prior.filter(f=>!next.has(f.fingerprint));
 const rechecked=f=>{
  const old=before.checks?.find(c=>c.checkId===f.checkId),check=after.checks?.find(c=>c.checkId===f.checkId);
  return !!old&&!!check&&old.status==='ok'&&check.status==='ok'&&check.toolVersionVerified===true&&check.toolVersion===old.toolVersion&&check.coverage?.complete!==false;
 };
 return {previousBuild:before.buildNumber,previousSha:before.run.commitSha,added:current.filter(f=>!ids.has(f.fingerprint)).length,
  notSeen:absent.filter(rechecked).length,recheckUnavailable:absent.filter(f=>!rechecked(f)).length,remaining:current.length,observationOnly:true,repaired:null,closed:false,
  complete:after.decision.status!=='invalid'&&(after.checks||[]).every(c=>c.status==='ok')};
}

export function checkNotice({report,dimensions=[],binding,people,owner,executor,publication,job,number,changedFiles=[],observations,networkAccess}){
 assert(report.run.stage==='ci'&&report.run.project===binding.project&&report.run.trace?.branch===binding.branch,'通知报告不是批准项目/分支的CI结果');
 const current={...report,findings:findings(report)};
 const changed=current.findings.filter(f=>changedFiles.includes(f.file));
 const project={domain:owner.domain,technicalManager:owner.technicalManager,managerSubmissionNotify:owner.managerSubmissionNotify};
 return pipelineCheckNotification({summary:current,dimensions,presentation:{submitterId:executor,reportUrl:publication.reportUrl,
  pipelineLabel:`${job} · #${number}`,approvedBranch:binding.branch,validationBranch:binding.validationBranch,
  requireResolvedFindings:true,networkAccess,logUrl:new URL('console',publication.buildUrl).href,logView:'report-summary',
  changeFindings:changed,observations,executionStates:[{name:'代码检查',status:report.decision.status==='passed'?'passed':'blocked',result:report.decision.status==='invalid'?'部分检查失效，已产生的发现仍须处理':report.decision.status==='passed'?'本轮机器检查完成':'本轮未通过'},
   {name:'正式Review与构建',status:'not-run',result:'未放行；以当前提交的正式Review与准入记录为准'}]}},{projects:{[binding.project]:project},people});
}

export async function notifyJenkinsCheck({registryFile,configDir,root=process.cwd(),env=process.env,fetchImpl=fetch,now=Date.now}={}){
 root=controlledPath(path.resolve(root));configDir=controlledPath(path.resolve(configDir));assert(!inside(root,configDir),'通知配置和状态须位于业务工作区外');
 const context=inspectJenkinsBinding({registryFile,root,env}),binding=context.binding;assert(context.mode==='check','只有当前批准CHECK能发送该结果');
 const source=assertBoundCheckout(context,root,env);
 const raw=readFileSync(controlledPath(safePath(root,'quality-reports/quality-summary.json')));assert(raw.length<=32*1024*1024,'报告超出通知预算');
 const report=JSON.parse(raw);assert(report.run.project===binding.project&&report.run.commitSha===source.sha&&report.run.sourceDigest===source.sourceDigest&&report.run.stage==='ci','通知不得使用其他源码、阶段或旧报告');
 const proof=readControlledJson(safePath(root,ENTRY_CONTEXT_PATH));assertNativeProof(proof,{project:binding.project,scope:binding.scope,jobPath:env.JOB_NAME,nativeEntry:{runtimeHash:context.config.nativeEntry.runtimeHash,entryPointHash:entryPointHash(context.config.nativeEntry)}},{sha:source.sha,runId:env.BUILD_NUMBER});
 assert(proof.bindingHash===context.bindingHash&&proof.registryHash===context.registryHash&&proof.sourceDigest===source.sourceDigest,'通知公共入口证据已漂移');
 const publication=readControlledJson(safePath(root,'quality-reports/report-publication.json'));
 assert(publication.kind==='quality-report-archive'&&publication.project===binding.project&&publication.stage==='ci'&&publication.eventId===report.run.eventId&&publication.commitSha===source.sha&&publication.buildUrl===env.BUILD_URL&&publication.summarySha256===digest(JSON.stringify(report,null,2)+'\n'),'发布归档不是当前运行原件');
 const verified=await verifyPublishedQualityReport({manifestFile:publication.manifestFile,expectedOrigin:context.config.jenkinsOrigin,user:env.WL_JENKINS_REPORT_USER,token:env.WL_JENKINS_REPORT_TOKEN,fetchImpl,now:typeof now==='function'?now():now});
 const opsFile=path.join(configDir,'jenkins-ops.json');const ops=existsSync(opsFile)?readControlledJson(opsFile):{};
 const config=mergeOpsDirectory(ops,loadOpsDirectory(configDir));const owner=config.owners?.[binding.project]||{};
 const executor=[env.WL_GATE_BUILD_USER_ID,env.BUILD_USER_ID,env.gitlabUserUsername].find(id=>id&&config.people?.[id]);
 const previousFile=path.join(configDir,'check-notification-state',digest(`${env.JOB_NAME}:${binding.id}`)+'.json');
 const input=publicationInput({summaryFile:safePath(root,'quality-reports/quality-summary.json'),reviewIndexFile:safePath(root,'quality-reports/review-latest.json')});
 return lockedJson(previousFile,{schemaVersion:1,kind:'wl-ci-notification-state',attempts:{}},async(state,checkpoint)=>{
  assert(state.kind==='wl-ci-notification-state'&&state.schemaVersion===1&&state.attempts&&typeof state.attempts==='object','通知状态无效');
  const key=String(env.BUILD_NUMBER),hash=digest(raw),prior=state.attempts[key];
  if(prior){assert(prior.summaryHash===hash,'同一运行报告发生变化，不覆盖已有通知');return {...prior.receipt,status:prior.receipt?.status||'unknown',reused:true};}
  let ancestorVerified=false,reference=state.last?.run?.commitSha||binding.approvedSource.sha,changedFiles=[];
  try{git(['merge-base','--is-ancestor',reference,source.sha],root);ancestorVerified=true;changedFiles=git(['diff','--no-ext-diff','--name-only',reference,source.sha],root).split('\n').filter(Boolean);}catch{}
  const observations=checkObservations(state.last,report,{ancestorVerified});
  const notice=checkNotice({report,dimensions:input.dimensions,binding,people:config.people||{},owner,executor,publication:{...verified,buildUrl:env.BUILD_URL},job:env.JOB_NAME,number:env.BUILD_NUMBER,changedFiles,observations,networkAccess:config.networkAccess});
  // A crash after dispatch remains unknown; rerunning does not send a duplicate.
  state.attempts[key]={summaryHash:hash,receipt:{status:'unknown',reason:'本轮发送已占位；核对群消息后人工处理，禁止自动重复发送',providerAccepted:false,buildAuthorized:false}};checkpoint();
  const receipt=await deliverCiNotification(notice,{presentationFile:path.join(configDir,'notification-presentation.json')},{env,fetchImpl,now});
  state.attempts[key].receipt=receipt;
  state.last={run:report.run,policy:report.policy,decision:report.decision,checks:report.checks,buildNumber:key,findings:findings(report).map(f=>({fingerprint:f.fingerprint,severity:f.severity,checkId:f.checkId}))};
  // Bound retry metadata while retaining the previous actual observation.
  for(const old of Object.keys(state.attempts).sort((a,b)=>Number(b)-Number(a)).slice(20))delete state.attempts[old];
  return {...receipt,observations,reportUrl:verified.reportUrl};
 });
}
