import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,writeFileSync,mkdirSync,rmSync,cpSync,readdirSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {fixture,bind,put,git,commit} from '../test-support/jenkins-fixture.mjs';
import {createControlReviewFixture} from '../test-support/control-review-fixture.mjs';
import {REVIEW_DIMENSIONS} from '../../lib/review.js';
import {runJenkinsAction} from '../../lib/jenkins-runtime.js';
import {planJenkinsBinding,digest,renderJenkinsEntry} from '../../lib/jenkins-integration.js';
import {publishReviewAuthorizations} from '../../lib/review-publish.js';
import {dispatchApprovedBuilds} from '../../lib/jenkins-dispatch.js';
import {selectReleaseReview} from '../../lib/release-review.js';
import {archiveQualityReport,verifyPublishedQualityReport} from '../../lib/report-publication.js';
import {signPlatformReceipt,ingestGovernance,ingestLifecycleGovernance,readGovernanceState,dispatchGovernance,outboxGovernance} from '../../lib/governance.js';
import {collectCiSource} from '../../lib/ci-source.js';
import {createValidationBuildLifecycle} from '../../lib/lifecycle-source.js';
import {BUILD_RESULT_PATH,BUILD_ARCHIVE_PATH} from '../../lib/build-artifacts.js';
import {automationTick,loadAutomationConfig} from '../../lib/automation.js';
import {discoverCiRuns} from '../../lib/ci-discovery.js';

const json=file=>JSON.parse(readFileSync(file));
const policy={schemaVersion:1,project:'demo',dimensions:REVIEW_DIMENSIONS.map(d=>({id:d.id,applicable:true,requiredEvidenceTypes:[['coding','scan'].includes(d.id)?'gate-summary':`${d.id}-evidence`]}))};
const fakeEnv={TOKEN:'simulation-ci',WL_JENKINS_BUILD_USER:'dispatch-service',WL_JENKINS_BUILD_TOKEN:'simulation-build',WL_JENKINS_READ_USER:'reader',WL_JENKINS_READ_TOKEN:'simulation-reader',
  PROJECT_WEBHOOK:'https://open.feishu.cn/open-apis/bot/v2/hook/simulation-project',PROJECT_SECRET:'simulation-project-sign',CI_WEBHOOK:'https://open.feishu.cn/open-apis/bot/v2/hook/simulation-ci',CI_SECRET:'simulation-ci-sign'};
const write=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n');

