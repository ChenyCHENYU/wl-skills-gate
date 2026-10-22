import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoverJenkinsJobs} from '../../lib/jenkins-inventory.js';

const origin='https://jenkins.example.invalid/',env={WL_JENKINS_READ_USER:'reader',WL_JENKINS_READ_TOKEN:'inventory-private-token'};
const esc=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const flow=script=>`<flow-definition><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>${esc(script)}</script><sandbox>true</sandbox></definition></flow-definition>`;
const git=(repository='https://gitlab.example.invalid/team/wl-produce.git',branch='*/test',credential='Gitlab')=>`<scm class="hudson.plugins.git.GitSCM"><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>${esc(repository)}</url><credentialsId>${esc(credential)}</credentialsId></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs><branches><hudson.plugins.git.BranchSpec><name>${esc(branch)}</name></hudson.plugins.git.BranchSpec></branches></scm>`;
function fixture({jobs={},lists={},fail={}}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push({url,method:options.method});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Basic '+Buffer.from(env.WL_JENKINS_READ_USER+':'+env.WL_JENKINS_READ_TOKEN).toString('base64'));assert.equal(u.origin,new URL(origin).origin);
  const parts=u.pathname.split('/').filter(Boolean);let p=0;const names=[];while(parts[p]==='job'){names.push(decodeURIComponent(parts[p+1]));p+=2;}const name=names.join('/'),suffix=parts.slice(p).join('/');
  if(fail[name+':'+suffix])return new Response('',{status:fail[name+':'+suffix]});
  if(suffix==='api/json')return new Response(JSON.stringify({jobs:lists[name]||Object.keys(jobs).filter(n=>!n.includes('/')).map(n=>({name:n,_class:'org.jenkinsci.plugins.workflow.job.WorkflowJob'}))}));
  if(suffix==='config.xml')return Object.hasOwn(jobs,name)?new Response(jobs[name]):new Response('',{status:404});
  throw Error('unexpected mock route');
 };
 return {calls,run:inventory=>discoverJenkinsJobs({jenkinsOrigin:origin,inventory,env,fetchImpl})};
}

