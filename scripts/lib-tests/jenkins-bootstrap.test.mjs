import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {renderJenkinsMaintenance} from '../../lib/jenkins-bootstrap.js';
import {GATE_VERSION,gateRuntimeHash,renderJenkinsEntry} from '../../lib/jenkins-integration.js';
const base=fileURLToPath(new URL('../../',import.meta.url)),python=readFileSync(new URL('../../templates/ci/jenkins-bootstrap.py',import.meta.url),'utf8');
const invoke=(code,env={})=>spawnSync('python3',['-c',`import types\nm=types.ModuleType('bootstrap')\nexec(${JSON.stringify(python)},m.__dict__)\n${code}`],{encoding:'utf8',env:{...process.env,...env}});
test('所有交付入口内嵌同源自检和失败通知；无Gate时不依赖load或node；签名凭据仅在post绑定',()=>{
 const cfg={gateRoot:'/opt/wl-quality/gate-validation/node_modules/@agile-team/wl-skills-gate',agentLabel:'existing-node'};
 const entries=[renderJenkinsEntry(cfg,'/srv/wl-quality/config/bindings.json'),...['node','verify','review','automation','fleet'].map(mode=>renderJenkinsMaintenance({...cfg,mode}))];
 for(const entry of entries){
  assert.doesNotMatch(entry,/__WL_|jenkins post-verify|bash \$?\{?approve/mi);
  assert.match(entry,/unsuccessful \{ script \{ wlGateFailureNotice\(\) \} \}/);
  assert.match(entry,/python3 - <<'WL_GATE_BOOTSTRAP_PY'/);assert.match(entry,/节点环境自检/);
  assert.match(entry,/PATH\+WLGATE=/);assert.match(entry,/skipDefaultCheckout\(true\)/);
  const embedded=entry.split("python3 - <<'WL_GATE_BOOTSTRAP_PY'\n")[1].split('\nWL_GATE_BOOTSTRAP_PY')[0]+'\n';assert.equal(embedded.replaceAll('\\\\','\\'),python);
 }
 assert.match(entries[0],/stage\('节点环境自检'\)[\s\S]*stage\('Gate'\)/);
 assert.doesNotMatch(entries[2],/triggers\s*\{/);assert.doesNotMatch(entries[3],/triggers\s*\{/);assert.doesNotMatch(entries[4],/triggers\s*\{/);
 assert.throws(()=>renderJenkinsMaintenance({...cfg,mode:'verify',gateRoot:"/tmp/a'bad"}));
});
test('节点版本判断与实际Python子进程：Node缺失、旧Node、缺Gate、缺登记明确阻断且不伪造质量通过',()=>{
 const r=invoke(`import json\nassert m.version_ok('v22.13.0')\nassert m.version_ok('v24.1.0')\nassert not m.version_ok('v22.12.0')\nassert not m.version_ok('v23.10.0')\nassert not m.version_ok('v20.19.0')\nm.shutil.which=lambda name: None\nr=m.preflight({'WL_BOOTSTRAP_GATE_ROOT':'/no-gate-on-this-node','WL_BOOTSTRAP_MODE':'job'})\nassert r['status']=='blocked' and not r['qualityPassed'] and not r['buildAuthorized']\nassert any(c['name']=='node' and c['status']=='blocked' for c in r['checks'])\nassert any(c['name']=='registry' and c['status']=='blocked' for c in r['checks'])\nprint(json.dumps(r))`);assert.equal(r.status,0,r.stderr);
 assert.doesNotMatch(r.stdout,/Gate核验通过|签发完成/);
});
test('真实文件环境自检通过；已配置Node路径生效，缺中央配置阻断；不需要npm第三方库',t=>{
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-bootstrap-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const gate=path.join(root,'gate');mkdirSync(path.join(gate,'bin'),{recursive:true});mkdirSync(path.join(gate,'templates/ci'),{recursive:true});
 writeFileSync(path.join(gate,'package.json'),JSON.stringify({name:'@agile-team/wl-skills-gate',version:GATE_VERSION}));for(const f of ['bin/wl-skills-gate.js','templates/ci/jenkins-gate.groovy'])writeFileSync(path.join(gate,f),'fixture');
 const r=invoke(`import json\nm.execute_version=lambda program:'v24.3.0'\nr=m.preflight({'WL_BOOTSTRAP_GATE_ROOT':${JSON.stringify(gate)},'WL_BOOTSTRAP_MODE':'node'})\nassert r['status']=='ready' and not r['qualityPassed']\nr=m.preflight({'WL_BOOTSTRAP_GATE_ROOT':${JSON.stringify(gate)},'WL_BOOTSTRAP_MODE':'automation'})\nassert r['status']=='blocked'\nassert any(c['name']=='automation-config' and c['status']=='blocked' for c in r['checks'])\nprint('passed')`);assert.equal(r.status,0,r.stderr);
});
test('真实生成通知请求：Feishu签名正确、收到code0才确认，失败/超时/跳转不假报、不自动重发、不泄露凭据',()=>{
 const r=invoke(`import io,json,urllib.error,base64,hmac,hashlib\nenv={'WL_FEISHU_CI_WEBHOOK':'https://open.feishu.cn/open-apis/bot/v2/hook/mock-not-real','WL_FEISHU_CI_SECRET':'secret-fixture','JOB_NAME':'produce/CHECK','BUILD_NUMBER':'7','BUILD_URL':'https://jenkins.example.invalid/job/produce/job/CHECK/7/'}\nreport={'checks':[{'name':'node','status':'blocked','detail':'版本过旧'}]}\nclass Response:\n status=200\n def __init__(self,data):self.data=data\n def __enter__(self):return self\n def __exit__(self,*args):pass\n def read(self,n):return self.data\nclass Client:\n def __init__(self,data=b'{"code":0}',error=None):self.data=data;self.error=error;self.calls=0\n def open(self,request,timeout):\n  self.calls+=1\n  if self.error:raise self.error\n  payload=json.loads(request.data)\n  expected=base64.b64encode(hmac.new(b'123\\nsecret-fixture',b'',hashlib.sha256).digest()).decode()\n  assert payload['sign']==expected and payload['timestamp']=='123'\n  assert 'secret-fixture' not in json.dumps(payload)\n  return Response(self.data)\nclient=Client()\nr=m.notify(report,env,client,123);assert r['status']=='sent' and client.calls==1\nclient=Client(b'{"code":19021}')\nassert m.notify(report,env,client,123)['status']=='rejected'\nclient=Client(error=TimeoutError('private-token-should-not-leak'))\nr=m.notify(report,env,client,123);assert r['status']=='unknown' and client.calls==1\nassert 'private-token' not in json.dumps(r)\nclient=Client(error=urllib.error.HTTPError('https://internal-secret',302,'redirect',None,None))\nassert m.notify(report,env,client,123)['status']=='rejected'\nassert m.NoRedirect().redirect_request(None,None,302,'',{},'https://other.invalid') is None\nassert m.notify(report,{})['status']=='not-sent'\nprint('passed')`);assert.equal(r.status,0,r.stderr);
});
test('真实执行独立节点自检CLI：Gate缺失仍归档本次失败；未配置通知凭据返回3，保留原始失败',t=>{
 const cwd=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-bootstrap-cli-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const env={...process.env,WL_BOOTSTRAP_GATE_ROOT:'/not-installed/gate',WL_BOOTSTRAP_MODE:'node',BUILD_NUMBER:'16'};
 let r=spawnSync('python3',[path.join(base,'templates/ci/jenkins-bootstrap.py')],{cwd,env,encoding:'utf8'});assert.equal(r.status,2,r.stderr);
 const report=JSON.parse(readFileSync(path.join(cwd,'.wl-gate-bootstrap/16-preflight.json')));assert.equal(report.buildNumber,'16');assert.equal(report.status,'blocked');
 r=spawnSync('python3',[path.join(base,'templates/ci/jenkins-bootstrap.py')],{cwd,env:{...env,WL_BOOTSTRAP_ACTION:'notify',WL_FEISHU_CI_WEBHOOK:'',WL_FEISHU_CI_SECRET:''},encoding:'utf8'});assert.equal(r.status,3);
 const receipt=JSON.parse(readFileSync(path.join(cwd,'.wl-gate-bootstrap/16-notice.json')));assert.equal(receipt.status,'not-sent');assert.equal(receipt.originalFailurePreserved,true);
});
test('中央调度明确绑定四项机器人凭据，变量与实际治理配置逐项一致；源码作业不绑定项目机器人',()=>{
 const entry=renderJenkinsMaintenance({mode:'automation'});
 const governance=JSON.parse(readFileSync(new URL('../../templates/platform/governance-config.json',import.meta.url)));
 for(const [channel,prefix] of [['ci','ci'],['project','project']]) {
  assert.ok(entry.includes(`credentialsId: 'wl-feishu-${prefix}-webhook', variable: '${governance.channels[channel].webhookEnv}'`));
  assert.ok(entry.includes(`credentialsId: 'wl-feishu-${prefix}-signing-secret', variable: '${governance.channels[channel].signingSecretEnv}'`));
 }
 const business=renderJenkinsEntry({gateRoot:'/opt/gate',agentLabel:'existing-node'},'/srv/wl/config.json');
 assert.doesNotMatch(business,/wl-feishu-project-webhook|WL_FEISHU_CI_SIGNING_SECRET/);
 assert.ok(entry.indexOf("stage('节点环境自检')")<entry.indexOf("stage('采集、对账与通知')"));
});
test('连通测试卡片明确标识测试，不包含阻断结论或伪造检查通过；测试失败不重复通知',()=>{
 const result=invoke(`r=m.card({}, {'WL_BOOTSTRAP_ACTION':'notify-test','JOB_NAME':'notification-test','BUILD_NUMBER':'8'})\nassert r['card']['header']['template']=='blue'\nassert '连通测试' in r['card']['header']['title']['content']\nassert '不表示质量通过' in str(r)\nassert '结论：本次执行失败' not in str(r)\nprint('passed')`);assert.equal(result.status,0,result.stderr);
 const entry=renderJenkinsMaintenance({mode:'node'});assert.match(entry,/booleanParam\(name: 'TEST_NOTIFICATION', defaultValue: false/);assert.match(entry,/if \(env.WL_GATE_NOTIFICATION_TEST == 'true'\)/);
});

test('公共机器人连通卡用业务可读的来源名称，技术Job名不冒充项目',()=>{
 const result=invoke(`import json\nenv={'WL_BOOTSTRAP_ACTION':'notify-test','JOB_NAME':'wl-quality-doctor','BUILD_NUMBER':'104'}\nr=m.card({},env)\ns=json.dumps(r,ensure_ascii=False)\nassert '测试来源：公共巡检 · 第104次' in s\nassert 'wl-quality-doctor' not in s\nassert '项目：' not in s\nassert '不表示质量通过' in s\nenv['JOB_NAME']='team/real-test-job'\ns=json.dumps(m.card({},env),ensure_ascii=False)\nassert 'team/real-test-job' in s\nprint('passed')`);
 assert.equal(result.status,0,result.stderr);
});

test('批量维护入口仅归档公开摘要和本人批准记录，缺批准不写；凭据不传项目',()=>{
 const entry=renderJenkinsMaintenance({mode:'fleet',configDir:'/srv/config',agentLabel:'central-node'});
 assert.match(entry,/jenkins fleet/);assert.match(entry,/jenkins-fleet.json/);
 assert.match(entry,/submitter: preview.approvers.join/);assert.match(entry,/submitterParameter: 'APPROVED_BY'/);
 assert.match(entry,/wl-jenkins-config-manager/);assert.match(entry,/wl-gitlab-hooks-token/);
 assert.doesNotMatch(entry,/checkout\(|private-plan.json|archiveArtifacts artifacts:.*srv|triggers\s*\{/);
});

test('自检目录及文件的符号链接不会读取/覆盖外部内容或触发通知',t=>{
 const cwd=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-bootstrap-link-')),outside=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-bootstrap-external-'));t.after(()=>{rmSync(cwd,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});});
 const text='external-must-stay';writeFileSync(path.join(outside,'16-preflight.json'),text);symlinkSync(outside,path.join(cwd,'.wl-gate-bootstrap'));
 const result=spawnSync('python3',[path.join(base,'templates/ci/jenkins-bootstrap.py')],{cwd,env:{...process.env,BUILD_NUMBER:'16',WL_BOOTSTRAP_ACTION:'notify'},encoding:'utf8'});assert.equal(result.status,2);assert.equal(readFileSync(path.join(outside,'16-preflight.json'),'utf8'),text);assert.match(result.stdout,/不写入/);
});

test('执行节点用独立Python核对完整包字节，漂移先于加载脚本被阻断',()=>{
 const expected=gateRuntimeHash();const result=invoke(`env={'WL_BOOTSTRAP_MODE':'node','WL_BOOTSTRAP_GATE_ROOT':${JSON.stringify(base)},'WL_BOOTSTRAP_RUNTIME_HASH':${JSON.stringify(expected)}}\nr=m.preflight(env)\nassert r['status']=='ready',r\nenv['WL_BOOTSTRAP_RUNTIME_HASH']='0'*64\nr=m.preflight(env)\nassert r['status']=='blocked' and any(c['name']=='gate-runtime' and c['status']=='blocked' for c in r['checks'])\nprint('passed')`);assert.equal(result.status,0,result.stderr);
});

test('中央任务绑定机器人、真实采集、责任人来源、续建和身份预检凭据；与项目源码执行隔离',()=>{
 const native=readFileSync(new URL('../../templates/ci/jenkins-native.groovy',import.meta.url),'utf8');const legacy=renderJenkinsMaintenance({mode:'automation'});const vars=['WL_FEISHU_CI_WEBHOOK','WL_FEISHU_CI_SECRET','WL_FEISHU_PROJECT_WEBHOOK','WL_FEISHU_PROJECT_SECRET','WL_JENKINS_READ_USER','WL_JENKINS_READ_TOKEN','WL_GITLAB_READ_TOKEN','WL_JENKINS_BUILD_USER','WL_JENKINS_BUILD_TOKEN','WL_SSO_CLIENT_SECRET'];
 const central=native.split("} else if (cfg.role == 'automation') {")[1].split("} else if (cfg.role == 'fleet')")[0];for(const name of vars){assert(central.includes("'"+name+"'"),name);assert(legacy.includes("'"+name+"'"),name);}
 assert.doesNotMatch(central,/wl-review-signing-key|WL_REVIEW_PRIVATE_KEY_FILE|checkout\(/);assert.doesNotMatch(readFileSync(new URL('../../templates/ci/jenkins-gate.groovy',import.meta.url),'utf8'),/WL_JENKINS_BUILD_TOKEN|WL_SSO_CLIENT_SECRET|WL_FEISHU_PROJECT_SECRET/);
});
