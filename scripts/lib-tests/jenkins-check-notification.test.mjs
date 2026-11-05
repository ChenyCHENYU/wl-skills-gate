import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync,rmSync} from 'node:fs';
import {fixture,bind,git,put,commit} from '../test-support/jenkins-fixture.mjs';
import {planJenkinsInstallation,applyJenkinsInstallation} from '../../lib/jenkins-installation.js';
import {runJenkinsAction} from '../../lib/jenkins-runtime.js';
import {spawnSync} from 'node:child_process';
import {archiveQualityReport,publicationInput} from '../../lib/report-publication.js';
import {checkNotice,checkObservations,notifyJenkinsCheck} from '../../lib/jenkins-check-notification.js';
import {jenkinsReportInput} from '../../lib/jenkins-report-presentation.js';
const people={dev:{name:'执行甲',feishu:{idType:'user_id',id:'dev_id',verified:true}},lead:{name:'经理乙',feishu:{idType:'user_id',id:'lead_id',verified:true}}};
const owner={technicalManager:'lead'};
async function setup(t){
 const f=fixture(t);put(f.root,'src/Order.java','class Order {} // BAD\n');commit(f.root);
 const cfg={prefix:path.join(f.base,'native'),configDir:f.base,jenkinsOrigin:f.seed.jenkinsOrigin,registryFiles:[f.registryFile],centralAgentLabel:'test-node',reviewSignerAgentLabel:'isolated-test-signer'};
 const p=planJenkinsInstallation(cfg);applyJenkinsInstallation({...cfg,planHash:p.planHash,confirm:true});await bind(f);
 put(f.base,'ops-responsibility-directory.json',{schemaVersion:1,kind:'wl-ops-responsibility-directory',people,owners:{'wl-produce':owner},networkAccess:'intranet-vpn'});
 return f;
}
async function scan(f,number='12'){
 const env={...process.env,...f.environment('CHECK'),BUILD_NUMBER:number,BUILD_URL:`https://jenkins.example.invalid/job/produce/job/CHECK/${number}/`,WL_GATE_BUILD_USER_ID:'dev',WL_JENKINS_REPORT_USER:'reader',WL_JENKINS_REPORT_TOKEN:'reader-secret',WL_FEISHU_CI_WEBHOOK:'https://open.feishu.cn/open-apis/bot/v2/hook/mock-test-only',WL_FEISHU_CI_SECRET:'ci-secret-test-only'};
 const runner=(exe,args,options)=>args[1]==='ci-prepare'?{status:0}:spawnSync(exe,args,options);
 await runJenkinsAction({action:'check',registryFile:f.registryFile,root:f.root,env,runner});
 const summaryFile=path.join(f.root,'quality-reports/quality-summary.json');
 const input=publicationInput({summaryFile,reviewIndexFile:path.join(f.root,'quality-reports/review-latest.json')});
 const publication=archiveQualityReport({input,outDir:path.join(f.root,'quality-reports/archives'),jenkinsBuildUrl:env.BUILD_URL});
 put(f.root,'quality-reports/report-publication.json',publication);
 return {env,publication,report:input.summary};
}
test('真实Git/扫描/归档串联：只发当前报告，双@、彩色数字，修复提交复扫仅报告观测，重复运行不重复推送',async t=>{
 const f=await setup(t);let latest=await scan(f),posts=0,gets=0,payload;
 const fetchImpl=async(url,opts)=>{
  if(opts.method==='GET'){gets++;assert.equal(url,latest.publication.reportUrl);return new Response(readFileSync(latest.publication.entryFile),{status:200,headers:{'content-type':'text/html; charset=utf-8'}});}
  posts++;assert.match(url,/^https:\/\/open.feishu.cn\//);payload=JSON.parse(opts.body);return new Response('{"code":0}',{status:200});
 };
 const args=()=>({registryFile:f.registryFile,root:f.root,configDir:f.base,env:latest.env,fetchImpl});
 const first=await notifyJenkinsCheck(args());assert.equal(first.status,'sent');assert.equal(first.notificationComplete,true);assert.deepEqual(first.mentions,['dev_id','lead_id']);assert.equal(posts,1);
 assert.match(JSON.stringify(payload),/严重 1/);assert.doesNotMatch(JSON.stringify(payload),/reader-secret|ci-secret-test-only|已修复/);
 assert.equal((await notifyJenkinsCheck(args())).reused,true);assert.equal(posts,1);assert.equal(gets,2);
 rmSync(path.join(f.root,'quality-reports'),{recursive:true});put(f.root,'src/Order.java','class Order {}\n');commit(f.root);latest=await scan(f,'13');
 const second=await notifyJenkinsCheck(args());assert.equal(posts,2);assert.equal(second.observations.notSeen,1);assert.equal(second.observations.repaired,null);assert.equal(second.observations.closed,false);
 assert.match(JSON.stringify(payload),/本轮不再检出 1 项/);assert.doesNotMatch(JSON.stringify(payload),/已修复|整体修复通过/);
 assert.match(JSON.stringify(payload),/dev_id/);assert.match(JSON.stringify(payload),/lead_id/);
 // A mismatched source/manifest cannot produce a new request even if its URL looks real.
 const proofFile=path.join(f.root,'quality-reports/ci-integration/entry-context.json');const proof=JSON.parse(readFileSync(proofFile));put(f.root,'quality-reports/ci-integration/entry-context.json',{...proof,sha:'f'.repeat(40)});
 await assert.rejects(notifyJenkinsCheck(args()),/不匹配/);assert.equal(posts,2);
});
test('发送超时不自动重复发；失效/缩小检查范围不能冒充已修复，缺执行人仍必须提醒经理并明确通知未完成',async t=>{
 const f=await setup(t),latest=await scan(f);let posts=0;
 const fetchImpl=async(url,opts)=>{if(opts.method==='GET')return new Response(readFileSync(latest.publication.entryFile),{headers:{'content-type':'text/html'}});posts++;throw new Error('provider timeout');};
 const args={registryFile:f.registryFile,root:f.root,configDir:f.base,env:latest.env,fetchImpl};assert.equal((await notifyJenkinsCheck(args)).status,'unknown');assert.equal((await notifyJenkinsCheck(args)).status,'unknown');assert.equal(posts,1);
 const before={...latest.report,buildNumber:'12'},after=structuredClone(latest.report);after.findings=[];after.decision.status='invalid';after.checks[0].status='invalid';
 const changes=checkObservations(before,after,{ancestorVerified:true});assert.equal(changes.notSeen,0);assert.equal(changes.recheckUnavailable,1);assert.equal(changes.repaired,null);
 assert.equal(checkObservations(before,after,{ancestorVerified:false}),null);
 const broken=checkNotice({report:latest.report,binding:{project:'wl-produce',branch:'test',validationBranch:true},people,owner,publication:latest.publication,job:'produce/CHECK',number:'12'});
 assert.equal(broken.notificationComplete,false);assert.deepEqual(broken.mentions,['lead_id']);assert.match(JSON.stringify(broken.payload),/执行人.*未登记/);
});
test('报告从工作区外读取可信人员与当前入口证明，不把Git作者当执行人，拒绝错误源码',async t=>{
 const f=await setup(t),latest=await scan(f);
 const args={summaryFile:path.join(f.root,'quality-reports/quality-summary.json'),reviewIndexFile:path.join(f.root,'quality-reports/review-latest.json'),registryFile:f.registryFile,root:f.root,configDir:f.base,env:latest.env};
 const input=jenkinsReportInput(args);
 assert.equal(input.presentation.submitterName,'执行甲');assert.equal(input.presentation.technicalManagerName,'经理乙');assert.equal(input.presentation.pipelineLabel,'produce/CHECK · #12');assert.equal(input.presentation.observations,null);
 const noActor={...latest.env,WL_GATE_BUILD_USER_ID:'not-mapped',BUILD_USER_ID:'',gitlabUserUsername:''};
 assert.equal(jenkinsReportInput({...args,env:noActor}).presentation.submitterName,undefined);
 assert.throws(()=>jenkinsReportInput({...args,configDir:f.root}),/工作区外/);
 const changed=structuredClone(latest.report);changed.run.commitSha='f'.repeat(40);put(f.root,'quality-reports/quality-summary.json',changed);
 assert.throws(()=>jenkinsReportInput(args),/报告不是本轮|九维草稿不是本轮/);
});
