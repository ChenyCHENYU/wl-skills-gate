import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,lstatSync,symlinkSync,readdirSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {planIncrementalUpdate,applyIncrementalUpdate,rollbackIncrementalUpdate,incrementalUpdate} from '../../lib/incremental-update.js';
const h=x=>createHash('sha256').update(x).digest('hex'),j=x=>JSON.stringify(x,null,2)+'\n';
const base=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-delta-tests-'));
const put=(file,text,mode=0o644)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,text,{mode});};
const fprint=dir=>{const out=[];for(const name of readdirSync(dir).sort()){const file=path.join(dir,name),s=lstatSync(file);if(s.isDirectory())out.push(...fprint(file).map(e=>[name+'/'+e[0],...e.slice(1)]));else out.push([name,h(readFileSync(file)),s.mode&0o777,s.mtimeMs]);}return out;};
const git=(root,...args)=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
async function fixture(){
 const root=mkdtempSync(path.join(base,'case-')),prefix=path.join(root,'installed'),config=path.join(root,'config'),delivery=path.join(root,'delivery');
 mkdirSync(delivery);const versions=[];
 for(const version of ['1.0.0','2.0.0']){
  const home=path.join(prefix,'releases',version),fingerprint=h(version);versions.push({home,fingerprint,version});
  put(path.join(home,'package.json'),j({name:'@agile-team/wl-skills-gate',version,type:'module'}));
  put(path.join(home,'lib/jenkins-integration.js'),`export const gateRuntimeHash=()=>${JSON.stringify(fingerprint)};`);
  put(path.join(home,'lib/jenkins-installation.js'),`import path from'node:path';import{createHash}from'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');
export function planJenkinsInstallation(o){const q=v=>"'"+v.replaceAll("'","'\\\\''")+"'",nodeBinDir=path.dirname(process.execPath),loaderFile=path.join(o.prefix,'jenkins/entry.groovy'),loader='// controlled feature ${version}\\n',nativeEntry={loaderFile,loaderHash:hash(loader),runtimeHash:'${fingerprint}'};return {nativeEntry,files:[{file:loaderFile,text:loader,mode:420},{file:path.join(o.prefix,'bin/wl-quality'),text:'#!/bin/sh\\nset -eu\\nPATH='+q(nodeBinDir)+':"$PATH"\\nexport PATH\\nexec '+q(process.execPath)+' '+q(${JSON.stringify(path.join(home,'bin/wl-quality.js'))})+' "$@"\\n',mode:493},{file:path.join(o.configDir,'jenkins-cluster.json'),text:JSON.stringify({nodeBinDir}),mode:384},{file:path.join(o.configDir,'jenkins-ops.json'),text:'{}',mode:384}]};}`);
 }
 const [v1,v2]=versions,oldApi=await import(pathToFileURL(path.join(v1.home,'lib/jenkins-installation.js')));
 const old=oldApi.planJenkinsInstallation({prefix,configDir:config});
 const cluster={schemaVersion:1,kind:'wl-quality-jenkins-cluster',jenkinsOrigin:'https://ci.example.test/',registryFiles:[path.join(config,'jenkins-bindings.json')],configDir:config,nodeBinDir:path.dirname(process.execPath),agents:{central:'existing-agent',review:'isolated-existing-agent'},nativeEntry:old.nativeEntry,userExtension:{retentionDays:180,team:'factory-a'}};
 for(const f of old.files)put(f.file,f.file.endsWith('jenkins-cluster.json')?j(cluster):f.text,f.mode);
 for(const name of ['jenkins-bindings.json','jenkins-fleet.json','automation-config.json','governance-config.json','control-config.json','review-publish-config.json'])put(path.join(config,name),j({name,custom:'keep-me',credentialId:'reference-only'}),0o600);
 put(path.join(config,'jenkins-ops.json'),j({schemaVersion:1,interval:25,credentials:['custom-feishu-id']}),0o600);
 put(path.join(prefix,'gate-installation.json'),j({gateHome:v1.home,runtimeFingerprint:v1.fingerprint,retained:'existing-property'}),0o600);
 const input={root:delivery,manifest:{snapshot:'v2',packages:[],files:[]},map:{gateVersion:v2.version,runtimeFingerprint:v2.fingerprint},settings:{installPrefix:prefix,centralConfigDir:config,jenkinsOrigin:cluster.jenkinsOrigin},mode:'jenkins',gateHome:v2.home};
 return {root,prefix,config,delivery,v1,v2,input,cluster};
}
const apply=(p,o={})=>applyIncrementalUpdate(p,{confirm:true,planHash:p.planHash,...o});