// Real Git checkout, Gate execution, nine-dimensional evidence collection,
// OIDC login, explicit approval, separate signatures, dispatcher, build runner,
// artifact archive, collector and durable signed outbox. Only remote APIs and
// dependency downloads are isolated substitutes; no real person's consent or
// real business scan coverage is claimed by this test.
async function chain(t){
  const j=fixture(t,{project:'demo',reviewPolicy:policy});await bind(j);
  const runner=(exe,args,options)=>args[1]==='ci-prepare'?{status:0}:spawnSync(exe,args,{...options,stdio:['ignore','pipe','pipe']});
  const scan=async()=>{
    rmSync(path.join(j.root,'quality-reports'),{recursive:true,force:true});
    const result=await runJenkinsAction({action:'check',registryFile:j.registryFile,root:j.root,env:{...process.env,...j.environment('CHECK'),gitlabAfter:git(j.root,'rev-parse','HEAD')},runner});
    return {result,summary:json(path.join(j.root,'quality-reports/quality-summary.json'))};
  };
  put(j.root,'src/Order.java','class Order {} // BAD\n');commit(j.root);const bad=await scan();assert.equal(bad.result.exitCode,1);
  // A deterministic repair is run as a script, then the real current candidate
  // is committed/rescanned. Approval/preview safety of the general repair engine
  // is exercised in prevention-project-chain.test.mjs for both project types.
  const repair=put(j.base,'canary-fix.mjs',"import {writeFileSync} from 'node:fs';writeFileSync('src/Order.java','class Order {}\\n');\n");
  assert.equal(spawnSync(process.execPath,[repair],{cwd:j.root}).status,0);commit(j.root);const good=await scan();assert.equal(good.result.exitCode,0);
  assert.equal(good.summary.findings.length,0);assert.notEqual(bad.summary.run.commitSha,good.summary.run.commitSha);
  const now=Date.parse(good.summary.run.startedAt)+3000,sha=good.summary.run.commitSha;
  const f=await createControlReviewFixture(t,{sourceSummary:good.summary,reviewPolicy:policy,branch:'test',scope:'test',technicalManager:'reviewer',sequence:450001,now});
  const g=json(f.c.governanceConfigFile),approved=planJenkinsBinding(j.options).config.bindings[0].pins;
  g.allowedLinkOrigins.push('https://ci.example.invalid','https://jenkins.example.invalid');
  Object.assign(g.projects.demo,{domain:'生产 · 模拟',technicalManager:'reviewer',managerSubmissionNotify:'observer',requireRiskMentions:true,members:['author']});
  g.people=Object.fromEntries(['owner','backup','author','reviewer','observer'].map(actor=>[actor,{name:actor==='observer'?'李月（模拟身份）':actor,roles:[actor==='reviewer'?'technical-manager':'developer'],feishu:{idType:'open_id',id:'ou_sim_'+actor}}]));
  g.channels={project:{type:'feishu',webhookEnv:'PROJECT_WEBHOOK',signingSecretEnv:'PROJECT_SECRET'},ci:{type:'feishu',webhookEnv:'CI_WEBHOOK',signingSecretEnv:'CI_SECRET'},group:{type:'feishu',webhookEnv:'CI_WEBHOOK',signingSecretEnv:'CI_SECRET'}};
  const makeScope=(channel,surface)=>({...g.projects.demo.scopes.test,notification:{channel,surface,branch:'test',validationBranch:true,requireResolvedFindings:true}});
  g.projects.demo.scopes.test=makeScope('ci','ci-summary');g.projects.demo.scopes.merge=makeScope('project','project-summary');g.projects.demo.scopes.build=makeScope('ci','ci-summary');write(f.c.governanceConfigFile,g);
  const archive=archiveQualityReport({input:{summary:good.summary,dimensions:json(f.draft.recordFile).content.dimensions,presentation:{}},outDir:path.join(j.base,'report-archive'),jenkinsBuildUrl:j.environment('CHECK').BUILD_URL});
  const html=readFileSync(archive.entryFile);
  await verifyPublishedQualityReport({manifestFile:archive.manifestFile,expectedOrigin:'https://jenkins.example.invalid',fetchImpl:async()=>new Response(html,{headers:{'content-type':'text/html'}}),now});
  await assert.rejects(verifyPublishedQualityReport({manifestFile:archive.manifestFile,expectedOrigin:'https://jenkins.example.invalid',fetchImpl:async()=>new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}),now}),/不一致/);
  const signEvent=(payload,name)=>{const file=path.join(j.base,name+'.receipt.json');write(file,signPlatformReceipt(payload,{privateKeyFile:f.c.receiptPrivateKeyFile,issuer:g.issuer,createdAt:new Date(now).toISOString()}));return file;};
  const ingest=(summary,scope,sequence=1)=>{
    const file=put(j.base,`${scope}-${sequence}.summary.json`,summary);
    const event={schemaVersion:1,kind:'quality-event',eventId:`${scope}-${sequence}`,reportEventId:summary.run.eventId,project:'demo',scope,sha:summary.run.commitSha,authorId:'author',ref:'origin/test',sequence,pipelineId:'12',jobId:'CHECK',jobStatus:summary.decision.status==='passed'?'success':'failed',reportHash:digest(readFileSync(file)),reportUrl:archive.reportUrl,pipelineUrl:j.environment('CHECK').BUILD_URL};
    return ingestGovernance({configFile:f.c.governanceConfigFile,stateFile:f.c.stateFile,eventFile:signEvent(event,`${scope}-${sequence}`),summaryFile:file,now});
  };
  const publisher=path.join(j.base,'publisher.json'),publicationDir=path.join(j.base,'formal');mkdirSync(publicationDir);
  const trustFile=path.join(j.base,'trust.json'),trustProject={reviewers:['reviewer','other'],technicalManager:'reviewer',requireTechnicalManagerReview:true,requireResolvedFindings:true,authorizationIssuer:'identity-authority',scope:'test',profile:'standard',
    publicKeyFile:path.join(f.root,'review-public.pem'),authorizationPublicKeyFile:path.join(f.root,'authorization-public.pem'),collectorConfigFile:f.configFile,controlCatalogFile:path.join(f.c.dataDir,'reviews.json'),evidenceRoots:[f.options.evidenceRoot],...Object.fromEntries(['policyHash','rulesHash','baselineHash','waiversHash','reviewPolicyHash'].map(k=>[k,approved[k]]))};
  write(trustFile,{schemaVersion:1,kind:'release-review-trust',projects:{demo:trustProject}});
  const script=put(j.base,'business-build.sh','#!/bin/sh\nset -eu\nmkdir -p dist\nprintf "canary built from approved source" > dist/app.txt\n');
  Object.assign(j.seed.binding,{jobs:{check:'produce/CHECK',build:'produce/BUILD'},review:{trustFile,publicationDir},build:{scriptFile:script,artifactGlob:'dist/**'}});write(j.seedFile,j.seed);await bind(j);
  write(publisher,{schemaVersion:1,controlCatalogFile:trustProject.controlCatalogFile,authorizationDir:path.join(f.c.dataDir,'authorizations'),stateFile:path.join(j.base,'publisher-state.json'),manifestDir:publicationDir,
    reviewPrivateKeyFile:path.join(f.root,'review-private.pem'),reviewPublicKeyFile:trustProject.publicKeyFile,authorizationPublicKeyFile:trustProject.authorizationPublicKeyFile,authorizationIssuer:'identity-authority',
    projects:{demo:{...trustProject,reviewPolicyFile:path.join(f.root,'quality/review-policy.json')}}});
  const dispatchConfig={registryFile:j.registryFile,bindingId:j.seed.binding.id},queues=[],builds=[],posts=[];
  let transport='normal',head=sha;
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url);
    if(u.hostname==='ci.example.invalid' && u.pathname.includes('/repository/branches/'))return new Response(JSON.stringify({name:'test',commit:{id:head}}));
    if(u.hostname==='ci.example.invalid' && (u.pathname.endsWith('/merge_requests') || u.pathname.endsWith('/merge_requests/7'))){
      const mr={id:51,iid:7,project_id:12,state:'merged',merge_commit_sha:sha,target_branch:'test',author:{id:15}};return new Response(JSON.stringify(u.pathname.endsWith('/merge_requests')?[mr]:mr));
    }
    if(u.hostname!=='jenkins.example.invalid')return f.fetchImpl(url,init);
    if(u.pathname.endsWith('/config.xml')){const script=renderJenkinsEntry(json(j.registryFile),j.registryFile).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');return new Response(`<flow-definition><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>${script}</script></definition><disabled>false</disabled></flow-definition>`);}
    if(u.pathname==='/queue/api/json')return new Response(JSON.stringify({items:queues}));
    if(u.pathname.endsWith('/BUILD/api/json'))return new Response(JSON.stringify({builds}));
    if(u.pathname.endsWith('/buildWithParameters')){
      assert.equal(init.method,'POST');const parameters=[...new URLSearchParams(init.body)].map(([name,value])=>({name,value}));posts.push(parameters);
      queues.push({id:17,task:{url:'https://jenkins.example.invalid/job/produce/job/BUILD/'},actions:[{parameters}]});
      if(transport==='unknown')throw Error('simulated response lost after queue accepted');
      return new Response('',{status:201,headers:{location:'https://jenkins.example.invalid/queue/item/17/'}});
    }
    throw Error(`unexpected Jenkins ${u.pathname}`);
  };
  const dispatch=extra=>dispatchApprovedBuilds({config:dispatchConfig,ciConfigFile:f.ciConfigFile,dataDir:path.join(j.base,'automation/build-dispatch/check'),send:true,env:fakeEnv,fetchImpl,now:now+10000,...extra});
  const approve=async()=>{
    await f.register();const authorCookie=await f.login('author'),authorForm=await f.form(authorCookie);
    assert.notEqual((await f.http({method:'POST',cookie:authorCookie,body:new URLSearchParams(authorForm.fields).toString()})).status,200,'self review must not approve');
    const cookie=await f.login(),{fields}=await f.form(cookie);assert.equal((await f.http({method:'POST',cookie,body:new URLSearchParams(fields).toString()})).status,200);
    const p=await publishReviewAuthorizations({configFile:publisher,env:fakeEnv,fetchImpl,now});assert.equal(p.published.length,1,JSON.stringify(p.errors));return p;
  };
  return {j,f,now:now+10000,sha,bad,good,archive,html,approved,trustFile,publicationDir,ingest,signEvent,approve,dispatch,fetchImpl,posts,queues,builds,runner,transport:value=>transport=value,head:value=>head=value};
}

