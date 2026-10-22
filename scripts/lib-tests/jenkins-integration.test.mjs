import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {GATE_ROOT,GATE_VERSION,digest,planJenkinsBinding,applyJenkinsBinding,inspectJenkinsBinding,assertBoundCheckout,verifyJenkinsJobs} from '../../lib/jenkins-integration.js';
import {runJenkinsAction} from '../../lib/jenkins-runtime.js';
import {planOnboarding,applyOnboarding} from '../../lib/onboard.js';
import {stableStringify} from '../../lib/util.js';

import {fixture,bind,git,put,commit} from '../test-support/jenkins-fixture.mjs';

test('真实项目提交自动计算批准摘要；同一薄入口用于两个Job，CHECK可先独立接通',async t=>{
  const f=fixture(t),before=git(f.root,'status','--porcelain'),plan=planJenkinsBinding(f.options);
  assert.equal(existsSync(f.registryFile),false);assert.equal(Object.keys(plan.config.bindings[0].pins).length,8);
  const result=await bind(f);assert.equal(result.remoteValidated,false);assert.match(result.pipelineScript,/jenkins-gate.groovy/);assert.doesNotMatch(result.pipelineScript,/checkout scm|verify-release-review|--expect-/);
  assert.equal(git(f.root,'status','--porcelain'),before);
  const context=inspectJenkinsBinding({registryFile:f.registryFile,root:f.root,env:f.environment('CHECK')});assert.equal(context.mode,'check');
  assert.equal(context.binding.review,undefined);assert.throws(()=>inspectJenkinsBinding({registryFile:f.registryFile,root:f.root,env:f.environment('BUILD')}),/未精确登记/);
});

test('错Job、错来源URL、配置漂移、个人分支和工作区内登记均在安装前拒绝',async t=>{
  const f=fixture(t);await bind(f);const input={registryFile:f.registryFile,root:f.root,env:f.environment('CHECK')};
  for(const env of [{...input.env,JOB_NAME:'someone/CHECK'},{...input.env,BUILD_URL:'https://jenkins.example.invalid/job/produce/job/CHECK/13/'},{...input.env,JENKINS_URL:'https://wrong.example.invalid/'}])assert.throws(()=>inspectJenkinsBinding({...input,env}));
  const original=readFileSync(f.registryFile);let c=JSON.parse(original);c.bindings[0].runtimeHash='0'.repeat(64);writeFileSync(f.registryFile,JSON.stringify(c));assert.throws(()=>inspectJenkinsBinding(input),/运行时字节/);writeFileSync(f.registryFile,original);
  c=JSON.parse(original);c.bindings[0].jobs.typo='bad';writeFileSync(f.registryFile,JSON.stringify(c));assert.throws(()=>inspectJenkinsBinding(input),/未知配置/);writeFileSync(f.registryFile,original);
  const inside=put(f.root,'bindings.json',original.toString());assert.throws(()=>inspectJenkinsBinding({...input,registryFile:inside}),/工作区/);rmSync(inside);
  const seed=structuredClone(f.seed);seed.binding.branch='feature/someone';seed.binding.validationBranch=false;put(f.base,'seed.json',seed);assert.throws(()=>planJenkinsBinding(f.options),/验证分支/);
  let calls=0;put(f.root,'quality/rules.lock.json',{changed:true});commit(f.root);
  await assert.rejects(runJenkinsAction({action:'check',...input,runner:()=>{calls++;return{status:0};}}),/配置漂移/);assert.equal(calls,0);
});

test('计划确认绑定源码和包字节；重复Job/拼错字段不写入；同仓模块策略可独立绑定',async t=>{
  const f=fixture(t,{scoped:true}),p=planJenkinsBinding(f.options);assert.equal(p.summary.policyFile,'quality/scopes/pl/policy.json');assert.equal(p.summary.evidencePlanFile,'quality/scopes/pl/evidence.plan.json');assert.deepEqual(p.summary.requiredChecks,['FIXTURE']);
  const seed=JSON.parse(readFileSync(f.seedFile));seed.binding.scope='another-scope';put(f.base,'seed.json',seed);
  await assert.rejects(applyJenkinsBinding({...f.options,confirm:true,planHash:p.planHash}),/已变化/);assert.equal(existsSync(f.registryFile),false);
  await bind(f);seed.binding.id='duplicate';put(f.base,'seed.json',seed);assert.throws(()=>planJenkinsBinding(f.options),/同一Jenkins任务/);
  seed.binding.jobs.check='other/CHECK';seed.binding.scopeTypo='x';put(f.base,'seed.json',seed);assert.throws(()=>planJenkinsBinding(f.options),/未知配置/);
});

