import path from 'node:path';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {controlledPath,readControlledJson,writeExclusiveJson,lockedJson,acquireControlledLock} from './control-store.js';
import {validateJenkinsRegistry,renderJenkinsEntry,gateRuntimeHash,GATE_ROOT,digest} from './jenkins-integration.js';
import {fleetClient,jobPath,fleetAssert as assert} from './jenkins-fleet-client.js';
import {parseXml} from './xml.js';
import {jobContract,fleetWriteMatches,isManagedJob,renderFleetJob,jenkinsJobConfigHash,xmlDescendants,xmlOne} from './jenkins-job-config.js';
import {stableStringify} from './util.js';
import {loadAutomationConfig} from './automation.js';
const hash=value=>digest(typeof value==='string'||Buffer.isBuffer(value)?value:stableStringify(value));
const read=file=>readControlledJson(file);
const pin=file=>({file,hash:hash(readFileSync(file))});
const privateWrite=(file,value)=>{file=controlledPath(file);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file);};
const clean=message=>String(message).replace(/https?:\/\/[^\s]+/g,'[URL omitted]').slice(0,400);
const selected=(c,b)=>c.selection.projects.includes(b.project)&&c.selection.branches.includes(b.branch);
export function loadFleetConfig(file){
 file=controlledPath(file);const c=read(file),base=path.dirname(file);
 assert(c&&Object.keys(c).every(k=>['schemaVersion','kind','jenkinsOrigin','dataDir','registryFiles','automationConfigFile','selection','inventory','gitlab','approvers'].includes(k)),'批量接入清单字段无效');
 assert(c.schemaVersion===1&&c.kind==='wl-gate-jenkins-fleet','需要批量接入清单');
 const origin=new URL(c.jenkinsOrigin);assert(origin.protocol==='https:'&&!origin.username&&!origin.password&&origin.pathname==='/'&&!origin.search&&!origin.hash,'Jenkins入口须为批准HTTPS origin');c.jenkinsOrigin=origin.origin+'/';
 for(const key of ['dataDir','automationConfigFile']){assert(typeof c[key]==='string'&&c[key],`批量清单缺少${key}`);c[key]=controlledPath(path.resolve(base,c[key]));}
 assert(Array.isArray(c.registryFiles)&&c.registryFiles.length>0&&c.registryFiles.length<=1000,'需要1至1000份批准登记');c.registryFiles=c.registryFiles.map(f=>controlledPath(path.resolve(base,f)));assert(new Set(c.registryFiles).size===c.registryFiles.length,'登记文件重复');
 assert(c.selection&&Array.isArray(c.selection.projects)&&Array.isArray(c.selection.branches)&&c.selection.projects.length>0&&c.selection.branches.length>0,'必须明确本批项目和分支，不用视图名称或通配符授权');
 assert([...c.selection.projects,...c.selection.branches].every(v=>typeof v==='string'&&v&&!/[*?\r\n]/.test(v)),'项目和分支选择必须准确');
 c.inventory??={roots:[''],maxJobs:1000,maxDepth:8};assert(Array.isArray(c.inventory.roots)&&c.inventory.roots.length>0&&c.inventory.roots.every(v=>typeof v==='string')&&Number.isInteger(c.inventory.maxJobs)&&c.inventory.maxJobs>0&&c.inventory.maxJobs<=2000&&Number.isInteger(c.inventory.maxDepth)&&c.inventory.maxDepth>0&&c.inventory.maxDepth<=12,'盘点根目录、数量或深度预算无效');
 for(const r of c.inventory.roots)if(r)jobPath(r);
 assert(Array.isArray(c.approvers)&&c.approvers.every(v=>typeof v==='string'&&/^[A-Za-z0-9_.@-]+$/.test(v)),'审批人需真实Jenkins用户ID');
 if(c.gitlab){assert(Object.keys(c.gitlab).every(k=>['origin','tokenEnv','secretEnv'].includes(k)),'GitLab批量Hook配置字段无效');const u=new URL(c.gitlab.origin);assert(u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash,'GitLab须为批准HTTPS origin');c.gitlab.origin=u.origin;assert([c.gitlab.tokenEnv,c.gitlab.secretEnv].every(v=>/^[A-Z][A-Z0-9_]+$/.test(v)),'GitLab凭据必须使用环境变量引用');}
 if(process.env.WORKSPACE){const w=path.resolve(process.env.WORKSPACE);for(const f of [file,c.dataDir,c.automationConfigFile,...c.registryFiles])assert(!f.startsWith(w+path.sep)&&f!==w,'配置、登记和私有计划必须位于Jenkins工作区外');}
 return {...c,file,configHash:hash(readFileSync(file))};
}
function sourceFiles(c){const a=read(c.automationConfigFile),seen=new Set();assert(Array.isArray(a.sources)&&a.sources.length<=1000,'中央来源清单不完整');return a.sources.map(s=>{assert(typeof s.configFile==='string'&&s.configFile,'中央来源缺配置路径');const file=controlledPath(path.resolve(path.dirname(c.automationConfigFile),s.configFile));assert(!seen.has(file),'中央来源文件重复');seen.add(file);return {file,source:s,config:read(file),...pin(file)};});}
function allBindings(c){const seen=new Set(),registries=c.registryFiles.map(file=>({file,...pin(file),config:validateJenkinsRegistry(read(file))}));const rows=[];
 for(const r of registries){assert(r.config.jenkinsOrigin===c.jenkinsOrigin&&r.config.gateRoot===GATE_ROOT,'登记与实际Gate/Jenkins安装不一致');for(const b of r.config.bindings)if(selected(c,b)){assert(b.runtimeHash===gateRuntimeHash(),'登记仍引用旧包；工程侧先按当前固定包重生成登记');for(const [mode,job]of Object.entries(b.jobs)){assert(!seen.has(job),'同一Job不能跨登记/项目复用');seen.add(job);rows.push({registry:r,binding:b,mode,job});}}}
 assert(rows.length>0&&rows.length<=2000,'本批未匹配批准登记，或超过2000个Job预算');return {registries,rows};
}
export async function discoverFleet({configFile,env=process.env,fetchImpl=fetch}){
 const c=loadFleetConfig(configFile),client=fleetClient({origin:c.jenkinsOrigin,env,fetchImpl}),queue=c.inventory.roots.map(root=>({root,depth:0})),seen=new Set(),jobs=[],errors=[];
 while(queue.length){const {root,depth}=queue.shift();try{const data=await client.json((root?jobPath(root):'')+'api/json?tree=jobs[name,_class]');assert(Array.isArray(data.jobs),'盘点接口未返回任务列表');for(const j of data.jobs){assert(typeof j.name==='string'&&!j.name.includes('/'),'返回的任务名称无效');const full=root?root+'/'+j.name:j.name;jobPath(full);if(seen.has(full))continue;seen.add(full);assert(seen.size<=c.inventory.maxJobs,'盘点任务数超出批准预算');if(/Folder|OrganizationFolder|WorkflowMultiBranchProject/.test(j._class||'')){if(depth>=c.inventory.maxDepth)errors.push({job:full,reason:'目录超过深度预算，未完整盘点'});else queue.push({root:full,depth:depth+1});continue;}
 const record={job:full,type:j._class||'unknown',status:'unreadable'};try{const xml=await client.config(full);assert(xml!==null,'盘点期间Job消失');record.configHash=hash(xml);const tree=parseXml(xml);record.kind=tree.name;record.status='read';if(tree.name==='flow-definition'){const d=xmlOne(tree,'definition',false);record.definitionType=d?.attrs.class||'missing';record.managed=isManagedJob(xml);const script=d&&xmlOne(d,'script',false);if(script)record.scriptHash=hash(script.text);const scms=xmlDescendants(tree).filter(n=>n.attrs.class==='hudson.plugins.git.GitSCM');record.scm=scms.map(n=>({repositories:xmlDescendants(n).filter(v=>v.name==='url').map(v=>v.text).filter(v=>!/https?:\/\/[^\s/@]+:[^\s/@]+@/.test(v)),branches:xmlDescendants(n).filter(v=>v.name==='hudson.plugins.git.BranchSpec').flatMap(v=>v.children.filter(x=>x.name==='name').map(x=>x.text))}));}}
 catch(error){record.reason=clean(error.message);}jobs.push(record);}}
 catch(error){errors.push({root,reason:clean(error.message)});}}
 const result={schemaVersion:1,kind:'jenkins-fleet-inventory',status:errors.length||jobs.some(j=>j.status!=='read')?'attention':'inventoried',jobs,errors,configHash:c.configHash,viewNamesAreNotJobs:true,remoteModified:false};const file=path.join(c.dataDir,'inventories',randomUUID()+'.json');writeExclusiveJson(file,result);return {...result,inventoryFile:file};
}
const hookUrl=(c,job)=>new URL('project/'+job.split('/').map(encodeURIComponent).join('/'),c.jenkinsOrigin).href;
function gitlabClient(c,env,fetchImpl){assert(c.gitlab&&env[c.gitlab.tokenEnv],'缺少批准GitLab Hook服务凭据');return async(method,route,body)=>{const url=new URL(route,c.gitlab.origin);assert(url.origin===c.gitlab.origin,'GitLab Hook请求越出批准入口');let r;try{r=await fetchImpl(url.href,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{'PRIVATE-TOKEN':env[c.gitlab.tokenEnv],...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}catch{throw Error('GitLab请求结果未确认，保留记录，先对账');}assert([200,201,204].includes(r.status),'GitLab Hook接口失败：HTTP '+r.status);const chunks=[];let bytes=0;for await(const chunk of r.body||[]){bytes+=chunk.byteLength;assert(bytes<=4*1024*1024,'GitLab响应过大');chunks.push(Buffer.from(chunk));}const text=Buffer.concat(chunks).toString('utf8');try{return text?JSON.parse(text):null;}catch{throw Error('GitLab未返回有效JSON');}};}
async function hooksFor(api,projectId){assert(/^[1-9][0-9]*$/.test(String(projectId)),'GitLab项目ID须来自已批准的真实来源');const rows=[];for(let page=1;page<=20;page++){const data=await api('GET',`/api/v4/projects/${projectId}/hooks?per_page=100&page=${page}`);assert(Array.isArray(data),'GitLab Hook列表不完整');rows.push(...data);if(data.length<100)return rows;}throw Error('Hook列表超过分页预算');}
const validHook=(h,t)=>h.url===t.url&&h.push_events===true&&h.push_events_branch_filter===t.branch&&h.enable_ssl_verification===true&&['merge_requests_events','tag_push_events','pipeline_events','job_events','note_events'].every(k=>h[k]!==true);
async function hookPlan(c,entry,source,env,fetchImpl,cache){
 if(entry.mode!=='check')return null;const actor=source.config.actorSource;assert(c.gitlab&&actor?.system==='gitlab'&&actor.baseUrl.replace(/\/$/,'')===c.gitlab.origin,'CHECK须有同一批准GitLab来源与Hook入口配置');
 const target={projectId:String(actor.projectId),url:hookUrl(c,entry.job),branch:entry.binding.branch};const api=gitlabClient(c,env,fetchImpl);if(!cache.has(target.projectId))cache.set(target.projectId,await hooksFor(api,target.projectId));const found=cache.get(target.projectId).filter(h=>h.url===target.url);assert(found.length<=1,'同一CHECK存在重复Hook，需先清理重复触发');
 if(found.length){assert(validHook(found[0],target),'已有Hook的分支/事件/证书设置不符，不自动改写未知旧Token');return {...target,action:'reuse',id:found[0].id};}
 const tree=entry.beforeXml&&parseXml(entry.beforeXml),old=tree&&xmlDescendants(tree).find(n=>n.name==='secretToken')?.text;
 assert(!old||old===env[c.gitlab.secretEnv],'已有CHECK缺Hook且原Secret无法匹配；需提供同一Secret后重新预览');assert(env[c.gitlab.secretEnv]&&env[c.gitlab.secretEnv].length>=16,'新增Hook需要统一GitLab/Jenkins Secret（至少16字符），不是飞书签名');
 return {...target,action:'create',secretHash:hash(env[c.gitlab.secretEnv])};
}
function publicPlan(p){return {schemaVersion:1,kind:'jenkins-fleet-preview',status:p.entries.some(e=>e.blocker)?'blocked':'preview',planId:p.id,planHash:p.planHash,approvers:p.approvers,projects:[...new Set(p.entries.map(e=>e.project))],counts:{total:p.entries.length,create:p.entries.filter(e=>e.action==='create').length,update:p.entries.filter(e=>e.action==='update').length,noop:p.entries.filter(e=>e.action==='noop').length,blocked:p.entries.filter(e=>e.blocker).length},entries:p.entries.map(({job,project,branch,scope,mode,action,blocker,hook})=>({job,project,branch,scope,mode,action,...(blocker?{blocker}:{}),...(hook?{hookAction:hook.action}:{})})),privateBackupIncluded:false,businessRuntimeVerified:false};}
export async function planFleet({configFile,env=process.env,fetchImpl=fetch}){
 const c=loadFleetConfig(configFile),{registries,rows}=allBindings(c),sources=sourceFiles(c),client=fleetClient({origin:c.jenkinsOrigin,env,fetchImpl}),cache=new Map(),entries=[];
 for(const row of rows){const {binding:b,mode,job,registry:r}=row;const e={job,project:b.project,branch:b.branch,scope:b.scope,mode,registryFile:r.file,action:'blocked'};try{
  const matches=sources.filter(s=>s.config.system==='jenkins'&&s.config.baseUrl.replace(/\/$/,'')===c.jenkinsOrigin.slice(0,-1)&&s.config.jobPath===job&&s.config.project===b.project&&s.config.scope===b.scope&&s.config.ref.replace(/^(?:refs\/heads\/|origin\/)/,'')===b.branch&&!!s.source.buildResultPath===(mode==='build'));
  assert(matches.length===1,'缺少唯一且同项目/分支/scope的中央采集来源，先完成工程侧接入资料');const source=matches[0];
  if(mode==='build'){assert(hash(readFileSync(controlledPath(b.review.trustFile)))===b.review.trustHash&&hash(readFileSync(controlledPath(b.build.scriptFile)))===b.build.scriptHash,'Review信任或批准构建脚本已漂移');const {loadReleaseReviewTrust}=await import('./release-review.js');const trust=loadReleaseReviewTrust(b.review.trustFile,b.project);assert(trust.scope===b.scope&&trust.requireResolvedFindings===true&&trust.requireTechnicalManagerReview===true,'BUILD信任范围或严格清零配置不符');}
  const beforeXml=await client.config(job);e.beforeXml=beforeXml;e.beforeHash=beforeXml===null?null:hash(beforeXml);if(beforeXml!==null){assert(isManagedJob(beforeXml),'原任务包含自定义流水线：保留原配置，工程侧先确认构建/部署迁移；不批量覆盖');assert(!await client.busy(job),'Job正在运行或排队，稍后重试，不打断部署');}
  const desiredXml=renderFleetJob({beforeXml,script:renderJenkinsEntry(r.config,r.file),binding:b,mode,secret:c.gitlab&&env[c.gitlab.secretEnv]});e.desiredXml=desiredXml;e.contract=jobContract(desiredXml);e.action=beforeXml===null?'create':stableStringify(jobContract(beforeXml))===stableStringify(e.contract)?'noop':'update';e.sourceFile=source.file;e.sourceBeforeHash=source.hash;e.nativeEntry=r.config.nativeEntry||null;
  e.hook=await hookPlan(c,{...row,beforeXml},source,env,fetchImpl,cache);
 }catch(error){e.action='blocked';e.blocker=clean(error.message);}entries.push(e);}
 const id=randomUUID(),p={schemaVersion:1,kind:'jenkins-fleet-private-plan',id,createdAt:new Date().toISOString(),configFile:c.file,configHash:c.configHash,runtimeHash:gateRuntimeHash(),approvers:c.approvers,registries:registries.map(({file,hash})=>({file,hash})),automation:pin(c.automationConfigFile),sources:sources.filter(s=>entries.some(e=>e.sourceFile===s.file)).map(({file,hash})=>({file,hash})),entries};p.planHash=hash(p);
 const dir=path.join(c.dataDir,'plans',id);writeExclusiveJson(path.join(dir,'private-plan.json'),p);const summary=publicPlan(p);writeExclusiveJson(path.join(dir,'preview.json'),summary);return {...summary,planFile:path.join(dir,'private-plan.json')};
}
function readPlan(configFile,planFile,planHash){const c=loadFleetConfig(configFile);planFile=controlledPath(planFile);assert(planFile.startsWith(c.dataDir+path.sep+'plans'+path.sep),'计划须来自当前受控数据目录');const p=read(planFile),{planHash:actual,...body}=p;assert(planFile===path.join(c.dataDir,'plans',p.id,'private-plan.json')&&p.kind==='jenkins-fleet-private-plan'&&p.configFile===c.file&&p.configHash===c.configHash&&p.runtimeHash===gateRuntimeHash()&&hash(body)===actual&&(!planHash||planHash===actual),'清单/计划/运行时变化，重新预览');for(const item of p.registries)assert(hash(readFileSync(item.file))===item.hash,'批准登记发生变化，重新预览');return {c,p,dir:path.dirname(planFile)};}
const contractMatches=fleetWriteMatches;
function automationBinding(c){return hash({...c,governance:c.governance});}
function maintenance(c,p,dir){const a=read(c.automationConfigFile);const data=controlledPath(path.resolve(path.dirname(c.automationConfigFile),a.dataDir));const marker=path.join(data,'fleet-maintenance.json'),stateFile=path.join(data,'automation-state.json');mkdirSync(data,{recursive:true,mode:0o700});const release=acquireControlledLock(stateFile+'.lock',stateFile);try{if(existsSync(marker)){assert(read(marker).planId===p.id,'其他批次正在维护，不能同时改任务');return {marker,stateFile};}if(existsSync(stateFile)){const state=read(stateFile);assert(Object.values(state.runs||{}).every(r=>r.terminal&&Object.values(r.revisions||{}).every(v=>v.done||v.supersededForFreshness)),'中央仍有未完成采集，先让当前周期结束再执行接入');}writeExclusiveJson(marker,{schemaVersion:1,kind:'fleet-maintenance',planId:p.id,planFile:path.join(dir,'private-plan.json')});return {marker,stateFile};}finally{release();}}
async function syncPins(c,p,journal,maintenanceInfo,rollback=false,checkpoint=()=>{}) {
 let tx=journal.pinTransaction;
 if(tx?.completed)tx=null;
 if(tx)assert(tx.rollback===rollback,'先续跑未完成的摘要迁移，再执行回退');
 const stateExists=existsSync(maintenanceInfo.stateFile);
 if(!tx){
  const approved=new Map(p.sources.map(v=>[v.file,v])),patches=[];
  for(const e of p.entries){
   const row=journal.jobs[e.job];if(!row?.actualXml||!approved.has(e.sourceFile))continue;
   const file=e.sourceFile,current=readFileSync(file,'utf8'),value=JSON.parse(current),old=journal.sources[file]||{before:current,beforeHash:e.sourceBeforeHash};
   let after;
   if(rollback){if(!journal.sources[file])continue;assert(row.status==='rolled-back','Job尚未回退，不能先恢复中央来源');assert(hash(current)===old.afterHash,'来源配置已被其他人修改，不覆盖');after=old.before;}
   else{assert(hash(current)===old.beforeHash||hash(current)===old.afterHash,'中央来源已发生并发变化');if(e.nativeEntry){value.nativeEntry={runtimeHash:e.nativeEntry.runtimeHash,entryPointHash:hash(e.nativeEntry)};value.artifacts.paths=[...new Set([...value.artifacts.paths,'quality-reports/ci-integration/entry-context.json'])];}else assert(!value.nativeEntry,'已有公共入口不能自动降级为旧接线');value.jobConfigHashScheme='stable-v1';value.jobConfigHash=jenkinsJobConfigHash(row.actualXml,'stable-v1');after=JSON.stringify(value,null,2)+'\n';}
   if(current!==after)patches.push({file,before:current,after});
   if(!rollback)journal.sources[file]={...old,afterHash:hash(after)};
  }
  if(!patches.length){checkpoint();return;}
  let beforeBinding,afterBinding;
  if(stateExists){
   const old=loadAutomationConfig(c.automationConfigFile),next=structuredClone(old);
   for(const patch of patches){const source=next.sources.find(v=>v.configFile===patch.file),value=JSON.parse(patch.after);assert(source,'来源未在中央登记');delete source.config.jobConfigHashScheme;source.config.jobConfigHash=value.jobConfigHash;if(value.jobConfigHashScheme!==undefined)source.config.jobConfigHashScheme=value.jobConfigHashScheme;for(const key of ['nativeEntry','artifacts']){delete source.config[key];if(value[key]!==undefined)source.config[key]=value[key];}}
   beforeBinding=automationBinding(old);afterBinding=automationBinding(next);
  }
  tx={id:randomUUID(),rollback,patches,stateExists,beforeBinding,afterBinding,completed:false};
  journal.pinTransaction=tx;checkpoint(); // Durable intent before the first local write.
 }
 assert(tx.stateExists===stateExists,'中央状态在迁移过程中改变，保留维护状态');
 const migrate=()=>{
  for(const patch of tx.patches){const value=readFileSync(patch.file,'utf8');assert(value===patch.before||value===patch.after,'摘要迁移期间出现第三方改动，不覆盖');}
  for(const patch of tx.patches){const target=controlledPath(patch.file),tmp=target+'.'+tx.id+'.tmp';writeFileSync(tmp,patch.after,{mode:0o600});renameSync(tmp,target);}
  if(stateExists)assert(automationBinding(loadAutomationConfig(c.automationConfigFile))===tx.afterBinding,'中央迁移只能改变已批准Job摘要，不扩大授权');
 };
 if(stateExists)await lockedJson(maintenanceInfo.stateFile,{},state=>{
  assert([tx.beforeBinding,tx.afterBinding].includes(state.binding),'中央状态身份不匹配，不重置历史');migrate();state.binding=tx.afterBinding;state.history??=[];
  if(!state.history.some(v=>v.transactionId===tx.id))state.history.push({kind:'fleet-job-pin-migration',transactionId:tx.id,planId:p.id,rollback,files:tx.patches.map(v=>v.file),at:new Date().toISOString()});
  if(state.history.length>100)state.history.splice(0,state.history.length-100);
 });else migrate();
 for(const patch of tx.patches)if(rollback)delete journal.sources[patch.file];
 tx.completed=true;checkpoint();
}

function summaryOf(p,state){return {schemaVersion:1,kind:'jenkins-fleet-result',planId:p.id,planHash:p.planHash,status:state.status,jobs:Object.entries(state.jobs).map(([job,r])=>({job,status:r.status,reason:r.reason||null,jobConfigHash:r.configHash||null})),hooks:state.hooks,centralPinsSynchronized:state.pinsSynced===true,businessRuntimeVerified:false,nextAction:state.status==='configuration-verified'?'按验收清单执行真实合入、阻断、修复、Review、构建、群消息和报告权限验证。':'按失败项续跑同一计划或回退，不重置原始台账。'};}
export async function applyFleet({configFile,planFile,planHash,confirm=false,env=process.env,fetchImpl=fetch}){
 assert(confirm&&/^[a-f0-9]{64}$/.test(planHash||''),'批量写入须确认当前预览摘要');const {c,p,dir}=readPlan(configFile,planFile,planHash);assert(p.entries.every(e=>!e.blocker),'本批仍有阻断项；修复清单或缩小范围后重新预览');assert(p.approvers.length>0&&!p.approvers.some(v=>/REPLACE/.test(v)),'先登记真实Jenkins审批人');
 const client=fleetClient({origin:c.jenkinsOrigin,env,write:true,fetchImpl});let info,final;
 await lockedJson(path.join(dir,'journal.json'),{schemaVersion:1,planId:p.id,jobs:{},sources:{},hooks:[],status:'applying'},async(state,checkpoint)=>{
 assert(state.planId===p.id,'批次台账不匹配');assert(hash(readFileSync(c.automationConfigFile))===p.automation.hash,'中央调度清单变化，重新预览；未写入Job');assert(state.status!=='rolled-back','已回退批次不再执行接入，请重新预览');
 for(const source of p.sources){const current=hash(readFileSync(source.file)),known=state.sources[source.file];assert(current===source.hash||known&&current===known.afterHash,'中央来源已并发变化，重新预览；未写入Job');}
 info=maintenance(c,p,dir);
 for(const e of p.entries){const r=state.jobs[e.job]||={status:'pending'};try{let current=await client.config(e.job);
  if(r.status==='verified'&&current&&contractMatches(current,e)&&jenkinsJobConfigHash(current,'stable-v1')===r.configHash){r.actualXml=current;r.configHash=jenkinsJobConfigHash(current,'stable-v1');continue;}
  if(current!==null&&await client.busy(e.job))throw Error('Job正在运行/排队，未写入，稍后续跑');
  assert((current===null?null:hash(current))===e.beforeHash || r.writeAttempted===true,'Job配置并发变化，重新预览后再确认');
  if(current&&contractMatches(current,e)){r.status='verified';r.actualXml=current;r.configHash=jenkinsJobConfigHash(current,'stable-v1');checkpoint();continue;}
  assert((current===null?null:hash(current))===e.beforeHash,'Job配置并发变化，未覆盖');
  r.status='writing';r.writeAttempted=true;checkpoint();let error;
  try{await client.write(e.job,e.desiredXml,current===null);}catch(ex){error=ex;}
  current=await client.config(e.job);assert(current&&contractMatches(current,e),error?.message||'写后配置未匹配，不登记成功');r.status='verified';r.actualXml=current;r.configHash=jenkinsJobConfigHash(current,'stable-v1');delete r.reason;
 }catch(error){r.status='attention';r.reason=clean(error.message);}checkpoint();}
 for(const e of p.entries.filter(e=>e.hook&&state.jobs[e.job]?.status==='verified')){const h=e.hook;try{const api=gitlabClient(c,env,fetchImpl);let hooks=await hooksFor(api,h.projectId),found=hooks.filter(v=>v.url===h.url);assert(found.length<=1,'同一目标出现重复Hook');
  if(!found.length){assert(h.action==='create'&&hash(env[c.gitlab.secretEnv]||'')===h.secretHash,'Hook来源或Secret变化，重新预览');const prior=state.hooks.find(v=>v.url===h.url);assert(!prior||prior.status!=='unknown','上次Hook创建结果未知，先由核验操作对账，不重复创建');const progress={url:h.url,projectId:h.projectId,branch:h.branch,status:'unknown',created:true};state.hooks.push(progress);checkpoint();await api('POST',`/api/v4/projects/${h.projectId}/hooks`,{url:h.url,token:env[c.gitlab.secretEnv],push_events:true,push_events_branch_filter:h.branch,merge_requests_events:false,tag_push_events:false,pipeline_events:false,job_events:false,note_events:false,enable_ssl_verification:true});hooks=await hooksFor(api,h.projectId);found=hooks.filter(v=>v.url===h.url);assert(found.length===1&&validHook(found[0],h),'Hook创建后核验失败');progress.id=found[0].id;progress.status='verified';}
  else{assert(validHook(found[0],h),'Hook配置变化，未擅自覆盖');const prior=state.hooks.find(v=>v.url===h.url);if(prior){prior.id=found[0].id;prior.status='verified';}else state.hooks.push({...h,id:found[0].id,status:'verified',created:false});}
 }catch(error){const prior=state.hooks.find(v=>v.url===h.url);if(prior)prior.reason=clean(error.message);else state.hooks.push({url:h.url,projectId:h.projectId,status:'attention',reason:clean(error.message)});}checkpoint();}
 try{await syncPins(c,p,state,info,false,checkpoint);state.pinsSynced=true;delete state.pinFailure;}catch(error){state.pinsSynced=false;state.pinFailure=clean(error.message);}
 const good=Object.keys(state.jobs).length===p.entries.length&&Object.values(state.jobs).every(v=>v.status==='verified')&&p.entries.filter(e=>e.hook).every(e=>state.hooks.some(h=>h.url===e.hook.url&&h.status==='verified'))&&state.pinsSynced;
 state.status=good?'configuration-verified':'attention';checkpoint();final=summaryOf(p,state);privateWrite(path.join(dir,'result.json'),final);
 });
 // All known remote changes are pinned even on partial failure, so other scopes
 // may continue. A failed pin migration keeps the maintenance marker for resume.
 const state=read(path.join(dir,'journal.json'));if(state.pinsSynced&&info&&existsSync(info.marker)&&read(info.marker).planId===p.id)rmSync(info.marker);
 return final;
}
export async function verifyFleet({configFile,planFile,env=process.env,fetchImpl=fetch}){
 const {c,p,dir}=readPlan(configFile,planFile),client=fleetClient({origin:c.jenkinsOrigin,env,fetchImpl}),result={kind:'jenkins-fleet-verification',status:'configuration-verified',jobs:[],hooks:[],businessRuntimeVerified:false};
 for(const e of p.entries){try{const xml=await client.config(e.job);assert(xml&&contractMatches(xml,e),'Job入口/触发配置不匹配');const s=read(e.sourceFile);assert(s.jobConfigHashScheme==='stable-v1'&&jenkinsJobConfigHash(xml,'stable-v1')===s.jobConfigHash,'中央来源摘要未同步');result.jobs.push({job:e.job,status:'verified'});}catch(error){result.status='attention';result.jobs.push({job:e.job,status:'attention',reason:clean(error.message)});}}
 if(c.gitlab){const api=gitlabClient(c,env,fetchImpl);for(const e of p.entries.filter(e=>e.hook)){try{const found=(await hooksFor(api,e.hook.projectId)).filter(h=>h.url===e.hook.url);assert(found.length===1&&validHook(found[0],e.hook),'Hook数量/分支/事件不符合批准设置');result.hooks.push({job:e.job,status:'verified',id:found[0].id});}catch(error){result.status='attention';result.hooks.push({job:e.job,status:'attention',reason:clean(error.message)});}}}
 privateWrite(path.join(dir,'verification.json'),result);return result;
}
export async function rollbackFleet({configFile,planFile,planHash,confirm=false,env=process.env,fetchImpl=fetch}){
 assert(confirm&&planHash,'回退须确认原批次摘要');const {c,p,dir}=readPlan(configFile,planFile,planHash),client=fleetClient({origin:c.jenkinsOrigin,env,write:true,fetchImpl}),info=maintenance(c,p,dir);let final;
 await lockedJson(path.join(dir,'journal.json'),{},async(state,checkpoint)=>{assert(state.planId===p.id,'回退台账缺失或不匹配');for(const e of [...p.entries].reverse()){const r=state.jobs[e.job];if(!r?.actualXml)continue;try{const current=await client.config(e.job);if(r.status==='rolled-back'){assert(current&&jenkinsJobConfigHash(current,'stable-v1')===r.restoredHash,'已回退Job又发生变化，停止核销');continue;}assert(current&&jenkinsJobConfigHash(current,'stable-v1')===r.configHash,'Job已被其他人修改，不覆盖');assert(!await client.busy(e.job),'运行/排队中的Job不回退');let target=e.beforeXml;
  if(target===null){const t=parseXml(current),d=xmlOne(t,'disabled');d.text='true';const {serializeJobXml}=await import('./jenkins-job-config.js');target=serializeJobXml(t);}
  await client.write(e.job,target);const restored=await client.config(e.job);assert(restored&&(e.beforeXml===null?jobContract(restored).disabled==='true':jenkinsJobConfigHash(restored,'stable-v1')===jenkinsJobConfigHash(target,'stable-v1')),'回退后核验失败');r.status='rolled-back';r.restoredHash=jenkinsJobConfigHash(restored,'stable-v1');delete r.reason;
 }catch(error){r.status='rollback-attention';r.reason=clean(error.message);}checkpoint();}
 try{await syncPins(c,p,state,info,true,checkpoint);state.pinsSynced=true;}catch(error){state.pinsSynced=false;state.pinFailure=clean(error.message);}
 // New jobs are disabled, never deleted. Existing hooks and history are retained.
 // A new hook pointing at a disabled new Job cannot trigger builds.
 state.status=Object.values(state.jobs).every(r=>r.status==='rolled-back')&&state.pinsSynced?'rolled-back':'attention';checkpoint();final=summaryOf(p,state);privateWrite(path.join(dir,'rollback-result.json'),final);});
 const state=read(path.join(dir,'journal.json'));if(state.pinsSynced&&info&&existsSync(info.marker)&&read(info.marker).planId===p.id)rmSync(info.marker);return final;
}

export function fleetPlanFile(configFile,batch) {
 const c=loadFleetConfig(configFile);
 assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(batch||''),'续跑/核验/回退需要预览返回的批次ID');
 return path.join(c.dataDir,'plans',batch,'private-plan.json');
}
export async function runFleetCli(argv) {
 const [action,...args]=argv,options={};
 assert(['inventory','plan','show','apply','verify','rollback'].includes(action),'批量动作：inventory/plan/show/apply/verify/rollback');
 for(let i=0;i<args.length;i++){
  const k=args[i];assert(['--config','--batch','--plan-hash','--out','--confirm'].includes(k)&&!Object.hasOwn(options,k),'未知或重复批量参数');
  if(k==='--confirm')options[k]=true;else{const v=args[++i];assert(v&&!v.startsWith('--'),'批量参数缺少值');options[k]=v;}
 }
 assert(options['--config'],'批量接入需要--config');
 if(['inventory','plan','show','verify'].includes(action))assert(!options['--confirm']&&!options['--plan-hash'],'只读/预览动作不接受写入确认');
 if(['inventory','plan'].includes(action))assert(!options['--batch'],'盘点/预览不接受旧批次');
 const input={configFile:options['--config'],...(options['--batch']?{planFile:fleetPlanFile(options['--config'],options['--batch'])}:{}),planHash:options['--plan-hash'],confirm:options['--confirm']===true};
 if(['show','apply','verify','rollback'].includes(action))assert(input.planFile,'此动作需要--batch');
 const result=action==='show'?publicPlan(readPlan(input.configFile,input.planFile).p):await ({inventory:discoverFleet,plan:planFleet,apply:applyFleet,verify:verifyFleet,rollback:rollbackFleet}[action])(input);
 // Only this public summary can enter a workspace or artifact archive.
 delete result.planFile;
 if(options['--out']){const target=path.resolve(options['--out']);writeExclusiveJson(target,result);}
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 return ['attention','blocked'].includes(result.status)?2:0;
}
