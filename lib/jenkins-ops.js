import path from 'node:path';
import {existsSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {loadJenkinsCluster,MAINTENANCE_JOBS} from './jenkins-cluster.js';
import {controlledPath,readControlledJson,writeExclusiveJson,lockedJson} from './control-store.js';
import {GATE_ROOT,GATE_VERSION,gateRuntimeHash,validateJenkinsRegistry,digest,assertBoundCheckout} from './jenkins-integration.js';
import {doctor} from './doctor.js';
import {safePath,actualSha,git} from './source-state.js';
import {stableStringify} from './util.js';
import {inspectJenkinsReadiness} from './jenkins-readiness.js';
import {entryPointHash,nativePipelineEntry} from './jenkins-entry-contract.js';
import {jobContract} from './jenkins-job-config.js';
import {fleetClient,jobPath} from './jenkins-fleet-client.js';
import {claimOpsCheck,acknowledgeOpsCheck} from './jenkins-ops-checks.js';
export {claimOpsCheck,acknowledgeOpsCheck} from './jenkins-ops-checks.js';
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const gap=(id,message,action)=>({id,message,action});
const branch=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(v)&&!v.includes('..')&&!v.endsWith('/')&&!v.includes('//');
const normalizeBranch=v=>String(v||'').replace(/^(?:refs\/heads\/|origin\/|\*\/)/,'');
const hash=v=>digest(stableStringify(v));
export function defaultOpsConfiguration(){return {schemaVersion:1,kind:'wl-quality-jenkins-ops',branches:['dev','sit','uat','pre','prd','main','test'],inventory:{roots:[''],maxJobs:1000,maxDepth:8},jobMappings:{},people:{},owners:{},fallbackRecipients:[]};}
export function opsContext(clusterFile){
 const c=loadJenkinsCluster(clusterFile);
 assert(c.nativeEntry.runtimeHash===gateRuntimeHash()&&digest(readFileSync(controlledPath(c.nativeEntry.loaderFile)))===c.nativeEntry.loaderHash,'公共入口或固定Gate漂移，先重新准备节点');
 const file=path.join(c.configDir,'jenkins-ops.json'),o=existsSync(file)?readControlledJson(file):defaultOpsConfiguration();
 assert(o.schemaVersion===1&&o.kind==='wl-quality-jenkins-ops'&&Object.keys(o).every(k=>['schemaVersion','kind','branches','inventory','jobMappings','people','owners','fallbackRecipients'].includes(k)),'运维巡检配置无效');
 assert(Array.isArray(o.branches)&&o.branches.length>0&&o.branches.every(branch)&&new Set(o.branches).size===o.branches.length,'巡检分支须明确且无重复');
 for(const k of ['jobMappings','people','owners'])assert(o[k]&&typeof o[k]==='object'&&!Array.isArray(o[k]),'运维巡检配置缺少'+k);
 const errors=[],bindings=[];
 for(const f of c.registryFiles){try{const r=validateJenkinsRegistry(readControlledJson(f));assert(r.jenkinsOrigin===c.jenkinsOrigin&&r.gateRoot===GATE_ROOT,'登记不是当前集群固定Gate');assert(entryPointHash(r.nativeEntry)===entryPointHash(c.nativeEntry),'登记公共入口已漂移');for(const b of r.bindings){assert(b.runtimeHash===gateRuntimeHash(),'登记Gate版本或字节已漂移');bindings.push({registryFile:f,binding:b,agentLabel:r.agentLabel});}}catch(e){errors.push(gap('REGISTRY','项目登记未就绪：'+path.basename(f),'按实际项目生成批准登记；当前不能启动构建'));}}
 return {c,o,bindings,registryErrors:errors};
}
function repository(value){
 if(typeof value!=='string'||value.length>1000||/[\s\u0000-\u001f]/.test(value))return false;
 if(/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value))return true;
 try{const u=new URL(value);return ['https:','ssh:'].includes(u.protocol)&&!!u.hostname&&!u.password&&(!u.username||u.protocol==='ssh:'&&u.username==='git')&&!u.search&&!u.hash&&/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(u.pathname);}catch{return false;}
}
function targetKey(v){return hash({job:v.job,repository:v.repository||null,branch:v.branch||null}).slice(0,24);}
function checkInventory(i,c){assert(i?.kind==='jenkins-ops-inventory'&&i.clusterHash===c.configHash&&i.runtimeHash===gateRuntimeHash()&&Array.isArray(i.targets)&&typeof i.runId==='string','盘点不是当前集群／固定Gate生成的本轮原件');}
export async function inventoryOps({clusterFile,env=process.env,fetchImpl=fetch}){
 const {c,o,bindings,registryErrors}=opsContext(clusterFile);
 const {discoverJenkinsJobs}=await import('./jenkins-inventory.js');
 const discovered=await discoverJenkinsJobs({jenkinsOrigin:c.jenkinsOrigin,inventory:o.inventory,env,fetchImpl});
 const client=fleetClient({origin:c.jenkinsOrigin,env,fetchImpl}),targets=[];
 for(const row of discovered.jobs){
  if(Object.values(MAINTENANCE_JOBS).includes(row.job))continue;
  const matches=bindings.filter(b=>Object.values(b.binding.jobs).includes(row.job));
  const gaps=[],bound=matches.length===1?matches[0]:null,mapping=o.jobMappings[row.job];
  if(matches.length>1)gaps.push(gap('DUPLICATE-REGISTRY','Job对应多份登记','清理重复登记后复查'));
  const candidates=row.scmCandidates||[];
  const scm=bound?{repository:bound.binding.repository,credentialId:bound.binding.scmCredentialId,branches:[bound.binding.branch]}:mapping?{repository:mapping.repository,credentialId:mapping.credentialId,branches:[mapping.branch]}:candidates.length===1?candidates[0]:null;
  const branches=scm?.branches?.map(normalizeBranch)||[];
  if(branches.length===1&&branch(branches[0])&&!o.branches.includes(branches[0]))continue;
  const t={job:row.job,jobs:[row.job],project:bound?.binding.project||mapping?.project||scm?.repository?.split(/[/:]/).at(-1)?.replace(/\.git$/,'')||row.job,repository:scm?.repository,credentialId:scm?.credentialId,branch:branches.length===1?branches[0]:null,gaps,configHash:row.configHash,managed:!!bound,bindingId:bound?.binding.id,registryFile:bound?.registryFile};
  if(!scm||!repository(t.repository)||!branch(t.branch)||!t.credentialId||!(/^[A-Za-z0-9_. -]{1,150}$/.test(t.credentialId))){gaps.push(gap('SCM-LOCATION','仓库、固定分支或SCM凭据不能唯一定位','在jenkins-ops.json的jobMappings一次确认该Job的仓库、分支、凭据ID；不按Job／视图名称猜测'));}
  if(!bound)gaps.push(gap('UNCONTROLLED-JOB','原流水线尚未接入Gate，当前不能证明它会拦截构建','完成项目接入与批准接线；巡检不会覆盖自定义部署／回滚脚本'));
  if(!bound&&!mapping&&row.discoveryGaps?.some(v=>v.code==='inline-candidate-unapproved'))gaps.push(gap('SCM-LOCATION','内联脚本仅取得候选，尚未确认实际仓库及分支','在jenkins-ops.json的jobMappings确认一次；不执行项目Jenkinsfile'));
  if(bound){try{const xml=await client.config(row.job);assert(xml,'已登记Job不存在');const contract=jobContract(xml);assert(contract.script===nativePipelineEntry(c.nativeEntry).trim()&&contract.sandbox==='true'&&contract.disabled==='false','业务Job未使用批准公共入口或已禁用');if(row.job===bound.binding.jobs.check){const trigger=contract.triggers.find(v=>v.type==='com.dabsquared.gitlabjenkins.GitLabPushTrigger');assert(trigger?.fields.includeBranchesSpec===bound.binding.branch&&trigger.fields.triggerOnPush==='true','CHECK未配置目标分支Push触发');}t.entryVerified=true;}catch{gaps.push(gap('JOB-ENTRY','已登记Job的实际入口或目标分支触发未核验通过','重新核对受控入口与任务状态，不沿用旧绿灯'));}}
  if(row.status==='unreadable')gaps.push(gap('JOB-UNREADABLE','任务配置未读到，无法核验接入状态','核对Jenkins范围内Read／ExtendedRead权限，再重新盘点'));
  t.checkoutAllowed=!gaps.some(g=>g.id==='SCM-LOCATION')&&row.status!=='unreadable';
  t.key=targetKey(t);targets.push(t);
 }
 return {schemaVersion:1,kind:'jenkins-ops-inventory',runId:randomUUID(),checkedAt:new Date().toISOString(),clusterHash:c.configHash,runtimeHash:gateRuntimeHash(),jenkinsOrigin:c.jenkinsOrigin,status:discovered.status,targets,errors:[...registryErrors,...(discovered.errors||[]).map(e=>gap('INVENTORY',e.reason||'任务未完整盘点','核对Jenkins只读权限及盘点预算后重跑'))],jobsDiscovered:discovered.jobs.length,remoteModified:false,qualityPassed:false,buildAuthorized:false};
}
export function inspectOpsProject({clusterFile,inventory,targetKey:key,root,failure}){
 const {c,bindings}=opsContext(clusterFile);checkInventory(inventory,c);const target=inventory.targets.find(t=>t.key===key);assert(target,'目标不在本轮盘点内');
 const out={...target,kind:'jenkins-ops-project',runId:inventory.runId,clusterHash:c.configHash,runtimeHash:gateRuntimeHash(),gaps:[...target.gaps],checkedAt:new Date().toISOString(),status:'attention',qualityPassed:false,buildAuthorized:false};
 if(!target.checkoutAllowed)return out;
 if(failure){out.gaps.push(gap('CHECKOUT','源码检出未成功','核对SCM只读凭据、分支及网络后复查；本轮未检查源码'));return out;}
 assert(target.checkoutAllowed,'未确认仓库或分支，不能执行检出检查');
 root=controlledPath(root);assert(git(['remote','get-url','origin'],root)===target.repository,'检出仓库与本轮盘点不一致');assert(actualSha(root)===git(['rev-parse','refs/remotes/origin/'+target.branch],root),'检出不是本轮固定目标分支');
 out.sha=actualSha(root);
 let manifest;try{manifest=JSON.parse(readFileSync(safePath(root,'quality/workspace.json')));assert(['frontend','backend'].includes(manifest.projectKind),'项目类型未确认');}catch{out.gaps.push(gap('PROJECT-GATE','项目尚未完整接入Gate：缺少有效quality/workspace.json','技术经理使用项目接入入口生成质量配置并提交，再自动复查'));}
 if(manifest){
  if(manifest.gateVersion!==GATE_VERSION)out.gaps.push(gap('GATE-VERSION','项目声明Gate版本与执行节点固定版不一致','按批准固定版本更新项目接入并重新登记'));
  try{const d=doctor({root,kind:manifest.projectKind});out.projectKind=manifest.projectKind;out.dependenciesPreparedByCheck=d.checks.filter(v=>v.status!=='passed'&&/^(INSTALLED-|ENGINES-)/.test(v.id)).map(v=>v.id);for(const v of d.checks.filter(v=>v.status!=='passed'&&!/^(INSTALLED-|ENGINES-)/.test(v.id)))out.gaps.push(gap(v.id,v.message,'修复项目接入配置并提交；已批准且锁定的依赖由CHECK自动准备'));}catch{out.gaps.push(gap('PROJECT-CONFIG','项目接入文件不完整或不可解析','修复接入文件后复查，不执行业务命令'));}
  for(const file of ['quality/review-policy.json','quality/review-evidence.plan.json'])try{const v=JSON.parse(readFileSync(safePath(root,file)));assert(v&&typeof v==='object','invalid');}catch{out.gaps.push(gap('REVIEW-FILE',file+'缺失或不可解析','完成当前项目九维证据计划和Review策略并提交'));}
 }
 const bound=bindings.find(b=>b.registryFile===target.registryFile&&b.binding.id===target.bindingId);
 if(bound&&manifest){try{const source=assertBoundCheckout({binding:bound.binding,mode:'check'},root,{});out.sourceDigest=source.sourceDigest;out.pinsVerified=true;}catch{out.gaps.push(gap('APPROVED-PINS','当前项目与已批准策略、锁或证据摘要不一致','工程维护者审阅差异并重新生成登记，巡检不自动批准策略变化'));}}
 if(bound&&target.job===bound.binding.jobs.check){out.checkJob=bound.binding.jobs.check;out.bindingHash=hash(bound.binding);}
 out.status=out.gaps.length?'attention':'ready';return out;
}
const escape=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function opsReportHtml(r){return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jenkins接入巡检</title><style>body{font:15px/1.6 system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#17283d}h1{font-size:24px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #dde4ec;padding:10px;text-align:left;vertical-align:top}th{background:#f1f5f9}.warn{color:#b42318}small{color:#526479}section{margin:24px 0}code{background:#eef2f6;padding:2px 4px}</style><h1>Jenkins接入巡检</h1><p>'+escape(r.checkedAt)+' · '+escape(r.status)+' · '+r.projects.length+'项</p><p class="warn">本页核验接入条件。未接入、未检查或尚未受控均不代表质量通过；九维取证、人工Review与构建准入仍以当前SHA的正式记录为准。</p>'+r.globalGaps.map(g=>'<p class="warn">'+escape(g.message)+'：'+escape(g.action)+'</p>').join('')+'<nav>'+r.projects.map(p=>'<a href="#'+escape(p.key)+'">'+escape(p.project)+' / '+escape(p.branch||'分支待确认')+'</a>　').join('')+'</nav>'+r.projects.map(p=>'<section id="'+escape(p.key)+'"><h2>'+escape(p.project)+' · '+escape(p.branch||'分支待确认')+'</h2><small>'+escape(p.jobs.join('，'))+' · '+escape(p.sha||'源码未核验')+'</small><table><tr><th>缺项</th><th>处理与复查</th></tr>'+p.gaps.map(g=>'<tr><td>'+escape(g.id)+' · '+escape(g.message)+'</td><td>'+escape(g.action)+'</td></tr>').join('')+(p.gaps.length?'':'<tr><td>接入前置已核验</td><td>由受控CHECK执行自动依赖准备、质量检查和九维取证；不授予构建权限</td></tr>')+'</table></section>').join('')+'</html>';}
export async function finishOps({clusterFile,inventory,results=[],env=process.env,send=false,retryNotification=false,fetchImpl=fetch,now=new Date().toISOString()}){
 const {c,o}=opsContext(clusterFile);checkInventory(inventory,c);const projects=[];
 const archive=path.join(c.configDir,'ops-state/runs',inventory.runId),reportFile=path.join(archive,'report.json');
 if(existsSync(reportFile)){const old=readControlledJson(reportFile);assert(old.clusterHash===c.configHash&&old.runId===inventory.runId,'已有巡检回执不属于当前集群，不覆盖');return old;}
 for(const t of inventory.targets){const matches=results.filter(r=>r.key===t.key&&r.runId===inventory.runId&&r.clusterHash===c.configHash&&r.runtimeHash===gateRuntimeHash());let p;if(matches.length===1)p=matches[0];else p={...t,status:'attention',gaps:[...t.gaps,gap('INSPECTION-MISSING','本轮未取得唯一项目检出核验结果','检查本轮失败阶段后重跑；不会使用历史扫描报告')]};const owner=o.owners[p.project]||{};projects.push({...p,technicalManager:owner.technicalManager,executor:owner.executor});}
 const readiness=inspectJenkinsReadiness({clusterFile:c.file}),globalGaps=[...inventory.errors];
 if(!inventory.targets.length)globalGaps.push(gap('NO-TARGETS','本轮没有核验到目标项目','确认盘点目录权限、项目范围及分支，不把空结果当接入通过'));
 for(const s of readiness.steps.filter(s=>s.status!=='passed'&&s.id!=='节点公共入口'))globalGaps.push(gap('CENTRAL-CONFIG',s.id+'未就绪','缺项通知可独立运行；实际九维检查、Review及续建需要对应批准配置'));
 const claimsFile=path.join(c.configDir,'ops-state/checks.json');
 if(existsSync(claimsFile)){const state=readControlledJson(claimsFile);for(const p of projects)if(Object.values(state.claims||{}).some(v=>v.status==='claimed'&&v.job===p.checkJob&&v.sha===p.sha&&v.bindingHash===p.bindingHash))p.gaps.push(gap('CHECK-DISPATCH-UNKNOWN','上轮CHECK启动结果尚未确认','核对实际CHECK运行后确认编号；未确认前不重复启动，也不放行构建'));for(const p of projects)if(p.gaps.length)p.status='attention';}
 let runUrl;try{const u=new URL(env.BUILD_URL);assert(u.origin===new URL(c.jenkinsOrigin).origin&&u.href===new URL(jobPath(env.JOB_NAME)+env.BUILD_NUMBER+'/',c.jenkinsOrigin).href,'invalid');runUrl=u.href;}catch{}
 const report={schemaVersion:1,kind:'jenkins-ops-report',runId:inventory.runId,clusterHash:c.configHash,checkedAt:now,jenkinsOrigin:c.jenkinsOrigin,...(runUrl?{runUrl}:{}),status:globalGaps.length||projects.some(p=>p.status!=='ready')?'attention':'ready',projects,globalGaps,counts:{projects:projects.length,attention:projects.filter(p=>p.status!=='ready').length,ready:projects.filter(p=>p.status==='ready').length},remoteModified:false,qualityPassed:false,buildAuthorized:false};
 const sortedGaps=g=>[...g].sort((a,b)=>stableStringify(a).localeCompare(stableStringify(b)));
 const fingerprint=hash({globalGaps:sortedGaps(globalGaps),projects:projects.map(p=>({key:p.key,status:p.status,gaps:sortedGaps(p.gaps)})).sort((a,b)=>a.key.localeCompare(b.key)),people:o.people,owners:o.owners,fallbackRecipients:o.fallbackRecipients});
 const stateFile=path.join(c.configDir,'ops-state/state.json');
 report.notification=await lockedJson(stateFile,{schemaVersion:1,kind:'jenkins-ops-state',notices:{}},async(state,checkpoint)=>{
  if(state.observedFingerprint!==fingerprint){state.epoch=(state.epoch||0)+1;state.observedFingerprint=fingerprint;}
  const eventKey=state.epoch+':'+fingerprint,previous=state.notices[eventKey];
  if(!send)return {status:'not-requested'};
  if(previous&&['sent','pending','unknown'].includes(previous.status)&&!retryNotification)return {status:previous.status==='sent'?'unchanged':'unknown',reason:'相同缺项不重复发送；未知送达先查上轮回执，需要补发时显式勾选RETRY_NOTIFICATION',priorRunId:previous.runId,
    providerAccepted:previous.status==='sent',notificationComplete:previous.notificationComplete===true,
    notificationStatus:previous.status==='sent'?(previous.notificationComplete===true?'complete':'attention'):'unknown',
    mentionDeliveryConfirmed:false,mentionMappingComplete:previous.mentionMappingComplete===true,mentionMissing:previous.mentionMissing||[]};
  report.recovered=report.status==='ready'&&state.lastSentStatus==='attention';
  if(report.status==='ready'&&!report.recovered)return {status:'not-required',reason:'无新增接入缺项；仍以正式检查与Review记录判定质量'};
  state.notices[eventKey]={status:'pending',runId:inventory.runId,checkedAt:now};checkpoint();
  const {sendOpsNotification}=await import('./jenkins-ops-notification.js');
  let result;try{result=await sendOpsNotification(report,{...o,presentationFile:path.join(c.configDir,'notification-presentation.json')},{env,fetchImpl,now:Date.parse(now)});}catch{result={status:'unknown',reason:'推送结果未确认，先核对群消息及上轮记录'};}
  state.notices[eventKey]={status:result.status,runId:inventory.runId,checkedAt:now,notificationComplete:result.notificationComplete===true,mentionMappingComplete:result.mentionMappingComplete===true,mentionMissing:result.mentionMissing||[]};if(result.status==='sent')state.lastSentStatus=report.status;
  return result;
 });
 writeExclusiveJson(reportFile,report);
 return report;
}
export async function runOpsCli(argv){
 const action=argv.shift(),o={};assert(['inventory','inspect','finish','claim-check','ack-check'].includes(action),'运维入口支持inventory/inspect/finish/claim-check/ack-check');
 while(argv.length){const k=argv.shift();assert(['--cluster','--out','--inventory','--target-key','--root','--failure','--results','--send','--retry-notification','--retry-unknown','--run-id','--build-number','--dispatch-id'].includes(k)&&!Object.hasOwn(o,k),'未知或重复运维巡检参数');if(['--send','--retry-notification','--retry-unknown'].includes(k))o[k]=true;else{const v=argv.shift();assert(v&&!v.startsWith('--'),'巡检参数缺值');o[k]=v;}}
 assert(o['--cluster']&&o['--out'],'运维巡检需要当前集群配置与本轮输出路径');
 let r;const clusterFile=path.resolve(o['--cluster']);
 if(action==='claim-check'||action==='ack-check'){assert(action!=='ack-check'||o['--dispatch-id'],'记录实际CHECK必须绑定本次dispatchId');r=await (action==='claim-check'?claimOpsCheck:acknowledgeOpsCheck)({clusterFile,runId:o['--run-id'],key:o['--target-key'],buildNumber:o['--build-number'],dispatchId:o['--dispatch-id'],retryUnknown:o['--retry-unknown']===true});}
 else if(action==='inventory')r=await inventoryOps({clusterFile});
 else{assert(o['--inventory'],'需要本轮盘点文件');const inventory=readControlledJson(path.resolve(o['--inventory']));if(action==='inspect')r=inspectOpsProject({clusterFile,inventory,targetKey:o['--target-key'],root:o['--root'],failure:o['--failure']});else{assert(o['--results'],'需要本轮核验结果目录');const dir=controlledPath(path.resolve(o['--results']));const results=existsSync(dir)?readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>readControlledJson(path.join(dir,f))):[];r=await finishOps({clusterFile,inventory,results,send:o['--send'],retryNotification:o['--retry-notification']===true});}}
 const file=controlledPath(path.resolve(o['--out']));if(existsSync(file))assert(stableStringify(readControlledJson(file))===stableStringify(r),'输出文件不是本轮原件，不覆盖');else writeExclusiveJson(file,r);
 if(action==='finish'){const {writeFileSync}=await import('node:fs');const html=controlledPath(path.join(path.dirname(file),'index.html')),text=opsReportHtml(r);if(existsSync(html))assert(readFileSync(html,'utf8')===text,'详情页不是本轮原件，不覆盖');else writeFileSync(html,text,{flag:'wx',mode:0o600});}
 console.log('运维巡检：'+r.status+'；本轮结果：'+path.basename(file)+(r.notification?'；飞书：'+r.notification.status:''));
 return action==='finish'&&(r.status!=='ready'||o['--send']&&(!['sent','unchanged','not-required'].includes(r.notification.status)||r.notification.notificationComplete===false))?2:0;
}