test('构建必须先准备、当前正式Review严格通过；缺标记/旧SHA/错scope均拒绝',async t=>{
  const f=fixture(t,{build:true});await bind(f);const env=f.environment('BUILD'),args={registryFile:f.registryFile,root:f.root,env};
  await assert.rejects(runJenkinsAction({action:'admit',...args,verifyReview:()=>{throw Error('must not verify before preparation');}}),/ENOENT/);
  const context=inspectJenkinsBinding(args);assert.throws(()=>assertBoundCheckout(context,f.root,{...env,WL_REVIEW_SHA:'b'.repeat(40)}),/获批SHA/);
  await runJenkinsAction({action:'prepare',...args,runner:()=>({status:0})});
  const good={status:'verified',project:'wl-produce',sha:env.WL_REVIEW_SHA,sourceDigest:assertBoundCheckout(context,f.root,env).sourceDigest,preBuildFindingsResolved:true,liveVerified:true};
  await assert.rejects(runJenkinsAction({action:'admit',...args,verifyReview:async()=>({...good,liveVerified:false})}),/未全部通过/);
  await assert.rejects(runJenkinsAction({action:'admit',...args,verifyReview:async()=>({...good,sourceDigest:'0'.repeat(64)})}),/源码摘要/);
  const trust=JSON.parse(readFileSync(f.seed.binding.review.trustFile));trust.projects['wl-produce'].scope='different';put(f.base,'trust.json',trust);
  assert.throws(()=>inspectJenkinsBinding(args),/漂移/);
});

test('准入后只执行批准构建，凭据不传项目脚本；改回执、过期和重复执行被拦',async t=>{
  const f=fixture(t,{build:true});await bind(f);const env={...f.environment('BUILD'),WL_GITLAB_READ_TOKEN:'do-not-leak',WL_JENKINS_READ_TOKEN:'do-not-leak',WL_FEISHU_CI_SECRET:'do-not-leak',NODE_AUTH_TOKEN:'install-only'},args={registryFile:f.registryFile,root:f.root,env};
  const calls=[],runner=(exe,argv,opt)=>{calls.push({argv,env:opt.env});if(argv[0].endsWith('run-approved-build.mjs'))put(f.root,'dist/built.txt','actual fixture build');return{status:0};};
  await runJenkinsAction({action:'prepare',...args,runner});assert.equal(calls[0].env.NODE_AUTH_TOKEN,'install-only');assert.equal(calls[0].env.WL_JENKINS_READ_TOKEN,undefined);
  const good={status:'verified',project:'wl-produce',sha:env.WL_REVIEW_SHA,sourceDigest:assertBoundCheckout(inspectJenkinsBinding(args),f.root,env).sourceDigest,preBuildFindingsResolved:true,liveVerified:true};
  const admitted=await runJenkinsAction({action:'admit',...args,verifyReview:async()=>good});
  const file=path.join(f.root,'quality-reports/ci-integration/admission.json'),bytes=readFileSync(file);
  writeFileSync(file,JSON.stringify({...JSON.parse(bytes),scope:'other'}));
  await assert.rejects(runJenkinsAction({action:'build',...args,admissionHash:admitted.admissionHash,runner}),/被替换/);writeFileSync(file,bytes);
  await assert.rejects(runJenkinsAction({action:'build',...args,admissionHash:admitted.admissionHash,now:Date.now()+10*60000,runner}),/执行窗口/);
  const result=await runJenkinsAction({action:'build',...args,admissionHash:admitted.admissionHash,runner});assert.equal(result.status,'built-awaiting-artifact-archive');assert.equal(calls.length,2);assert.equal(calls[1].env.NODE_AUTH_TOKEN,undefined);assert.equal(calls[1].env.WL_GITLAB_READ_TOKEN,undefined);
  await assert.rejects(runJenkinsAction({action:'build',...args,admissionHash:admitted.admissionHash,runner}),/EEXIST/);assert.equal(calls.length,2);
});

