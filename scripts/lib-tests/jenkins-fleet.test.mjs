import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fixture,bind,put} from '../test-support/jenkins-fixture.mjs';
import {discoverFleet,planFleet,applyFleet,verifyFleet,rollbackFleet} from '../../lib/jenkins-fleet.js';
import {gateRuntimeHash,digest,renderJenkinsEntry} from '../../lib/jenkins-integration.js';
import {jobContract,renderFleetJob,jenkinsJobConfigHash,fleetWriteMatches} from '../../lib/jenkins-job-config.js';
const env={WL_JENKINS_READ_USER:'reader',WL_JENKINS_READ_TOKEN:'read-secret-fixture',WL_JENKINS_CONFIG_USER:'operator',WL_JENKINS_CONFIG_TOKEN:'config-secret-fixture',WL_GITLAB_HOOK_TOKEN:'gitlab-secret-fixture',WL_GITLAB_JENKINS_WEBHOOK_SECRET:'webhook-secret-fixture-123456'};
const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
async function fleet(t,count=1){
 const f=fixture(t);await bind(f);const registry=JSON.parse(readFileSync(f.registryFile));const original=registry.bindings[0];registry.bindings=[];const sources=[];
 for(let i=0;i<count;i++){
  const b=structuredClone(original);Object.assign(b,{id:'produce-'+i,scope:'scope-'+i,jobs:{check:'生产-CHECK-'+i}});registry.bindings.push(b);
  const sourceFile=put(f.base,'source-'+i+'.json',{schemaVersion:1,system:'jenkins',project:b.project,scope:b.scope,baseUrl:'https://jenkins.example.invalid',jobPath:b.jobs.check,ref:'test',jobConfigHash:'0'.repeat(64),actorSource:{system:'gitlab',baseUrl:'https://gitlab.example.invalid',projectId:'12'},requiredJobs:[b.jobs.check]});sources.push({id:'source-'+i,configFile:sourceFile});
 }
 put(f.base,'bindings.json',registry);const automationFile=put(f.base,'automation.json',{schemaVersion:1,dataDir:path.join(f.base,'automation-data'),sources});
 const configFile=put(f.base,'fleet.json',{schemaVersion:1,kind:'wl-gate-jenkins-fleet',jenkinsOrigin:'https://jenkins.example.invalid/',dataDir:path.join(f.base,'fleet-data'),registryFiles:[f.registryFile],automationConfigFile:automationFile,selection:{projects:['wl-produce'],branches:['test']},inventory:{roots:[''],maxJobs:1000,maxDepth:8},gitlab:{origin:'https://gitlab.example.invalid',tokenEnv:'WL_GITLAB_HOOK_TOKEN',secretEnv:'WL_GITLAB_JENKINS_WEBHOOK_SECRET'},approvers:['operator']});
 const jobs=new Map(),hooks=[],calls=[],busy=new Set();let hookId=10,failJob=null,unknownHook=false;
 const fetchImpl=async(url,options={})=>{
  const u=new URL(url),method=options.method||'GET';calls.push({origin:u.origin,path:u.pathname,method});
  if(u.origin==='https://gitlab.example.invalid'){
   assert.equal(options.headers['PRIVATE-TOKEN'],env.WL_GITLAB_HOOK_TOKEN);
   if(method==='GET'){const start=(Number(u.searchParams.get('page')||1)-1)*100;return json(hooks.slice(start,start+100).map(({token,...h})=>h));}
   if(method==='POST'){const body=JSON.parse(options.body);const h={...body,id:++hookId};hooks.push(h);if(unknownHook){unknownHook=false;throw Error('timeout after save');}return json({id:h.id});}
   throw Error('unexpected GitLab request');
  }
  assert.equal(u.origin,'https://jenkins.example.invalid');assert.equal(options.redirect,'error');
  const parts=u.pathname.split('/').filter(Boolean),names=[];let p=0;while(parts[p]==='job'){names.push(decodeURIComponent(parts[p+1]));p+=2;}const job=names.join('/'),suffix=parts.slice(p).join('/');
  if(method==='GET'&&suffix==='api/json'){
   if(u.searchParams.get('tree')?.startsWith('inQueue'))return json({inQueue:false,lastBuild:{number:1,building:busy.has(job)}});
   const children=new Map();for(const name of jobs.keys()){if(job&&!name.startsWith(job+'/'))continue;const rel=job?name.slice(job.length+1):name;const seg=rel.split('/');children.set(seg[0],{name:seg[0],_class:seg.length>1?'com.cloudbees.hudson.plugins.folder.Folder':'org.jenkinsci.plugins.workflow.job.WorkflowJob'});}return json({jobs:[...children.values()]});
  }
  if(method==='GET'&&suffix==='config.xml')return jobs.has(job)?new Response(jobs.get(job)):new Response('',{status:404});
  if(method==='POST'){
   const name=suffix==='createItem'?(job?job+'/':'')+u.searchParams.get('name'):job;
   assert.ok(suffix==='config.xml'||suffix==='createItem','never builds or deletes');assert.equal(options.headers.Authorization,'Basic '+Buffer.from(env.WL_JENKINS_CONFIG_USER+':'+env.WL_JENKINS_CONFIG_TOKEN).toString('base64'));
   if(name===failJob)return new Response('',{status:403});jobs.set(name,options.body);return new Response('',{status:200});
  }
  throw Error('unexpected route '+u.pathname);
 };
 return {...f,registry,configFile,automationFile,jobs,hooks,calls,busy,fetchImpl,fail:job=>failJob=job,unknownHook:()=>unknownHook=true};
}
const options=f=>({configFile:f.configFile,env,fetchImpl:f.fetchImpl});
test('中文Folder盘点去重、完整读取配置；视图不冒充Job；不产生写请求',async t=>{
 const f=await fleet(t);f.jobs.set('质量任务/生产-CHECK','<flow-definition><description>x</description><properties/><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>echo \'old deploy\'</script><sandbox>true</sandbox></definition><disabled>false</disabled></flow-definition>');
 const result=await discoverFleet(options(f));assert.equal(result.status,'inventoried');assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].job,'质量任务/生产-CHECK');assert.equal(result.jobs[0].managed,false);assert.equal(result.viewNamesAreNotJobs,true);assert.ok(f.calls.every(v=>v.method==='GET'));assert.doesNotMatch(JSON.stringify(result),/old deploy|secret-fixture|<flow-definition>/);
});
test('120个范围实际预览/下发/Hook接线/中央摘要/回读核验，重复执行不重复建Job或Hook',async t=>{
 const f=await fleet(t,120);const plan=await planFleet(options(f));assert.equal(plan.counts.create,120);assert.equal(plan.counts.blocked,0);assert.equal(statSync(plan.planFile).mode&0o777,0o600);assert.doesNotMatch(JSON.stringify(plan),/webhook-secret-fixture|config-secret-fixture|<flow-definition>/);
 const apply={...options(f),planFile:plan.planFile,planHash:plan.planHash,confirm:true};const result=await applyFleet(apply);assert.equal(result.status,'configuration-verified',JSON.stringify(result));assert.equal(result.centralPinsSynchronized,true);assert.equal(f.jobs.size,120);assert.equal(f.hooks.length,120);assert.equal(result.businessRuntimeVerified,false);
 const count=f.calls.filter(c=>c.method==='POST').length;assert.equal((await applyFleet(apply)).status,'configuration-verified');assert.equal(f.calls.filter(c=>c.method==='POST').length,count);assert.equal((await verifyFleet({...options(f),planFile:plan.planFile})).status,'configuration-verified');
 const source=JSON.parse(readFileSync(path.join(f.base,'source-0.json')));assert.equal(source.jobConfigHashScheme,'stable-v1');assert.equal(source.jobConfigHash,jenkinsJobConfigHash(f.jobs.get('生产-CHECK-0'),'stable-v1'));
});
test('未确认、错误摘要、旧登记和原部署脚本均拒绝；不静默替换业务流水线',async t=>{
 const f=await fleet(t);let plan=await planFleet(options(f));await assert.rejects(applyFleet({...options(f),planFile:plan.planFile,planHash:plan.planHash}),/确认/);await assert.rejects(applyFleet({...options(f),planFile:plan.planFile,planHash:'a'.repeat(64),confirm:true}),/变化/);
 f.jobs.set('生产-CHECK-0','<flow-definition><description>部署任务</description><properties/><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>rsync --delete dist/ host:/app</script><sandbox>true</sandbox></definition><disabled>false</disabled></flow-definition>');plan=await planFleet(options(f));assert.equal(plan.status,'blocked');assert.match(plan.entries[0].blocker,/自定义流水线/);await assert.rejects(applyFleet({...options(f),planFile:plan.planFile,planHash:plan.planHash,confirm:true}),/阻断项/);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
test('一个Job403不中断其他配置；失败有明细，恢复权限后续跑原计划',async t=>{
 const f=await fleet(t,3),plan=await planFleet(options(f)),apply={...options(f),planFile:plan.planFile,planHash:plan.planHash,confirm:true};f.fail('生产-CHECK-1');let r=await applyFleet(apply);assert.equal(r.status,'attention');assert.equal(f.jobs.size,2);assert.equal(r.jobs.filter(v=>v.status==='attention').length,1);f.fail(null);r=await applyFleet(apply);assert.equal(r.status,'configuration-verified',JSON.stringify(r));assert.equal(f.jobs.size,3);assert.equal(f.hooks.length,3);
});
test('Hook超时后先对账：已保存的Hook通过续跑识别，不重复POST',async t=>{
 const f=await fleet(t),plan=await planFleet(options(f)),apply={...options(f),planFile:plan.planFile,planHash:plan.planHash,confirm:true};f.unknownHook();assert.equal((await applyFleet(apply)).status,'attention');assert.equal(f.hooks.length,1);assert.equal((await applyFleet(apply)).status,'configuration-verified');assert.equal(f.hooks.length,1);
});
test('回退新Job只禁用保留历史，恢复中央来源；实际配置被别人改动时拒绝覆盖',async t=>{
 const f=await fleet(t,2),before=readFileSync(path.join(f.base,'source-0.json'),'utf8'),plan=await planFleet(options(f)),apply={...options(f),planFile:plan.planFile,planHash:plan.planHash,confirm:true};await applyFleet(apply);let r=await rollbackFleet(apply);assert.equal(r.status,'rolled-back',JSON.stringify(r));assert.equal(jobContract(f.jobs.get('生产-CHECK-0')).disabled,'true');assert.equal(readFileSync(path.join(f.base,'source-0.json'),'utf8'),before);assert.equal(f.jobs.size,2);assert.ok(f.calls.every(v=>v.method!=='DELETE'));
});
test('Job配置摘要仅豁免已知Declarative跟踪元数据；脚本、参数和权限变化都能发现',()=>{
 const base='<flow-definition><actions/><description>x</description><properties/><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>echo 1</script><sandbox>true</sandbox></definition><disabled>false</disabled></flow-definition>';
 const tracked=base.replace('<actions/>','<actions><org.jenkinsci.plugins.pipeline.modeldefinition.actions.DeclarativeJobPropertyTrackerAction><jobProperties><string>metadata</string></jobProperties></org.jenkinsci.plugins.pipeline.modeldefinition.actions.DeclarativeJobPropertyTrackerAction></actions>');assert.equal(jenkinsJobConfigHash(base,'stable-v1'),jenkinsJobConfigHash(tracked,'stable-v1'));assert.notEqual(jenkinsJobConfigHash(base),jenkinsJobConfigHash(tracked));assert.notEqual(jenkinsJobConfigHash(base,'stable-v1'),jenkinsJobConfigHash(base.replace('echo 1','echo bypass'),'stable-v1'));assert.notEqual(jenkinsJobConfigHash(base,'stable-v1'),jenkinsJobConfigHash(base.replace('<properties/>','<properties><authorization>new-rights</authorization></properties>'),'stable-v1'));assert.throws(()=>jenkinsJobConfigHash(base,'unknown'));
});

test('中央来源漂移在创建维护标记及远端写入前拒绝；旧Job忙时不写',async t=>{
 const f=await fleet(t),p=await planFleet(options(f));
 writeFileSync(path.join(f.base,'source-0.json'),'{}');
 await assert.rejects(applyFleet({...options(f),planFile:p.planFile,planHash:p.planHash,confirm:true}),/中央来源/);
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 assert.equal(existsSync(path.join(f.base,'automation-data/fleet-maintenance.json')),false);
});
test('回退重复执行不重复改写；回退后的任务再被修改会明确待处理',async t=>{
 const f=await fleet(t),p=await planFleet(options(f)),a={...options(f),planFile:p.planFile,planHash:p.planHash,confirm:true};
 await applyFleet(a);await rollbackFleet(a);const posts=f.calls.filter(c=>c.method==='POST').length;
 assert.equal((await rollbackFleet(a)).status,'rolled-back');assert.equal(f.calls.filter(c=>c.method==='POST').length,posts);
 f.jobs.set('生产-CHECK-0',f.jobs.get('生产-CHECK-0').replace('<disabled>true</disabled>','<disabled>false</disabled>'));
 assert.equal((await rollbackFleet(a)).status,'attention');
});
test('已有无关权限、保留策略必须原样保留，不能借匹配入口悄悄批准未知设置',()=>{
 const base='<flow-definition><actions/><description>WL Gate managed | old</description><properties><auth>original</auth></properties><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>old</script><sandbox>true</sandbox></definition><disabled>false</disabled></flow-definition>';
 const desired=renderFleetJob({beforeXml:base,script:'echo 1',binding:{project:'demo',branch:'test',scope:'all'},mode:'check',secret:'fixture-secret'});
 const entry={beforeXml:base,desiredXml:desired,contract:jobContract(desired)};
 assert.equal(fleetWriteMatches(desired,entry),true);
 assert.equal(fleetWriteMatches(desired.replace('<auth>original</auth>','<auth>admin</auth>'),entry),false);
});

test('中央已有台账时只迁移Job摘要身份，保留历史、水位和原始问题台账',async t=>{
 const {generateKeyPairSync}=await import('node:crypto');const {loadAutomationConfig}=await import('../../lib/automation.js');const {stableStringify}=await import('../../lib/util.js');
 const f=await fleet(t),key=generateKeyPairSync('ed25519'),privateKeyFile=put(f.base,'private.pem',key.privateKey.export({type:'pkcs8',format:'pem'})),publicKeyFile=put(f.base,'public.pem',key.publicKey.export({type:'spki',format:'pem'}));
 const b=f.registry.bindings[0],sourceFile=path.join(f.base,'source-0.json'),s=JSON.parse(readFileSync(sourceFile));Object.assign(s,{tokenEnv:'TOKEN',userEnv:'USER',artifacts:{job:b.jobs.check,paths:['summary.json']},qualitySummary:'summary.json'});put(f.base,'source-0.json',s);
 const governanceConfigFile=put(f.base,'governance.json',{schemaVersion:1,issuer:'central',publicKeyFile,allowedLinkOrigins:['https://jenkins.example.invalid'],operators:['operator'],projects:{'wl-produce':{owner:'owner',backup:'backup',escalationOwner:'manager',reviewers:['reviewer'],channel:'group',issueBaseUrl:'https://jenkins.example.invalid/issues',scopes:{[b.scope]:{requiredChecks:['FIXTURE'],...Object.fromEntries(['policyHash','rulesHash','baselineHash','waiversHash'].map(k=>[k,b.pins[k]]))}}}},channels:{group:{type:'feishu',webhookEnv:'GROUP_WEBHOOK',signingSecretEnv:'GROUP_SECRET'}}});
 const a=JSON.parse(readFileSync(f.automationFile)),ledger=put(f.base,'ledger.json',{kept:'original-issue-ledger'});Object.assign(a,{governanceConfigFile,stateFile:ledger,receiptPrivateKeyFile:privateKeyFile});Object.assign(a.sources[0],{actors:{'123':'owner'},since:'2026-10-15T00:00:00Z'});put(f.base,'automation.json',a);
 const original=loadAutomationConfig(f.automationFile),state={schemaVersion:1,binding:digest(stableStringify(original)),runs:{'source-0:5':{terminal:true,revisions:{a:{done:true,immutable:'evidence'}}}},history:[{kept:'earlier-tick'}],health:{},discovery:{'source-0':{highWatermarkRunId:5}},reviewPublications:{kept:'publication'}};
 mkdirSync(a.dataDir,{recursive:true});const stateFile=put(a.dataDir,'automation-state.json',state),plan=await planFleet(options(f));const args={...options(f),planFile:plan.planFile,planHash:plan.planHash,confirm:true};
 const result=await applyFleet(args);assert.equal(result.status,'configuration-verified',JSON.stringify(result));const after=JSON.parse(readFileSync(stateFile));
 assert.equal(after.binding,digest(stableStringify(loadAutomationConfig(f.automationFile))));assert.notEqual(after.binding,state.binding);assert.deepEqual(after.runs,state.runs);assert.deepEqual(after.discovery,state.discovery);assert.deepEqual(after.reviewPublications,state.reviewPublications);assert.deepEqual(after.history[0],state.history[0]);assert.deepEqual(JSON.parse(readFileSync(ledger)),{kept:'original-issue-ledger'});
 // Simulate interruption after source files changed, before the state checkpoint.
 const journalFile=path.join(path.dirname(plan.planFile),'journal.json'),journal=JSON.parse(readFileSync(journalFile));
 journal.pinTransaction.completed=false;writeFileSync(journalFile,JSON.stringify(journal));writeFileSync(stateFile,JSON.stringify(state));
 const restoredPatch=journal.pinTransaction.patches[0];writeFileSync(restoredPatch.file,restoredPatch.before);
 assert.equal((await applyFleet(args)).status,'configuration-verified');const recovered=JSON.parse(readFileSync(stateFile));
 assert.deepEqual(recovered.runs,state.runs);assert.equal(recovered.history.filter(v=>v.transactionId===journal.pinTransaction.id).length,1);

 assert.equal((await rollbackFleet(args)).status,'rolled-back');const restored=JSON.parse(readFileSync(stateFile));assert.equal(restored.binding,state.binding);assert.deepEqual(restored.runs,state.runs);
});

test('服务器入口批量接入同步运行时与必需原件；回退恢复旧来源且不遗失台账',async t=>{
 const f=await fleet(t);f.registry.nativeEntry={loaderFile:path.join(f.base,'entry.groovy'),loaderHash:'a'.repeat(64),runtimeHash:gateRuntimeHash()};put(f.base,'bindings.json',f.registry);const sf=path.join(f.base,'source-0.json'),s=JSON.parse(readFileSync(sf));s.artifacts={job:'生产-CHECK-0',paths:['quality-reports/quality-summary.json']};put(f.base,'source-0.json',s);const before=readFileSync(sf,'utf8'),p=await planFleet(options(f)),a={...options(f),planFile:p.planFile,planHash:p.planHash,confirm:true};assert.equal(p.counts.blocked,0);const result=await applyFleet(a);assert.equal(result.status,'configuration-verified',JSON.stringify(result));const after=JSON.parse(readFileSync(sf));assert.equal(after.nativeEntry.runtimeHash,gateRuntimeHash());assert(after.artifacts.paths.includes('quality-reports/ci-integration/entry-context.json'));assert.match(jobContract(f.jobs.get('生产-CHECK-0')).script,/node\('wl-quality-router'\).*load/);assert.equal((await rollbackFleet(a)).status,'rolled-back');assert.equal(readFileSync(sf,'utf8'),before);
});
