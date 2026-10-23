import path from 'node:path';
import os from 'node:os';
import {existsSync,lstatSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,chmodSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

// This module updates local, package-owned assets only. It never dispatches a
// build, writes a Jenkins job, sends a notice, or approves a quality policy.
const hash=x=>createHash('sha256').update(x).digest('hex');
const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const json=x=>JSON.stringify(x,null,2)+'\n';
const fail=(message,code='UPDATE-BLOCKED')=>Object.assign(new Error(message),{code});
const assert=(ok,message,code)=>{if(!ok)throw fail(message,code);};
const sha=/^[a-f0-9]{64}$/;
const protectedProject=relative=>/^(?:quality\/(?!workspace\.json$)|package\.json$|quality-tools\/(?:package(?:-lock)?\.json$)|pnpm-lock\.yaml$|pom\.xml$|\.npmrc$)/.test(relative);
const genericAllowed=(mode,relative)=>mode==='project'?/^scripts\/quality\/[\w./-]+$/.test(relative):/^(?:bin|jenkins)\/[\w./-]+$/.test(relative);

function safe(file,{directory=false}={}){
 assert(typeof file==='string'&&path.isAbsolute(file),'更新路径须为绝对路径');
 let p=path.parse(file).root;const parts=file.slice(p.length).split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){
  assert(!['.','..'].includes(parts[i]),'更新路径不能含相对跳转');p=path.join(p,parts[i]);
  let s;try{s=lstatSync(p);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  assert(!s.isSymbolicLink(),'更新路径不能含符号链接：'+p,'UPDATE-SYMLINK');
  assert(i===parts.length-1&&!directory?s.isFile():s.isDirectory(),'更新路径类型不符：'+p);
 }
 return file;
}
function within(root,relative){
 assert(typeof relative==='string'&&relative.length>0&&!path.isAbsolute(relative)&&!relative.includes('\\')&&!/[\x00-\x1f]/.test(relative),'更新资产须为普通相对路径');
 assert(!relative.split('/').some(p=>['','..','.','.git','node_modules'].includes(p)),'更新资产路径越界');
 const file=path.resolve(root,relative);assert(file.startsWith(root+path.sep),'更新资产越界');return safe(file);
}
function bytes(file){safe(file);return existsSync(file)?readFileSync(file):null;}
function fingerprint(file){const b=bytes(file);return b===null?{sha256:null,mode:null}:{sha256:hash(b),mode:lstatSync(file).mode&0o777};}
function readJson(file){return JSON.parse(readFileSync(safe(file),'utf8'));}
function same(a,b){return a.sha256===b.sha256&&a.mode===b.mode;}
function atomic(file,content,mode){
 safe(file);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});safe(path.dirname(file),{directory:true});
 const tmp=file+'.wl-update-'+randomUUID()+'.tmp';let fd;
 try{fd=openSync(tmp,'wx',mode);writeFileSync(fd,content);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,file);chmodSync(file,mode);}
 finally{if(fd!==undefined)closeSync(fd);rmSync(tmp,{force:true});}
}
function committed(root,relative){const r=spawnSync('git',['-C',root,'show','HEAD:'+relative],{encoding:null,shell:false});return r.status===0?r.stdout:null;}
function addBlock(plan,id,message,extra={}){plan.blockers.push({id,message,...extra});}
function targetPrefix(input){return path.resolve(input.installPrefix||input.settings?.installPrefix||process.env.WL_GATE_PREFIX||(process.platform==='darwin'?path.join(os.homedir(),'.local/share/wl-quality/gate-validation'):'/opt/wl-quality/gate-validation'));}
function resolveMode(input){
 if(input.mode){assert(['project','jenkins'].includes(input.mode),'更新mode仅支持project/jenkins');return input.mode;}
 const project=input.projectRoot||input.settings?.projectRoot;
 if(project&&existsSync(path.join(project,'quality/workspace.json')))return 'project';
 if(existsSync(path.join(targetPrefix(input),'gate-installation.json')))return 'jenkins';
 throw fail('没有找到已接入项目或Jenkins节点；先完成一次接入，增量入口不代替首次安装。','UPDATE-NOT-ADOPTED');
}
async function runtime(gateHome,map){
 const pkg=readJson(path.join(gateHome,'package.json'));
 const api=await import(pathToFileURL(path.join(gateHome,'lib/jenkins-integration.js')));
 const actual=api.gateRuntimeHash();
 assert(pkg.name==='@agile-team/wl-skills-gate'&&pkg.version===map.gateVersion&&actual===map.runtimeFingerprint,'目标Gate版本或运行时摘要与交付快照不同；不执行更新。','UPDATE-RUNTIME-DRIFT');
 return {version:pkg.version,runtimeFingerprint:actual,home:gateHome};
}
function addFile(plan,{target,afterContent,afterMode,beforeHash,baselineHash,source,category='managed-asset'}){
 const before=fingerprint(target),buffer=Buffer.isBuffer(afterContent)?afterContent:Buffer.from(afterContent),after={sha256:hash(buffer),mode:afterMode??before.mode??0o644};
 const action=before.sha256===null?'create':same(before,after)?'unchanged':'update';
 if(beforeHash!==undefined&&beforeHash!==before.sha256)addBlock(plan,'UPDATE-PLAN-DRIFT','资产在生成计划时已改变：'+target);
 if(action==='update'&&(!baselineHash||baselineHash!==before.sha256))addBlock(plan,'UPDATE-MANAGED-DRIFT','受管文件不等于原接入摘要，保留现场修改：'+target);
 assert(!plan.files.some(f=>f.target===target),'重复更新目标：'+target);
 plan.files.push({target,category,source:source||'fixed-package-plan',action,before,after,afterBase64:buffer.toString('base64')});
}
function protection(plan,file,label){const state=fingerprint(file);if(state.sha256!==null)plan.protectedFiles.push({file,...state,label});}
function planIdentity(plan){const {planHash,status,...bound}=plan;return hash(stable(bound));}