test('隔离依赖下载后真实运行Gate与Review事实：通过/严重拦截都有当前SHA报告，缺业务证据不伪造正式审核',async t=>{
  const f=fixture(t);await bind(f);const env={...process.env,...f.environment('CHECK')};
  const runner=(exe,args,options)=>args[1]==='ci-prepare'?{status:0}:spawnSync(exe,args,options);
  let result=await runJenkinsAction({action:'check',registryFile:f.registryFile,root:f.root,env,runner});
  assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.approved,false);
  let report=JSON.parse(readFileSync(path.join(f.root,'quality-reports/quality-summary.json')));
  assert.equal(report.run.sourceBound,true);assert.equal(report.run.stage,'ci');assert.equal(report.checks[0].toolVersionVerified,true);assert.equal(report.findings.length,0);
  // A new Jenkins run starts from a clean workspace; the previous run is archived externally.
  rmSync(path.join(f.root,'quality-reports'),{recursive:true,force:true});
  put(f.root,'src/Order.java','class Order {} // BAD\n');commit(f.root);
  result=await runJenkinsAction({action:'check',registryFile:f.registryFile,root:f.root,env:{...env,gitlabAfter:git(f.root,'rev-parse','HEAD')},runner});
  assert.equal(result.exitCode,1);report=JSON.parse(readFileSync(path.join(f.root,'quality-reports/quality-summary.json')));
  assert.equal(report.run.commitSha,git(f.root,'rev-parse','HEAD'));assert.equal(report.findings[0].ruleId,'FIXTURE/RISK');
  assert.equal(result.approved,false);
});

test('服务端接线预检自动读配置并生成摘要，漏Gate、误触发和403不当成接通',async t=>{
  const f=fixture(t,{build:true}),bound=await bind(f),env={WL_JENKINS_READ_USER:'service',WL_JENKINS_READ_TOKEN:'private'};
  const escaped=bound.pipelineScript.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const trigger='<com.dabsquared.gitlabjenkins.GitLabPushTrigger><triggerOnPush>true</triggerOnPush><triggerOnMergeRequest>false</triggerOnMergeRequest><branchFilterType>NameBasedFilter</branchFilterType><includeBranchesSpec>test</includeBranchesSpec><excludeBranchesSpec></excludeBranchesSpec><secretToken>fixture-secret-not-output</secretToken></com.dabsquared.gitlabjenkins.GitLabPushTrigger>';
  const xml=(isCheck,script=escaped,events=trigger)=>`<flow-definition><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>${script}</script><sandbox>true</sandbox></definition><disabled>false</disabled><properties><org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty><triggers>${isCheck?events:''}</triggers></org.jenkinsci.plugins.workflow.job.properties.PipelineTriggersJobProperty></properties></flow-definition>`;
  let mode='good';const fetchImpl=async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.redirect,'error');const check=url.includes('/CHECK/');if(mode==='403')return new Response('',{status:403});return new Response(xml(check,mode==='skip'?"echo 'SUCCESS'":escaped,mode==='wrong-branch'?trigger.replace('>test<','>sit<'):trigger));};
  const result=await verifyJenkinsJobs({registryFile:f.registryFile,env,fetchImpl});assert.equal(result.jobs.length,2);assert.equal(result.runtimeExecuted,false);assert.equal(result.jobs[0].jobConfigHash.length,64);assert.doesNotMatch(JSON.stringify(result),/fixture-secret|private/);
  for(const value of ['skip','wrong-branch','403']){mode=value;await assert.rejects(verifyJenkinsJobs({registryFile:f.registryFile,env,fetchImpl}));}
});

test('真实CLI预览/写入和inspect；错误参数/受控路径链接均返回非零',t=>{
  const f=fixture(t),cli=path.join(GATE_ROOT,'bin/wl-skills-gate.js');
  const invoke=args=>spawnSync(process.execPath,[cli,...args],{cwd:f.root,encoding:'utf8',env:{...process.env,...f.environment('CHECK')}});
  const args=['--root',f.root,'--seed',f.seedFile,'--registry',f.registryFile];const preview=invoke(['jenkins','plan',...args]);assert.equal(preview.status,0,preview.stderr);const plan=JSON.parse(preview.stdout);
  assert.equal(invoke(['jenkins','bind',...args,'--confirm','--plan-hash',plan.planHash]).status,0);
  const inspected=invoke(['jenkins','inspect','--registry',f.registryFile]);assert.equal(inspected.status,0,inspected.stderr);assert.equal(JSON.parse(inspected.stdout).mode,'check');
  assert.equal(invoke(['jenkins','inspect','--registry',f.registryFile,'--project','other']).status,2);
  const link=path.join(f.base,'link.json');symlinkSync(f.registryFile,link);assert.equal(invoke(['jenkins','inspect','--registry',link]).status,2);
  const setup=invoke(['setup','jenkins','--root',f.root,'--config',f.seedFile,'--out',f.registryFile,'--preview','--json']);assert.equal(setup.status,0,setup.stderr);assert.equal(JSON.parse(setup.stdout).status,'preview');
});