test('初次盘点无登记或中央文件：解析GitSCM，只发GET且不回显配置/秘密',async()=>{
 const f=fixture({jobs:{'生产-test':`<flow-definition><definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition">${git()}</definition><secretToken>do-not-leak-secret</secretToken></flow-definition>`}}),r=await f.run();
 assert.equal(r.kind,'jenkins-ops-inventory');assert.equal(r.status,'inventoried');assert.equal(r.remoteModified,false);assert.deepEqual(r.errors,[]);assert.equal(r.jobs[0].status,'read');assert.equal(r.jobs[0].managed,false);assert.match(r.jobs[0].configHash,/^[a-f0-9]{64}$/);assert.deepEqual(r.jobs[0].scmCandidates,[{repository:'https://gitlab.example.invalid/team/wl-produce.git',credentialId:'Gitlab',branches:['*/test']}]);assert.doesNotMatch(JSON.stringify(r),/do-not-leak-secret|inventory-private-token|<scm|<flow-definition>|script/);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('XML参数分支仅为候选，默认值不能成为本轮分支',async()=>{
 const xml=`<project><properties><hudson.model.ParametersDefinitionProperty><parameterDefinitions><hudson.model.StringParameterDefinition><name>BRANCH</name><defaultValue>sit</defaultValue></hudson.model.StringParameterDefinition><hudson.model.StringParameterDefinition><name>PASSWORD</name><defaultValue>not-output</defaultValue></hudson.model.StringParameterDefinition></parameterDefinitions></hudson.model.ParametersDefinitionProperty></properties>${git(undefined,'${BRANCH}')}</project>`;
 const r=await fixture({jobs:{dynamic:xml}}).run(),j=r.jobs[0];assert.equal(r.status,'attention');assert.deepEqual(j.scmCandidates[0].branches,[]);assert.equal(j.scmCandidates[0].dynamicBranch,'BRANCH');assert.deepEqual(j.parameterDefaults,[{name:'BRANCH',defaultValue:'sit'}]);assert.ok(j.discoveryGaps.some(g=>g.code==='dynamic-branch'));assert.doesNotMatch(JSON.stringify(r),/PASSWORD|not-output/);
});

test('真实内联风格：严格环境字面值和env.TAG被识别，不执行Groovy',async()=>{
 const script=`pipeline {
 environment {
 GIT_URL = 'git@gitlab.nisco.cn:YanTaiHuaXin-xxh/wl-ui.git'
 GIT_CREDENTIAL_ID = 'Gitlab'
 }
 stages { stage('checkout') { steps { script {
 git branch: env.TAG,
 credentialsId: env.GIT_CREDENTIAL_ID,
 url: env.GIT_URL
 sh 'touch /tmp/never-run-by-inventory'
 } } } }
 }`;
 const r=await fixture({jobs:{inline:flow(script)}}).run(),j=r.jobs[0];assert.equal(j.status,'attention');assert.deepEqual(j.scmCandidates,[{repository:'git@gitlab.nisco.cn:YanTaiHuaXin-xxh/wl-ui.git',credentialId:'Gitlab',branches:[],dynamicBranch:'TAG'}]);assert.ok(j.discoveryGaps.some(g=>g.code==='inline-candidate-unapproved'));assert.doesNotMatch(JSON.stringify(r),/touch|never-run|stages/);
});

test('内联git字面分支可识别，注释和字符串内假检出不被当成代码',async()=>{
 const script=String.raw`// git branch: 'prd', url: 'https://attacker.invalid/a.git'
 /* environment { GIT_URL = 'https://attacker.invalid/b.git' } */
 def text = "git branch: 'main', url: 'https://attacker.invalid/c.git'"
 def regexp = /git branch: 'main', url: 'https:\/\/attacker.invalid\/d.git'/
 git(branch: 'test', credentialsId: 'Gitlab', url: 'https://gitlab.example.invalid/a.git')`;
 const j=(await fixture({jobs:{inline:flow(script)}}).run()).jobs[0];assert.deepEqual(j.scmCandidates,[{repository:'https://gitlab.example.invalid/a.git',credentialId:'Gitlab',branches:['test']}]);assert.doesNotMatch(JSON.stringify(j),/attacker/);
});

test('插值/函数/拼接/重复环境值/复杂参数不会被猜成仓库或分支',async()=>{
 const scripts=[
 `git branch: chooseBranch(), url: 'https://gitlab.example.invalid/a.git'`,
 `git branch: 'test', url: "https://gitlab.example.invalid/\${env.PROJECT}.git"`,
 `environment {\n GIT_URL = 'https://gitlab.example.invalid/a.git' + suffix\n}\ngit branch: 'test', url: env.GIT_URL`,
 `environment {\n GIT_URL = 'https://gitlab.example.invalid/a.git'\n GIT_URL = 'https://gitlab.example.invalid/b.git'\n}\ngit branch: 'test', url: env.GIT_URL`,
 `git branch: params.BRANCH, url: 'https://gitlab.example.invalid/a.git'`,
 `git branch: env.TAG ?: 'test', url: 'https://gitlab.example.invalid/a.git'`,
  `git branch: '', url: 'https://gitlab.example.invalid/a.git'`,
 ];
 for(const script of scripts){const j=(await fixture({jobs:{invalid:flow(script)}}).run()).jobs[0];assert.equal(j.status,'attention');assert.deepEqual(j.scmCandidates,[]);assert.ok(j.discoveryGaps.length);}
});

test('URL中账号/密码、动态URL与多仓库歧义均保留缺口，不泄漏秘密',async()=>{
 const samples=[git('https://user:topsecret@gitlab.example.invalid/a.git'),git('https://bearer@gitlab.example.invalid/a.git'),git('https://gitlab.example.invalid/${PROJECT}.git'),git().replace('</userRemoteConfigs>','<hudson.plugins.git.UserRemoteConfig><url>https://gitlab.example.invalid/second.git</url></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>')];
 for(const sample of samples){const r=await fixture({jobs:{invalid:`<project>${sample}</project>`}}).run();assert.equal(r.status,'attention');assert.deepEqual(r.jobs[0].scmCandidates,[]);assert.doesNotMatch(JSON.stringify(r),/topsecret|bearer@|\$\{PROJECT\}|second\.git/);}
 const r=await fixture({jobs:{ambiguous:`<project>${git()}${git('https://gitlab.example.invalid/other.git')}</project>`}}).run();assert.deepEqual(r.jobs[0].scmCandidates,[]);assert.ok(r.jobs[0].discoveryGaps.some(g=>g.code==='ambiguous-repository'));
});

test('中文Folder递归、重复根去重，文件夹深度预算明确报不完整',async()=>{
 const lists={'':[{name:'生产',_class:'com.cloudbees.hudson.plugins.folder.Folder'}],'生产':[{name:'前端',_class:'org.jenkinsci.plugins.workflow.job.WorkflowJob'},{name:'更深',_class:'com.cloudbees.hudson.plugins.folder.Folder'}],'生产/更深':[{name:'后端',_class:'org.jenkinsci.plugins.workflow.job.WorkflowJob'}]},jobs={'生产/前端':`<project>${git()}</project>`,'生产/更深/后端':`<project>${git()}</project>`};
 const f=fixture({jobs,lists}),r=await f.run({roots:['','生产'],maxDepth:8,maxJobs:20});assert.equal(r.status,'inventoried');assert.deepEqual(r.jobs.map(j=>j.job),['生产/前端','生产/更深/后端']);assert.equal(f.calls.filter(c=>new URL(c.url).pathname==='/job/'+encodeURIComponent('生产')+'/api/json').length,1);
 const limited=await fixture({jobs,lists}).run({maxDepth:1});assert.equal(limited.status,'attention');assert.ok(limited.errors.some(e=>e.code==='depth-budget-exceeded'));assert.equal(limited.jobs.length,1);
});

test('数量预算、非法任务、列表403和任务404各自可追溯，其他任务继续',async()=>{
 const jobs={ok:`<project>${git()}</project>`},lists={'':[{name:'ok',_class:'hudson.model.FreeStyleProject'},{name:'gone',_class:'hudson.model.FreeStyleProject'},{name:'denied',_class:'hudson.model.FreeStyleProject'},{name:'bad/name',_class:'hudson.model.FreeStyleProject'},{name:'folder',_class:'com.cloudbees.hudson.plugins.folder.Folder'}]},fail={'denied:config.xml':403,'folder:api/json':403};
 const r=await fixture({jobs,lists,fail}).run();assert.equal(r.status,'attention');assert.equal(r.jobs.find(j=>j.job==='ok').status,'read');assert.match(r.jobs.find(j=>j.job==='gone').discoveryGaps[0].message,/404/);assert.match(r.jobs.find(j=>j.job==='denied').discoveryGaps[0].message,/403/);assert.ok(r.errors.some(e=>e.code==='invalid-job'));assert.ok(r.errors.some(e=>e.code==='root-unreadable'&&/403/.test(e.reason)));
 const limited=await fixture({jobs,lists}).run({maxJobs:1});assert.equal(limited.jobs.length,1);assert.ok(limited.errors.some(e=>e.code==='job-budget-exceeded'));
});

test('畸形/DTD XML保持不可读；无SCM标未知而非默认批准',async()=>{
 for(const xml of ['<project>','<!DOCTYPE x><project/>','<project/>']){const j=(await fixture({jobs:{unknown:xml}}).run()).jobs[0];assert.notEqual(j.status,'read');assert.deepEqual(j.scmCandidates,[]);assert.ok(j.discoveryGaps.length);}
});

test('输入与凭据预检在发送请求前失败，不调用写API',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;throw Error('must not call');};
 for(const inventory of [{maxJobs:0},{maxDepth:20},{roots:['../escape']},{roots:[]},{unknown:true}])await assert.rejects(discoverJenkinsJobs({jenkinsOrigin:origin,inventory,env,fetchImpl}));
 await assert.rejects(discoverJenkinsJobs({jenkinsOrigin:origin,env:{},fetchImpl}),/凭据|账号/);await assert.rejects(discoverJenkinsJobs({jenkinsOrigin:'https://reader:secret@jenkins.example.invalid',env,fetchImpl}));assert.equal(calls,0);
});