/** A read-only, hash-bound delta plan. No npm, hook, build or network execution. */
export async function planIncrementalUpdate(input){
 const {manifest,map,settings={}}=input;assert(manifest&&map,'增量更新需要随包清单及步骤映射');
 const mode=resolveMode(input),prefix=targetPrefix(input),projectRoot=input.projectRoot||settings.projectRoot;
 const destination=mode==='project'?path.resolve(projectRoot):prefix;safe(destination,{directory:true});
 const plan={schemaVersion:1,kind:'wl-quality-incremental-update-plan',mode,destination,prefix,
  target:{version:map.gateVersion,runtimeFingerprint:map.runtimeFingerprint,snapshot:manifest.snapshot},
  files:[],protectedFiles:[],blockers:[],requiresRemoteReconcile:false,businessBuildAuthorized:false,
  excludedActions:['business-code-repair','quality-policy-approval','jenkins-job-write','jenkins-build-dispatch','feishu-send','credential-write'],needsRuntimeInstallation:false};
 const pointer=path.join(prefix,'gate-installation.json');
 let installed=existsSync(pointer)?readJson(pointer):null;
 const suppliedHome=input.gateHome||(installed?.runtimeFingerprint===map.runtimeFingerprint?installed.gateHome:null);
 if(!suppliedHome||!existsSync(path.join(suppliedHome,'lib/jenkins-integration.js'))){
  plan.needsRuntimeInstallation=true;plan.runtimePreparation={kind:'immutable-snapshot',archive:manifest.packages.find(p=>p.role==='gate')?.path,oldSnapshotRetained:true};
  plan.status='runtime-preparation-required';plan.planHash=planIdentity(plan);return plan;
 }
 plan.runtime=await runtime(path.resolve(suppliedHome),map);
 const sourceRoot=path.resolve(input.root);safe(sourceRoot,{directory:true});
 if(mode==='jenkins'){
  const configDir=path.resolve(settings.centralConfigDir),clusterFile=path.join(configDir,'jenkins-cluster.json');
  assert(existsSync(clusterFile),'未找到原集群配置；增量入口不会伪造首次接入。','UPDATE-NOT-ADOPTED');
  const cluster=readJson(clusterFile);assert(cluster.kind==='wl-quality-jenkins-cluster'&&cluster.schemaVersion===1,'原集群配置身份无效');
  const origin=new URL(settings.jenkinsOrigin).href;
  assert(cluster.jenkinsOrigin===origin,'Jenkins地址变更须另行审批，增量升级不更换集群身份。','UPDATE-TRUST-DRIFT');
  const loader=cluster.nativeEntry?.loaderFile;
  assert(loader===path.join(prefix,'jenkins/entry.groovy')&&sha.test(cluster.nativeEntry?.loaderHash||''),'原公共入口路径或摘要身份无效');
  const api=await import(pathToFileURL(path.join(plan.runtime.home,'lib/jenkins-installation.js')));
  const generated=api.planJenkinsInstallation({prefix,configDir,jenkinsOrigin:cluster.jenkinsOrigin,registryFiles:cluster.registryFiles,centralAgentLabel:cluster.agents.central,reviewSignerAgentLabel:cluster.agents.review});
  // Preserve every existing user extension and operational setting. Only the
  // generated native entry and Node directory are replaced after one approval.
  const mergedCluster={...cluster,nativeEntry:generated.nativeEntry,nodeBinDir:generated.files.find(f=>f.file===clusterFile)?JSON.parse(generated.files.find(f=>f.file===clusterFile).text).nodeBinDir:cluster.nodeBinDir};
  for(const f of generated.files){
   if(f.file===path.join(configDir,'jenkins-ops.json')){protection(plan,f.file,'巡检设置与凭据引用');continue;}
   const before=fingerprint(f.file);let baselineHash;
   if(f.file===loader)baselineHash=cluster.nativeEntry.loaderHash;
   else if(f.file===clusterFile)baselineHash=before.sha256;
   else if(f.file===path.join(prefix,'bin/wl-quality')){
    // Old alias must still target the recorded, immutable old runtime.
    const oldHome=input.previousInstallation?.gateHome||installed?.gateHome;
    const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
    const expectedAlias=oldHome&&'#!/bin/sh\nset -eu\nPATH='+quote(cluster.nodeBinDir)+':"$PATH"\nexport PATH\nexec '+quote(process.execPath)+' '+quote(path.join(oldHome,'bin/wl-quality.js'))+' "$@"\n';
    if(expectedAlias&&before.sha256===hash(expectedAlias))baselineHash=before.sha256;
   }
   addFile(plan,{target:f.file,afterContent:f.file===clusterFile?json(mergedCluster):f.text,afterMode:f.mode,baselineHash,category:f.file===clusterFile?'native-entry-reference':'managed-asset'});
  }
  if(plan.files.some(f=>f.action!=='unchanged'))plan.requiresRemoteReconcile=true;
  for(const relative of ['jenkins-bindings.json','jenkins-fleet.json','automation-config.json','governance-config.json','control-config.json','review-publish-config.json'])protection(plan,path.join(configDir,relative),'正式登记／策略／Review信任原件');
  if(installed){
   const desired={...installed,gateHome:plan.runtime.home,runtimeFingerprint:plan.runtime.runtimeFingerprint,...(input.javaPreparation?.baseHome?{javaScanRoot:input.javaPreparation.baseHome}:{})};
   if(stable({...installed,gateHome:path.resolve(installed.gateHome)})!==stable(desired))addFile(plan,{target:pointer,afterContent:json(desired),afterMode:0o600,baselineHash:fingerprint(pointer).sha256,category:'runtime-pointer'});
   else protection(plan,pointer,'已有Gate快照位置');
  }
 }else{
  const workspaceFile=within(destination,'quality/workspace.json');assert(existsSync(workspaceFile),'项目未接入；请先使用项目接入入口。','UPDATE-NOT-ADOPTED');
  const workspace=readJson(workspaceFile);assert(workspace.kind==='wl-quality-workspace'&&['frontend','backend'].includes(workspace.projectKind),'项目接入清单身份无效');
  const original=committed(destination,'quality/workspace.json');assert(original&&hash(original)===hash(readFileSync(workspaceFile)),'接入清单须与已提交HEAD一致；升级不批准临时策略或受管摘要。','UPDATE-UNCOMMITTED-BASELINE');
  plan.projectKind=workspace.projectKind;plan.fromVersion=workspace.gateVersion;
  const api=await import(pathToFileURL(path.join(plan.runtime.home,'lib/onboard.js')));
  const generated=api.planOnboarding({root:destination,kind:workspace.projectKind,registry:workspace.registry,allowDependencyUpdates:true});
  for(const conflict of generated.hardConflicts||[])addBlock(plan,'UPDATE-PROJECT-CONFLICT',conflict.target+'：'+conflict.reason);
  const known=new Map([...(workspace.managedFiles||[]),...(workspace.hookFiles||[])].map(f=>[f.path,f.sha256]));
  for(const f of generated.files){
   const target=within(destination,f.path);
   if(f.path==='quality/workspace.json'){
    const after=JSON.parse(f.afterContent),beforeWithout={...workspace},afterWithout={...after};
    for(const k of ['managedFiles','hookFiles']){delete beforeWithout[k];delete afterWithout[k];}
    if(stable(beforeWithout)!==stable(afterWithout)){
     plan.needsProjectDependencyMigration=true;
     addBlock(plan,'UPDATE-PROJECT-DEPENDENCY-MIGRATION','项目Gate/依赖或接入身份变化须联动更新锁文件和实际依赖；由目标Gate原生升级事务执行。',{migrationCapable:true});
     protection(plan,target,'接入身份与版本锁');continue;
    }
    addFile(plan,{target,afterContent:f.afterContent,afterMode:f.afterMode,beforeHash:f.beforeHash,baselineHash:hash(original),category:'managed-asset-index'});continue;
   }
   if(protectedProject(f.path)){
    protection(plan,target,'项目策略／版本／构建配置');
    if(f.action!=='unchanged')addBlock(plan,'UPDATE-APPROVAL-REQUIRED','需要审阅的策略或依赖差异：'+f.path,{file:f.path,migrationCapable:/^(?:package\.json|quality-tools\/package(?:-lock)?\.json|pnpm-lock\.yaml)$/.test(f.path)});
    continue;
   }
   if(f.action==='unchanged')continue;
   if(!known.has(f.path)&&!genericAllowed('project',f.path)){
    addBlock(plan,'UPDATE-NATIVE-ADAPTER-REQUIRED','资产未登记为Gate受管文件，需对应原生包差异适配：'+f.path);continue;
   }
   const head=committed(destination,f.path),current=bytes(target);
   if(current&&(!head||hash(head)!==hash(current)))addBlock(plan,'UPDATE-UNCOMMITTED-ASSET','受管资产有未提交修改：'+f.path);
   addFile(plan,{target,afterContent:f.afterContent,afterMode:f.afterMode,beforeHash:f.beforeHash,baselineHash:known.get(f.path)});
  }
  plan.requiresRemoteReconcile=workspace.gateVersion!==map.gateVersion;
 }
 // Feature-only overlays are part of the signed/hashed delivery manifest. They
 // cannot replace policy files or smuggle arbitrary paths into the updater.
 for(const asset of manifest.incrementalAssets||[]){
  if(asset.mode!==mode)continue;
  assert(genericAllowed(mode,asset.target),'特性增量仅允许包内托管脚本路径');
  const src=within(sourceRoot,asset.source),expected=manifest.files?.find(f=>f.path===asset.source)?.sha256;
  assert(sha.test(expected||'')&&hash(readFileSync(src))===expected,'特性资产不等于随包受控摘要','UPDATE-SOURCE-DRIFT');
  const target=within(destination,asset.target);
  addFile(plan,{target,afterContent:readFileSync(src),afterMode:asset.fileMode??0o644,baselineHash:asset.previousSha256,source:asset.source});
 }
 plan.files.sort((a,b)=>a.target.localeCompare(b.target));plan.protectedFiles.sort((a,b)=>a.file.localeCompare(b.file));
 plan.changes=plan.files.filter(f=>f.action!=='unchanged').map(({target,action,category,before,after})=>({target,action,category,before,after}));
 plan.status=plan.blockers.length?'blocked':plan.changes.length?'delta-ready':'unchanged';plan.planHash=planIdentity(plan);return plan;
}