test('贯通：实际扫描/脚本修复→九维授权→自动续建→真实制品归档/采集→两个机器人持久投递',async t=>{
  const c=await chain(t),{j,f,now,sha}=c;
  c.ingest(c.bad.summary,'merge');c.ingest(c.good.summary,'test');
  const pending=await c.dispatch();assert.equal(pending.sent.length,0);assert.equal(c.posts.length,0,'no formal review must not trigger build');
  await c.approve();const dispatched=await c.dispatch();assert.equal(dispatched.status,'ok',JSON.stringify(dispatched));assert.equal(dispatched.sent.length,1);
  await c.dispatch();assert.equal(c.posts.length,1,'same review and restart do not build twice');
  const id=dispatched.sent[0].id,env={...process.env,...j.environment('BUILD'),...fakeEnv,WL_REVIEW_SHA:sha,WL_GATE_DISPATCH_ID:id};
  await runJenkinsAction({action:'prepare',registryFile:j.registryFile,root:j.root,env,runner:c.runner,now});
  const admit=await runJenkinsAction({action:'admit',registryFile:j.registryFile,root:j.root,env,now,verifyReview:options=>selectReleaseReview({...options,fetchImpl:c.fetchImpl})});
  // Admission performs real verification work. Advance the simulated build
  // clock from its actual receipt rather than assuming it finished in 1s.
  const buildTime=Date.parse(json(path.join(j.root,'quality-reports/ci-integration/admission.json')).createdAt)+1000;
  const built=await runJenkinsAction({action:'build',registryFile:j.registryFile,root:j.root,env,admissionHash:admit.admissionHash,runner:c.runner,now:buildTime});assert.equal(built.exitCode,0);assert.equal(built.approvedForDeployment,false);
  const result=json(path.join(j.root,BUILD_RESULT_PATH)),zip=readFileSync(path.join(j.root,BUILD_ARCHIVE_PATH));assert.equal(result.artifacts[0].sha256,digest(zip));assert.equal(result.commitSha,sha);
  const zipTest=spawnSync('python3',['-c','import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read("dist/app.txt")==b"canary built from approved source"',path.join(j.root,BUILD_ARCHIVE_PATH)],{encoding:'utf8'});assert.equal(zipTest.status,0,zipTest.stderr);
  const ci=path.join(j.base,'build-source.json'),request=put(j.base,'request.json',{sha,runId:12,sequence:120001,authorId:'author'}),jobUrl=env.BUILD_URL;
  const approvedScript=renderJenkinsEntry(json(j.registryFile),j.registryFile).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),xml=`<flow-definition><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>${approvedScript}</script></definition><disabled>false</disabled></flow-definition>`,job={number:12,timestamp:now-3000,building:false,result:'SUCCESS',url:jobUrl,actions:[{lastBuiltRevision:{SHA1:sha,branch:[{SHA1:sha,name:'origin/test'}]}},{causes:[{_class:'hudson.model.Cause$UserIdCause',userId:'dispatch-service'}]}],artifacts:[BUILD_RESULT_PATH,BUILD_ARCHIVE_PATH].map(relativePath=>({relativePath}))};
  write(ci,{schemaVersion:1,system:'jenkins',project:'demo',scope:'test',baseUrl:'https://jenkins.example.invalid',tokenEnv:'WL_JENKINS_READ_TOKEN',userEnv:'WL_JENKINS_READ_USER',jobPath:'produce/BUILD',jobConfigHash:digest(xml),ref:'origin/test',requiredJobs:['produce/BUILD'],maxArtifactBytes:256*1024*1024,actorSource:{system:'gitlab',baseUrl:'https://ci.example.invalid',projectId:12,tokenEnv:'TOKEN',ref:'test'},artifacts:{job:'produce/BUILD',paths:[BUILD_RESULT_PATH,BUILD_ARCHIVE_PATH]}});
  c.queues.splice(0);c.builds.push({...job,actions:[...job.actions,{parameters:c.posts[0]}]});
  const collectFetch=async(url,options)=>{
    const u=new URL(url);
    if(u.hostname!=='jenkins.example.invalid' || u.pathname==='/queue/api/json' || u.pathname==='/job/produce/job/BUILD/api/json' && u.searchParams.get('tree')?.includes('actions['))return c.fetchImpl(url,options);
    if(u.pathname.endsWith('/config.xml'))return new Response(xml);
    if(url.includes('/artifact/'))return new Response(readFileSync(path.join(j.root,decodeURI(url.split('/artifact/')[1]))));
    return new Response(JSON.stringify(u.pathname==='/job/produce/job/BUILD/api/json'?{builds:[{number:12,timestamp:job.timestamp}]}:job));
  };
  const collection=await collectCiSource({configFile:ci,requestFile:request,outDir:path.join(j.base,'build-collection'),env:fakeEnv,fetchImpl:collectFetch,now:now+2000});
  const fact=createValidationBuildLifecycle({configFile:ci,sourceFile:collection.sourceFile,sha,outDir:path.join(j.base,'build-event'),now:now+2000});
  const payload=json(fact.eventFile);assert.equal(payload.status,'success');assert.equal(payload.environment,undefined);
  const reviewCi=put(j.base,'review-ci.json',{schemaVersion:1,collectorConfigFile:f.configFile,reviewPolicyFile:path.join(f.root,'quality/review-policy.json'),controlConfigFile:f.controlConfigFile});
  const automation=put(j.base,'automation.json',{schemaVersion:1,governanceConfigFile:f.c.governanceConfigFile,stateFile:f.c.stateFile,dataDir:path.join(j.base,'automation'),receiptPrivateKeyFile:f.c.receiptPrivateKeyFile,sources:[
    {id:'check',configFile:f.ciConfigFile,actors:{'15':'author'},since:new Date(now-60000).toISOString(),review:{configFile:reviewCi,outRoot:f.options.evidenceRoot,publication:{manifestDir:c.publicationDir,publicKeyFile:path.join(f.root,'review-public.pem'),authorizationPublicKeyFile:path.join(f.root,'authorization-public.pem'),expectAuthorizationIssuer:'identity-authority',expectReviewPolicyHash:f.collector.reviewPolicyHash,evidenceRoot:f.options.evidenceRoot}},buildDispatch:{registryFile:j.registryFile,bindingId:j.seed.binding.id}},
    {id:'build',configFile:ci,actors:{'gitlab:15':'author'},since:new Date(now-60000).toISOString(),buildResultPath:BUILD_RESULT_PATH}
  ]});
  assert.equal(loadAutomationConfig(automation).sources.length,2);
  const tick=await automationTick({configFile:automation,env:fakeEnv,fetchImpl:collectFetch,now:now+3000,discoverImpl:args=>args.configFile===f.ciConfigFile?Promise.resolve({runs:[],discoveryErrors:[],attemptedRecheckRunIds:[],partial:false}):discoverCiRuns(args)});
  assert.equal(tick.errors.length,0,JSON.stringify(tick.errors));assert.equal(c.posts.length,1);assert.equal(tick.sources[1].collected,1);assert.equal(json(path.join(j.base,'automation/build-dispatch/check/dispatch-state.json')).requests[id].status,'observed');
  const delivery=[],fetchImpl=async(url,options)=>{
    const body=JSON.parse(options.body),secret=url===fakeEnv.PROJECT_WEBHOOK?fakeEnv.PROJECT_SECRET:fakeEnv.CI_SECRET;
    assert.equal(body.sign,createHmac('sha256',`${body.timestamp}\n${secret}`).update('').digest('base64'));delivery.push({channel:url===fakeEnv.PROJECT_WEBHOOK?'project':'ci',body});return new Response('{"code":0}');
  };
  const sent=await dispatchGovernance({configFile:f.c.governanceConfigFile,stateFile:f.c.stateFile,send:true,env:fakeEnv,fetchImpl,now:now+4000});assert.equal(sent.results.length,4);
  assert.equal(delivery.filter(d=>d.channel==='project').length,1);assert.match(delivery.find(d=>d.channel==='project').body.card.header.title.content,/项目合并检查/);
  assert(delivery.find(d=>d.channel==='project').body.card.body.elements.at(-1).content.includes('<at id="ou_sim_author">'));assert(JSON.stringify(delivery).includes('ou_sim_reviewer'));
  assert.equal((await dispatchGovernance({configFile:f.c.governanceConfigFile,stateFile:f.c.stateFile,send:true,env:fakeEnv,fetchImpl,now})).results.length,0);
  const ledger=readGovernanceState({configFile:f.c.governanceConfigFile,stateFile:f.c.stateFile});assert(Object.values(ledger.lifecycles).some(v=>v.category==='build' && v.status==='success'));assert(Object.values(ledger.issues).every(i=>i.status!=='closed'),'build does not close issues');
  if(process.env.WL_FULL_CHAIN_EVIDENCE_DIR){
    const out=path.join(process.env.WL_FULL_CHAIN_EVIDENCE_DIR,'jenkins-complete-chain');mkdirSync(out,{recursive:true});cpSync(c.archive.archiveDir,path.join(out,'report'),{recursive:true});
    for(const [name,value] of Object.entries({before:c.bad.summary,after:c.good.summary,dispatch:dispatched,build:result,ledger,cards:delivery,verification:{simulation:true,dependencyDownloadsMocked:true,remoteApisMocked:true,realGitAndGate:true,realBusinessCanaryBuild:true,realOidcProtocolAndSignatures:true,realChatContacted:false,actualBusinessProjectsVerified:false}}))write(path.join(out,name+'.json'),value);
    writeFileSync(path.join(out,'business-artifacts.zip'),zip);
  }
});

