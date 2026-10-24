import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import path from 'node:path';import{tmpdir}from'node:os';import{spawnSync}from'node:child_process';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';
import {failureDiagnostic,recordJenkinsFailure,diagnosticText,pipelineDiagnostics} from '../../lib/notification-diagnostics.js';
import {pipelineCheckNotification} from '../../lib/pipeline-notification.js';
const root=fileURLToPath(new URL('../../',import.meta.url)),python=readFileSync(path.join(root,'templates/ci/jenkins-bootstrap.py'),'utf8');
const env={JOB_NAME:'produce/CHECK',BUILD_NUMBER:'19',JENKINS_URL:'https://jenkins.example.invalid/',BUILD_URL:'https://jenkins.example.invalid/job/produce/job/CHECK/19/',WL_GATE_PHASE:'正式Review与严格准入'};
function fixture(t){const dir=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-diagnostic-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function card(cwd,extra={}){const e={...env,...extra};const r=spawnSync('python3',['-c',`import types,json\nm=types.ModuleType('bootstrap')\nexec(${JSON.stringify(python)},m.__dict__)\nprint(json.dumps(m.card({'checks':[]},${JSON.stringify(e)}),ensure_ascii=False))`],{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
for(const [reason,category] of [['quality/workspace.json缺失','project-integration'],['缺少本地Hook回执，未核验','local-evidence'],['正式Review授权已过期','review'],['SHA与当前候选不一致','source'],['SCM请求403','access'],['固定npm依赖准备失败','dependencies'],['JUnit测试结果缺失','tests'],['CHECK原始报告缺失','scan'],['Node版本不符合要求','environment']])test(`失败原因分类：${category}`,()=>{const d=failureDiagnostic(reason);assert.equal(d.category,category);assert(d.action);assert(d.reason.includes(reason));});
test('缺本地回执不能把--no-verify当事实；错误文字去秘密及带凭据URL',()=>{
 const d=failureDiagnostic('本地Hook回执缺失');assert.match(d.action,/不能证明/);
 const text=diagnosticText('password=xyz https://u:p@host/path?token=q npm_ABCDEFG12345 Bearer ABCDEF secret=SENTINEL',{TEST_SECRET:'SENTINEL'});
 for(const value of ['xyz','u:p','token=q','ABCDEFG12345','ABCDEF','SENTINEL'])assert(!text.includes(value),text);
});
test('真实CLI异常留存实际原因，Python后置卡读取同一Job/build；双@及同人同步',t=>{
 const cwd=fixture(t),config=path.join(cwd,'central');mkdirSync(config);const people={dev:{name:'执行甲',feishu:{idType:'user_id',id:'dev_id',verified:true}},lead:{name:'经理乙',feishu:{idType:'user_id',id:'lead_id',verified:true}},observer:{name:'同步丙',feishu:{idType:'user_id',id:'observer_id',verified:true}}};
 const configFile=path.join(config,'jenkins-ops.json');const c={schemaVersion:1,kind:'wl-quality-jenkins-ops',jobMappings:{[env.JOB_NAME]:{project:'produce'}},people,owners:{produce:{executor:'dev',technicalManager:'lead',managerSubmissionNotify:'observer'}}};writeFileSync(configFile,JSON.stringify(c));
 const r=spawnSync(process.execPath,[path.join(root,'bin/wl-skills-gate.js'),'jenkins','inspect','--registry',path.join(cwd,'..',path.basename(cwd)+'-not-present.json')],{cwd,env:{...process.env,...env},encoding:'utf8'});assert.equal(r.status,2,r.stderr);
 const original=JSON.parse(readFileSync(path.join(cwd,'quality-reports/ci-integration/failure-19.json')));assert.match(original.diagnostics[0].reason,/not-present|ENOENT|不存在/);
 const result=card(cwd,{WL_GATE_FAILURE_CONFIG_DIR:config}),text=JSON.stringify(result);assert(text.includes(original.diagnostics[0].reason));assert(text.includes('<at id=\\"dev_id\\"></at>'));assert(text.includes('<at id=\\"lead_id\\"></at>'));assert(!text.includes('具体原因见 Jenkins 控制台'));
 c.owners.produce.executor='lead';writeFileSync(configFile,JSON.stringify(c));const same=JSON.stringify(card(cwd,{WL_GATE_FAILURE_CONFIG_DIR:config}));assert.equal((same.match(/<at id=\\"lead_id\\">/g)||[]).length,1);assert(same.includes('observer_id'));
 delete c.people.lead.feishu;writeFileSync(configFile,JSON.stringify(c));assert.match(JSON.stringify(card(cwd,{WL_GATE_FAILURE_CONFIG_DIR:config})),/责任人提醒未完成/);
});
test('旧运行、错Job及符号链接的诊断不能冒充本轮具体失败',t=>{
 const cwd=fixture(t);recordJenkinsFailure('独有旧原因',{env,root:cwd});const file=path.join(cwd,'quality-reports/ci-integration/failure-19.json'),v=JSON.parse(readFileSync(file));
 for(const change of [{job:'other'},{buildNumber:'20'},{createdAt:'2000-01-01T00:00:00Z'}]){writeFileSync(file,JSON.stringify({...v,...change}));const text=JSON.stringify(card(cwd));assert(!text.includes('独有旧原因'));assert.match(text,/失败原因记录缺失/);}
 rmSync(file);const outside=path.join(cwd,'external.json');writeFileSync(outside,JSON.stringify(v));symlinkSync(outside,file);assert(!JSON.stringify(card(cwd)).includes('独有旧原因'));assert.equal(recordJenkinsFailure('new',{env,root:cwd}),false);
});
test('实际批准构建脚本失败，退出码和原始错误进入新卡而不是一句笼统失败',t=>{
 const dir=fixture(t),cwd=path.join(dir,'project');mkdirSync(cwd);const script=path.join(dir,'approved.sh'),source='echo "TypeScript error src/Order.ts:8: Type mismatch" >&2\nexit 7\n';writeFileSync(script,source);
 const r=spawnSync(process.execPath,[path.join(root,'templates/ci/run-approved-build.mjs'),script,createHash('sha256').update(source).digest('hex')],{cwd,env:{...process.env,...env,WL_GATE_PHASE:'批准业务构建'},encoding:'utf8'});assert.equal(r.status,7,r.stderr);assert.match(r.stderr,/TypeScript error/);
 const text=JSON.stringify(card(cwd));assert.match(text,/退出7/);assert.match(text,/src\/Order.ts:8/);assert.match(text,/批准业务构建/);
});
test('真实检查失效和质量发现分开呈现：九维定位、彩色四级、前三问题、双@',()=>{
 const summary={run:{project:'p',stage:'ci',startedAt:'2026-10-24T01:00:00Z',trace:{branch:'sit'}},decision:{status:'invalid',reasons:['依赖扫描无法连接内网源']},checks:[{checkId:'DEPS',status:'invalid',reason:'ENOTFOUND registry.internal'}],findings:['blocker','error','warning','info'].map((severity,i)=>({severity,dimension:i===2?'tests':'coding',file:'src/Order.java',line:i+1,ruleId:'R/'+i,message:'风险'+i}))};
 const value=pipelineCheckNotification({summary,presentation:{submitterId:'dev',reportUrl:'https://reports.example.invalid/1'}},{projects:{p:{technicalManager:'lead'}},people:{dev:{name:'甲',feishu:{idType:'user_id',id:'dev_id'}},lead:{name:'乙',feishu:{idType:'user_id',id:'lead_id'}}}});
 const text=JSON.stringify(value.payload);for(const content of ['极高 1','严重 1','警告 1','提示 1','编码规范','测试规范','ENOTFOUND','检查失效','另有 1 项问题','dev_id','lead_id'])assert(text.includes(content),content);
 assert.equal(pipelineDiagnostics(summary).length,2);assert.equal(value.payload.card.header.template,'red');
});