function transactionPaths(plan,options={}){
 const dir=path.resolve(options.stateDir||(plan.mode==='project'?path.join(plan.destination,'quality-reports/upgrades'):path.join(plan.prefix,'upgrade-history')));safe(dir,{directory:true});
 return {dir,lock:path.join(dir,'.update.lock'),journal:path.join(dir,'active.json'),history:path.join(dir,plan.planHash+'.json')};
}
function verifyPlan(plan){
 const expected=plan.needsRuntimeInstallation?'runtime-preparation-required':plan.blockers?.length?'blocked':plan.changes?.length?'delta-ready':'unchanged';
 assert(plan.kind==='wl-quality-incremental-update-plan'&&plan.planHash===planIdentity(plan)&&plan.status===expected,'增量计划已被修改，重新生成。','UPDATE-PLAN-TAMPERED');
}
function guardProtected(plan){for(const f of plan.protectedFiles)assert(same(fingerprint(f.file),f),'受保护配置在更新前后发生变化：'+f.file,'UPDATE-PROTECTED-DRIFT');}
function verifyFiles(plan){for(const f of plan.files)assert(same(fingerprint(f.target),f.after),'升级后资产核验失败：'+f.target,'UPDATE-POSTCHECK-FAILED');guardProtected(plan);return true;}
function acquire(lock){
 mkdirSync(path.dirname(lock),{recursive:true,mode:0o700});
 if(existsSync(lock)){
  const owner=readJson(lock);let alive=true;
  if(owner.host===os.hostname()&&Number.isInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}}
  if(!alive)rmSync(lock);else throw fail('另一个增量操作正在执行；原进程退出后同入口会恢复。','UPDATE-LOCKED');
 }
 try{const fd=openSync(lock,'wx',0o600);writeFileSync(fd,json({pid:process.pid,host:os.hostname()}));closeSync(fd);}catch(e){if(e.code==='EEXIST')throw fail('另一个增量操作正在执行。','UPDATE-LOCKED');throw e;}
}
function persist(file,value){atomic(file,Buffer.from(json(value)),0o600);}
function validateJournal(j){
 verifyPlan(j.plan);assert(j.planHash===j.plan.planHash,'事务与原计划不一致','UPDATE-JOURNAL-TAMPERED');
 const intended=j.plan.files.filter(f=>f.action!=='unchanged');assert(j.files.length===intended.length,'事务文件数量被改变','UPDATE-JOURNAL-TAMPERED');
 for(const f of j.files){const original=intended.find(p=>p.target===f.target);assert(original&&same(f.before,original.before)&&same(f.after,original.after)&&f.afterBase64===original.afterBase64,'事务目标被改变','UPDATE-JOURNAL-TAMPERED');
  assert(f.beforeBase64===null?f.before.sha256===null:hash(Buffer.from(f.beforeBase64,'base64'))===f.before.sha256,'回退原件摘要不符','UPDATE-JOURNAL-TAMPERED');}
 return j;
}
function currentJournal(paths,plan){if(!existsSync(paths.journal))return null;const j=validateJournal(readJson(paths.journal));assert(j.planHash===plan.planHash,'存在另一未完成升级；先恢复或回退该事务。','UPDATE-OTHER-TRANSACTION');return j;}