test('real current Gate installation API returns unchanged with zero writes',async()=>{
 const root=mkdtempSync(path.join(base,'real-')),prefix=path.join(root,'prefix'),config=path.join(root,'config'),home=fileURLToPath(new URL('../../',import.meta.url));
 const api=await import(pathToFileURL(path.join(home,'lib/jenkins-installation.js'))),rt=await import(pathToFileURL(path.join(home,'lib/jenkins-integration.js')));
 const input={prefix,configDir:config,jenkinsOrigin:'https://ci.example.test/',registryFiles:[path.join(config,'jenkins-bindings.json')],centralAgentLabel:'real-central',reviewSignerAgentLabel:'real-review'},p=api.planJenkinsInstallation(input);api.applyJenkinsInstallation({...input,confirm:true,planHash:p.planHash});
 put(path.join(prefix,'gate-installation.json'),j({gateHome:home,runtimeFingerprint:rt.gateRuntimeHash()}),0o600);
 const before=fprint(root),plan=await planIncrementalUpdate({root,manifest:{snapshot:'real',packages:[]},map:{gateVersion:JSON.parse(readFileSync(path.join(home,'package.json'))).version,runtimeFingerprint:rt.gateRuntimeHash()},settings:{installPrefix:prefix,centralConfigDir:config,jenkinsOrigin:input.jenkinsOrigin},mode:'jenkins',gateHome:home});
 assert.equal(plan.status,'unchanged',JSON.stringify(plan.files.map(({target,action,before,after,afterBase64})=>({target,action,before,after,afterText:Buffer.from(afterBase64,'base64').toString()}))));assert.equal((await apply(plan)).status,'unchanged');assert.deepEqual(fprint(root),before);
});
test('v1→v2 updates only 4 changed managed files and preserves user config/old snapshot',async()=>{
 const f=await fixture(),oldSettings=fprint(f.config).filter(([name])=>name!=='jenkins-cluster.json'),p=await planIncrementalUpdate(f.input);
 assert.equal(p.status,'delta-ready');assert.equal(p.changes.length,4);assert.equal(p.requiresRemoteReconcile,true);
 const r=await apply(p);assert.equal(r.status,'updated');assert.equal(r.notificationSent,false);assert.equal(r.remoteModified,false);assert.equal(r.businessBuildAuthorized,false);
 assert.deepEqual(fprint(f.config).filter(([name])=>name!=='jenkins-cluster.json'),oldSettings);
 assert.deepEqual(JSON.parse(readFileSync(path.join(f.config,'jenkins-cluster.json'))).userExtension,f.cluster.userExtension);
 assert.ok(existsSync(f.v1.home));assert.equal(JSON.parse(readFileSync(path.join(f.prefix,'gate-installation.json'))).retained,'existing-property');
 const next=await planIncrementalUpdate(f.input);assert.equal(next.status,'unchanged');const before=fprint(f.root);await apply(next);assert.deepEqual(fprint(f.root),before);
});
test('feature-only delta uses manifest hash and never touches retained CI credentials',async()=>{
 const f=await fixture();f.input.gateHome=f.v1.home;f.input.map={gateVersion:f.v1.version,runtimeFingerprint:f.v1.fingerprint};
 put(path.join(f.delivery,'features/increment.mjs'),'export const feature=2;\n');const source='features/increment.mjs',target='bin/increment.mjs',first='export const feature=1;\n';put(path.join(f.prefix,target),first);
 f.input.manifest.files=[{path:source,sha256:h(readFileSync(path.join(f.delivery,source)))}];f.input.manifest.incrementalAssets=[{mode:'jenkins',source,target,previousSha256:h(first)}];
 const p=await planIncrementalUpdate(f.input);assert.equal(p.changes.length,1);const r=await apply(p);assert.equal(r.status,'updated');assert.equal(readFileSync(path.join(f.prefix,target),'utf8'),'export const feature=2;\n');
});
test('tampered bundle feature bytes are rejected before any write',async()=>{
 const f=await fixture(),source='features/feature.mjs';put(path.join(f.delivery,source),'unexpected');f.input.manifest.files=[{path:source,sha256:h('approved')}];f.input.manifest.incrementalAssets=[{mode:'jenkins',source,target:'bin/new.mjs'}];
 await assert.rejects(()=>planIncrementalUpdate(f.input),{code:'UPDATE-SOURCE-DRIFT'});assert.ok(!existsSync(path.join(f.prefix,'bin/new.mjs')));
});
test('existing managed loader drift blocks all writes',async()=>{const f=await fixture();put(path.join(f.prefix,'jenkins/entry.groovy'),'custom edit');const p=await planIncrementalUpdate(f.input);assert.equal(p.status,'blocked');assert.ok(p.blockers.some(x=>x.id==='UPDATE-MANAGED-DRIFT'));await assert.rejects(()=>apply(p));});
test('existing alias cannot smuggle an extra command into baseline',async()=>{const f=await fixture(),alias=path.join(f.prefix,'bin/wl-quality');writeFileSync(alias,readFileSync(alias)+'touch /tmp/injected\n');const p=await planIncrementalUpdate(f.input);assert.equal(p.status,'blocked');assert.ok(p.blockers.some(x=>x.id==='UPDATE-MANAGED-DRIFT'));});
test('concurrent protected config change blocks before writes',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input),old=readFileSync(path.join(f.prefix,'jenkins/entry.groovy'));put(path.join(f.config,'jenkins-ops.json'),'new-user-config',0o600);await assert.rejects(()=>apply(p),{code:'UPDATE-PROTECTED-DRIFT'});assert.deepEqual(readFileSync(path.join(f.prefix,'jenkins/entry.groovy')),old);});
test('concurrent managed asset change blocks before writes',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input);put(path.join(f.prefix,'bin/wl-quality'),'concurrent');await assert.rejects(()=>apply(p),{code:'UPDATE-CONCURRENT-CHANGE'});});
test('post-check failure rolls all managed files back with evidence',async()=>{const f=await fixture(),before=readFileSync(path.join(f.prefix,'gate-installation.json')),p=await planIncrementalUpdate(f.input);await assert.rejects(()=>apply(p,{verify:()=>false}),{code:'UPDATE-POSTCHECK-FAILED'});assert.deepEqual(readFileSync(path.join(f.prefix,'gate-installation.json')),before);const receipt=JSON.parse(readFileSync(path.join(f.prefix,'upgrade-history',p.planHash+'.json')));assert.equal(receipt.status,'rolled-back');});
test('completed delta can be explicitly rolled back to old snapshot',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input),r=await apply(p);await rollbackIncrementalUpdate(r.receipt,{confirm:true,planHash:p.planHash});assert.equal(JSON.parse(readFileSync(path.join(f.prefix,'gate-installation.json'))).gateHome,f.v1.home);assert.equal(readFileSync(path.join(f.prefix,'jenkins/entry.groovy'),'utf8'),'// controlled feature 1.0.0\n');});
test('rollback protects a later user edit',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input),r=await apply(p);put(path.join(f.prefix,'jenkins/entry.groovy'),'later-change');await assert.rejects(()=>rollbackIncrementalUpdate(r.receipt,{confirm:true,planHash:p.planHash}),{code:'UPDATE-ROLLBACK-DRIFT'});assert.equal(readFileSync(path.join(f.prefix,'jenkins/entry.groovy'),'utf8'),'later-change');});
test('same user-facing orchestration resumes interrupted v1→v2 without replanning partial state',async()=>{
 const f=await fixture(),p=await planIncrementalUpdate(f.input);await assert.rejects(()=>apply(p,{simulateCrashAfter:1}),{code:'UPDATE-SIMULATED-CRASH'});
 const events=[],r=await incrementalUpdate({...f.input,ask:async()=> '1',onEvent:e=>events.push(e)});assert.equal(r.status,'updated');assert.ok(events.some(e=>e.phase==='resume'));assert.equal((await planIncrementalUpdate(f.input)).status,'unchanged');
});
test('a simulated stale process lock resumes automatically',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input);await assert.rejects(()=>apply(p,{simulateCrashAfter:1}));put(path.join(f.prefix,'upgrade-history/.update.lock'),j({pid:2147483646,host:os.hostname()}),0o600);assert.equal((await incrementalUpdate({...f.input,ask:async()=> '1'})).status,'updated');});
test('live process lock prevents double writes',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input);put(path.join(f.prefix,'upgrade-history/.update.lock'),j({pid:process.pid,host:os.hostname()}),0o600);await assert.rejects(()=>apply(p),{code:'UPDATE-LOCKED'});});
test('tampered plan is rejected',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input);p.files[0].afterBase64=Buffer.from('injected').toString('base64');await assert.rejects(()=>apply(p),{code:'UPDATE-PLAN-TAMPERED'});});
test('tampered rollback backup rejected before any restore',async()=>{const f=await fixture(),p=await planIncrementalUpdate(f.input),r=await apply(p),jrn=JSON.parse(readFileSync(r.receipt));jrn.files[0].beforeBase64=Buffer.from('injected').toString('base64');put(r.receipt,j(jrn),0o600);await assert.rejects(()=>rollbackIncrementalUpdate(r.receipt,{confirm:true,planHash:p.planHash}),{code:'UPDATE-JOURNAL-TAMPERED'});});
test('explicitly approved origin cannot drift during feature upgrade',async()=>{const f=await fixture();f.input.settings.jenkinsOrigin='https://different.example.test/';await assert.rejects(()=>planIncrementalUpdate(f.input),{code:'UPDATE-TRUST-DRIFT'});});
test('missing target runtime yields preparation plan and no disk writes',async()=>{const f=await fixture();delete f.input.gateHome;const before=fprint(f.root),p=await planIncrementalUpdate(f.input);assert.equal(p.needsRuntimeInstallation,true);assert.equal(p.status,'runtime-preparation-required');assert.deepEqual(fprint(f.root),before);});
test('untrusted target runtime fingerprint rejected',async()=>{const f=await fixture();f.input.map.runtimeFingerprint=h('unapproved');await assert.rejects(()=>planIncrementalUpdate(f.input),{code:'UPDATE-RUNTIME-DRIFT'});});
test('symlink-controlled target is blocked',async()=>{const f=await fixture();const alias=path.join(f.prefix,'bin/wl-quality');rmSync(alias);put(path.join(f.root,'external'),'not-touch');symlinkSync(path.join(f.root,'external'),alias);await assert.rejects(()=>planIncrementalUpdate(f.input),{code:'UPDATE-SYMLINK'});});
test('one confirmation cancellation changes zero files',async()=>{const f=await fixture(),before=fprint(f.root);assert.equal((await incrementalUpdate({...f.input,ask:async()=> '2'})).status,'canceled');assert.deepEqual(fprint(f.root),before);});
test('preview never invokes approval or writes',async()=>{const f=await fixture(),before=fprint(f.root);const r=await incrementalUpdate({...f.input,previewOnly:true,ask:async()=>assert.fail('asked')});assert.equal(r.executed,false);assert.deepEqual(fprint(f.root),before);});