test('续建响应丢失/重启只对账不重复触发；目标分支已前移不构建旧版本',async t=>{
  const c=await chain(t);await c.approve();c.head('c'.repeat(40));assert.equal((await c.dispatch()).superseded.length,1);assert.equal(c.posts.length,0);
  c.head(c.sha);c.transport('unknown');const first=await c.dispatch();assert.equal(first.unknown.length,1);assert.equal(c.posts.length,1);
  const recovered=await c.dispatch();assert.equal(recovered.unknown.length,0);assert.equal(recovered.reused.length,1);assert.equal(c.posts.length,1);
  c.queues.splice(0);const missing=await c.dispatch();assert.equal(missing.unknown.length,1);assert.equal(c.posts.length,1);
});

test('中央实际卡片：仅提示也发送并严格拦截；最多三项、数字准确，缺@映射不伪造投递',async t=>{
  const c=await chain(t),{f,now}=c,report=structuredClone(c.good.summary);
  report.findings=Array.from({length:8},(_,i)=>({fingerprint:digest(String(i)),ruleId:`INFO/${i}`,severity:'info',file:'src/Order.java',line:1,status:'new',message:'模拟提示',dimension:'coding'}));
  c.ingest(report,'test');const options={configFile:f.c.governanceConfigFile,stateFile:f.c.stateFile,now},preview=outboxGovernance(options);
  assert.equal(preview.messages.length,1);const card=preview.messages[0].payload;
  assert.match(JSON.stringify(card),/提示 8/);assert.match(JSON.stringify(card),/另有 5 项问题/);assert.match(JSON.stringify(card),/剩余问题全部修复/);assert.equal(preview.messages[0].mentions.length,2);
  const configBytes=readFileSync(f.c.governanceConfigFile),config=JSON.parse(configBytes);delete config.people.author.feishu;write(f.c.governanceConfigFile,config);
  await assert.rejects(dispatchGovernance({...options,send:true,env:fakeEnv,fetchImpl:async()=>assert.fail('未批准更换映射不应联网')}),/台账配置.*身份不一致/);writeFileSync(f.c.governanceConfigFile,configBytes);
  const state=json(f.c.stateFile),item=Object.values(state.outbox)[0];item.snapshot.totals.info=1;write(f.c.stateFile,state);assert.throws(()=>outboxGovernance(options),/快照/);
});

test('正式Review被当前CI失联或原始文件变化阻断；续建在POST后进程中断可恢复',async t=>{
  const c=await chain(t);await c.approve();c.f.ciState.unavailable=true;
  assert.equal((await c.dispatch()).status,'attention');assert.equal(c.posts.length,0);c.f.ciState.unavailable=false;
  const interrupted=await c.dispatch({afterStage:stage=>{if(stage==='build-dispatch-posted')throw Error('simulated crash after POST');}});assert.equal(interrupted.status,'attention');assert.equal(c.posts.length,1);
  assert.equal((await c.dispatch()).reused.length,1);assert.equal(c.posts.length,1);
  const formal=json(path.join(c.publicationDir,readdirSync(c.publicationDir).find(n=>n.endsWith('.json'))));
  writeFileSync(formal.recordFile,'{}');assert.equal((await c.dispatch()).status,'attention');assert.equal(c.posts.length,1);
});