/** Apply only the approved delta, with durable backups, compare-and-swap and rollback. */
export async function applyIncrementalUpdate(plan,{confirm=false,planHash,stateDir,verify,onEvent=()=>{},simulateCrashAfter}={}){
 verifyPlan(plan);assert(confirm&&planHash===plan.planHash,'应用须确认当前增量planHash。','UPDATE-CONFIRMATION-REQUIRED');
 assert(!plan.blockers.length&&!plan.needsRuntimeInstallation,'当前增量计划存在阻断，未写入。');
 if(plan.status==='unchanged')return {status:'unchanged',planHash:plan.planHash,changedFiles:[],networkExecuted:false,notificationSent:false,remoteModified:false,businessBuildAuthorized:false};
 const paths=transactionPaths(plan,{stateDir});acquire(paths.lock);let journal;
 try{
  guardProtected(plan);journal=currentJournal(paths,plan);
  if(!journal){
   for(const f of plan.files)assert(same(fingerprint(f.target),f.before),'计划后资产被修改：'+f.target,'UPDATE-CONCURRENT-CHANGE');
   journal={schemaVersion:1,kind:'wl-quality-incremental-transaction',planHash:plan.planHash,status:'prepared',startedAt:new Date().toISOString(),plan,files:[]};
   for(const f of plan.files.filter(f=>f.action!=='unchanged'))journal.files.push({target:f.target,before:f.before,after:f.after,beforeBase64:bytes(f.target)?.toString('base64')??null,afterBase64:f.afterBase64,status:'pending'});
   persist(paths.journal,journal);
  }
  journal.status='applying';persist(paths.journal,journal);let changed=0;
  for(const f of journal.files){
   const current=fingerprint(f.target);
   if(f.status==='applied'){assert(same(current,f.after),'中断后已更新文件又被修改：'+f.target,'UPDATE-RESUME-DRIFT');continue;}
   // A process may die after rename but before journalling the completed write.
   if(same(current,f.after)){f.status='applied';persist(paths.journal,journal);continue;}
   assert(same(current,f.before),'中断恢复时资产不等于升级前或升级后摘要：'+f.target,'UPDATE-RESUME-DRIFT');
   atomic(f.target,Buffer.from(f.afterBase64,'base64'),f.after.mode);f.status='applied';persist(paths.journal,journal);changed++;onEvent({phase:'apply',target:f.target,completed:journal.files.filter(x=>x.status==='applied').length,total:journal.files.length});
   if(simulateCrashAfter===changed)throw Object.assign(fail('测试中断','UPDATE-SIMULATED-CRASH'),{leavePending:true});
  }
  verifyFiles(plan);if(verify)assert(await verify(plan)!==false,'升级后独立核验未通过','UPDATE-POSTCHECK-FAILED');
  journal.status='completed';journal.completedAt=new Date().toISOString();persist(paths.history,journal);rmSync(paths.journal,{force:true});
  return {status:'updated',planHash:plan.planHash,changedFiles:journal.files.map(f=>f.target),receipt:paths.history,requiresRemoteReconcile:plan.requiresRemoteReconcile,networkExecuted:false,notificationSent:false,remoteModified:false,businessBuildAuthorized:false};
 }catch(e){
  if(journal){journal.status=e.leavePending?'interrupted':'failed';journal.failure={code:e.code||'UPDATE-FAILED',message:e.message};persist(paths.journal,journal);
   if(!e.leavePending){try{restore(journal);journal.status='rolled-back';persist(paths.history,journal);rmSync(paths.journal,{force:true});}catch(rollbackError){journal.rollbackFailure=rollbackError.message;persist(paths.journal,journal);}}
  }
  throw e;
 }finally{rmSync(paths.lock,{force:true});}
}
function restore(journal){
 validateJournal(journal);guardProtected(journal.plan);
 // Check every target before restoring any file. A late manual edit must not
 // leave an earlier target already rolled back and the rest at the new version.
 for(const f of journal.files){
  const current=fingerprint(f.target);
  assert(same(current,f.before)||same(current,f.after),'回退保留现场后续修改，未覆盖：'+f.target,'UPDATE-ROLLBACK-DRIFT');
 }
 for(const f of [...journal.files].reverse()){
  const current=fingerprint(f.target);if(same(current,f.before)){f.status='restored';continue;}
  assert(same(current,f.after),'回退保留现场后续修改，未覆盖：'+f.target,'UPDATE-ROLLBACK-DRIFT');
  if(f.beforeBase64===null)rmSync(safe(f.target));else atomic(f.target,Buffer.from(f.beforeBase64,'base64'),f.before.mode);
  f.status='restored';
 }
 guardProtected(journal.plan);for(const f of journal.files)assert(same(fingerprint(f.target),f.before),'回退后摘要不符：'+f.target);
}
export async function rollbackIncrementalUpdate(receiptFile,{confirm=false,planHash,stateDir}={}){
 assert(confirm,'回退需要确认');const journal=validateJournal(readJson(receiptFile));assert(journal.planHash===planHash,'回退须绑定原事务planHash');
 const paths=transactionPaths(journal.plan,{stateDir});acquire(paths.lock);
 try{restore(journal);journal.status='rolled-back';journal.rolledBackAt=new Date().toISOString();persist(receiptFile,journal);return {status:'rolled-back',planHash,receipt:receiptFile};}
 finally{rmSync(paths.lock,{force:true});}
}