// Cross-version project migration delegates lockfile/native updates to the real
// package adapter; the updater independently checks target runtime and policies.
async function projectFixture(){
 const f=await fixture(),project=path.join(f.root,'project');mkdirSync(project);
 const workspace={schemaVersion:1,kind:'wl-quality-workspace',projectKind:'frontend',gateVersion:'1.0.0',registry:'https://registry.npmjs.org/',managedFiles:[],hookFiles:[],custom:'keep'},pkg={name:'project',devDependencies:{'@agile-team/wl-skills-gate':'1.0.0'}};
 put(path.join(project,'quality/workspace.json'),j(workspace));put(path.join(project,'package.json'),j(pkg));put(path.join(project,'quality/policy.yml'),'strict: true\n');put(path.join(project,'quality/rules.lock.json'),j({'wl-skills-gate':'1.0.0',tools:{scanner:'1.1.0'}}));
 git(project,'init','-q');git(project,'add','.');git(project,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','initial');
 put(path.join(f.v2.home,'lib/onboard.js'),`import fs from'node:fs';import path from'node:path';import{createHash}from'node:crypto';const h=x=>createHash('sha256').update(x).digest('hex');export function planOnboarding({root}){return {hardConflicts:[],files:['quality/workspace.json','package.json','quality/policy.yml'].map(relative=>{const before=fs.readFileSync(path.join(root,relative),'utf8');let after=before;if(relative==='quality/workspace.json'){const w=JSON.parse(before);w.gateVersion='2.0.0';after=JSON.stringify(w,null,2)+'\\n';}if(relative==='package.json'){const p=JSON.parse(before);p.devDependencies['@agile-team/wl-skills-gate']='2.0.0';after=JSON.stringify(p,null,2)+'\\n';}return {path:relative,afterContent:after,beforeHash:h(before),afterMode:420,action:before===after?'unchanged':'update'};})};}`);
 const input={...f.input,mode:'project',projectRoot:project};return {...f,project,input,workspace,pkg};
}
test('project migration without dependency adapter blocks rather than faking lock edits',async()=>{const f=await projectFixture(),p=await planIncrementalUpdate(f.input);assert.equal(p.status,'blocked');assert.equal(p.needsProjectDependencyMigration,true);assert.equal((await incrementalUpdate(f.input)).executed,false);});
test('project migration adapter completes v1→v2 with policy and custom settings preserved',async()=>{
 const f=await projectFixture();let approvals=0,executions=0;
 const r=await incrementalUpdate({...f.input,ask:async()=>{approvals++;return '1';},prepareProjectDependencies:async({approvedPlanHash,plan})=>{
  executions++;assert.equal(approvedPlanHash,plan.planHash);
  put(path.join(f.project,'quality/workspace.json'),j({...f.workspace,gateVersion:'2.0.0'}));put(path.join(f.project,'package.json'),j({...f.pkg,devDependencies:{'@agile-team/wl-skills-gate':'2.0.0'}}));put(path.join(f.project,'quality/rules.lock.json'),j({'wl-skills-gate':'2.0.0',tools:{scanner:'1.1.0'}}));
  const local=path.join(f.project,'node_modules/@agile-team/wl-skills-gate');put(path.join(local,'package.json'),readFileSync(path.join(f.v2.home,'package.json')));put(path.join(local,'lib/jenkins-integration.js'),readFileSync(path.join(f.v2.home,'lib/jenkins-integration.js')));
  return {localValidated:true,transaction:'core-adapter-owned'};
 }});
 assert.equal(r.status,'project-updated');assert.equal(approvals,1);assert.equal(executions,1);assert.equal(readFileSync(path.join(f.project,'quality/policy.yml'),'utf8'),'strict: true\n');assert.equal(JSON.parse(readFileSync(path.join(f.project,'quality/workspace.json'))).custom,'keep');assert.equal(r.businessBuildAuthorized,false);
});

test('rollback preflights all targets before restoring any earlier file',async()=>{
 const f=await fixture(),p=await planIncrementalUpdate(f.input),r=await apply(p),journal=JSON.parse(readFileSync(r.receipt));
 const late=journal.files[0].target;put(late,'manual edit after update');
 const before=fprint(f.root);await assert.rejects(()=>rollbackIncrementalUpdate(r.receipt,{confirm:true,planHash:p.planHash}),{code:'UPDATE-ROLLBACK-DRIFT'});
 assert.deepEqual(fprint(f.root),before);
});
async function migrateFixture(f,{tools={scanner:'1.1.0'},qualityPassed=true}={}){
 return incrementalUpdate({...f.input,ask:async()=> '1',prepareProjectDependencies:async()=>{
  put(path.join(f.project,'quality/workspace.json'),j({...f.workspace,gateVersion:'2.0.0'}));put(path.join(f.project,'package.json'),j({...f.pkg,devDependencies:{'@agile-team/wl-skills-gate':'2.0.0'}}));put(path.join(f.project,'quality/rules.lock.json'),j({'wl-skills-gate':'2.0.0',tools}));
  const local=path.join(f.project,'node_modules/@agile-team/wl-skills-gate');put(path.join(local,'package.json'),readFileSync(path.join(f.v2.home,'package.json')));put(path.join(local,'lib/jenkins-integration.js'),readFileSync(path.join(f.v2.home,'lib/jenkins-integration.js')));
  return {installationValidated:true,localValidated:qualityPassed,qualityPassed,transaction:'native-adapter'};
 }});
}
test('installed but quality-blocked migration is recorded without build authority',async()=>{
 const f=await projectFixture(),r=await migrateFixture(f,{qualityPassed:false});
 assert.equal(r.status,'project-updated-quality-blocked');assert.equal(r.installationValidated,true);assert.equal(r.qualityPassed,false);assert.equal(r.businessBuildAuthorized,false);assert.equal(r.notificationSent,false);
});
test('tool identity migration requires trust revalidation and never inherits build permission',async()=>{
 const f=await projectFixture(),r=await migrateFixture(f,{tools:{scanner:'2.0.0'}});
 assert.equal(r.status,'project-updated');assert.equal(r.trustMigrationRequired,true);assert.equal(r.requiresRemoteReconcile,true);assert.equal(r.businessBuildAuthorized,false);assert.equal(readFileSync(path.join(f.project,'quality/policy.yml'),'utf8'),'strict: true\n');
});
test('changing a blocked plan display status cannot bypass the recorded conflict',async()=>{
 const f=await fixture();put(path.join(f.prefix,'jenkins/entry.groovy'),'manual custom source');
 const p=await planIncrementalUpdate(f.input);assert.equal(p.status,'blocked');const before=fprint(f.root);p.status='delta-ready';
 await assert.rejects(()=>apply(p),{code:'UPDATE-PLAN-TAMPERED'});assert.deepEqual(fprint(f.root),before);
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