/** User-facing orchestration; same inputs for project and operations packages. */
export async function incrementalUpdate(input){
 const mode=resolveMode(input),prefix=targetPrefix(input),destination=mode==='project'?path.resolve(input.projectRoot||input.settings?.projectRoot):prefix;
 const pending=transactionPaths({mode,prefix,destination},{stateDir:input.stateDir});
 let plan;
 if(existsSync(pending.journal)){
  const journal=validateJournal(readJson(pending.journal));plan=journal.plan;
  assert(plan.mode===mode&&plan.destination===destination&&plan.target.version===input.map.gateVersion&&plan.target.runtimeFingerprint===input.map.runtimeFingerprint,'未完成事务不属于本次交付目标，保留现场；使用原包恢复或回退。');
  await runtime(plan.runtime.home,input.map);
 }else plan=await planIncrementalUpdate(input);
 const emit=input.onEvent||(()=>{}),save=input.save||(()=>{});
 emit({phase:'plan',status:plan.status,changes:plan.changes||[],blockers:plan.blockers,needsRuntimeInstallation:plan.needsRuntimeInstallation});
 const migration=plan.mode==='project'&&plan.needsProjectDependencyMigration&&plan.blockers.every(b=>b.migrationCapable===true)&&typeof input.prepareProjectDependencies==='function';
 if(plan.needsRuntimeInstallation||plan.status==='blocked'&&!migration||input.previewOnly)return {...plan,executed:false};
 if(migration){
  const answer=await input.ask?.('按目标Gate原生升级计划更新项目包、受管资产和版本锁；正式质量策略保留。输入1执行，其他取消');
  if(String(answer).trim()!=='1')return {status:'canceled',executed:false,planHash:plan.planHash};
  // The core onboarding adapter owns its dependency/native-asset transaction,
  // immutable backups and resume receipt. We do not reimplement lockfile edits.
  const keep=plan.protectedFiles.filter(f=>/^quality\/(?!workspace\.json$|rules\.lock\.json$)/.test(path.relative(plan.destination,f.file).split(path.sep).join('/')));
  const lockFile=path.join(plan.destination,'quality/rules.lock.json'),oldLock=existsSync(lockFile)?readJson(lockFile):null;
  const migrated=await input.prepareProjectDependencies({plan,projectRoot:plan.destination,gateHome:plan.runtime.home,approvedPlanHash:plan.planHash});
  assert(migrated?.localValidated===true||migrated?.installationValidated===true,'项目原生升级未取得本次本机验证通过回执，保留原生事务供重跑恢复。','UPDATE-PROJECT-VALIDATION-FAILED');
  for(const f of keep)assert(same(fingerprint(f.file),f),'升级改变了正式质量策略；需要明确策略迁移审批：'+f.file,'UPDATE-TRUST-DRIFT');
  const current=readJson(path.join(plan.destination,'quality/workspace.json'));assert(current.gateVersion===input.map.gateVersion,'项目版本身份未迁移到批准目标');
  const dependency=current.projectKind==='backend'?'quality-tools/node_modules':'node_modules';
  await runtime(path.join(plan.destination,dependency,'@agile-team/wl-skills-gate'),input.map);
  const newLock=readJson(lockFile);assert(newLock['wl-skills-gate']===input.map.gateVersion,'项目工具锁未更新到目标Gate');
  const trustMigrationRequired=!!oldLock&&stable(oldLock.tools)!==stable(newLock.tools);
  // Software can update after explicit approval and native execution checks;
  // changed tool identities invalidate release trust and need remote reapproval.
  // No policy is changed here and no build/Review permission is produced.
  if(input.verify)assert(await input.verify(plan,migrated)!==false,'项目升级独立验证未通过');
  const result={status:migrated.qualityPassed===false?'project-updated-quality-blocked':'project-updated',qualityPassed:migrated.qualityPassed,installationValidated:migrated.installationValidated===true||migrated.localValidated===true,planHash:plan.planHash,dependencyMigration:migrated,trustMigrationRequired,requiresRemoteReconcile:true,notificationSent:false,remoteModified:false,businessBuildAuthorized:false};save(result);return result;
 }
 if(plan.status==='unchanged')return applyIncrementalUpdate(plan,{confirm:true,planHash:plan.planHash});
 // A crash recovery uses the persisted original plan, not a partially updated
 // new plan, so all original before/after evidence remains available.
 const paths=transactionPaths(plan,{stateDir:input.stateDir});
 if(existsSync(paths.journal)){const journal=readJson(paths.journal);verifyPlan(journal.plan);plan=journal.plan;emit({phase:'resume',status:journal.status,planHash:plan.planHash});}
 const answer=await input.ask?.('仅更新以上 '+plan.changes.length+' 项受管资产；现场配置和凭据保留。输入1执行，其他取消');
 if(String(answer).trim()!=='1')return {status:'canceled',executed:false,planHash:plan.planHash};
 const result=await applyIncrementalUpdate(plan,{confirm:true,planHash:plan.planHash,stateDir:input.stateDir,verify:input.verify,onEvent:emit});
 save(result);return result;
}
