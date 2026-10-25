import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';

// These are boundaries of the package-owned Jenkins adapter, not a claim that a
// text inspection validates Jenkins CPS or the site's credential permissions.
const native = () => readFileSync(new URL('../../templates/ci/jenkins-native.groovy', import.meta.url), 'utf8');

function endOfBlock(text, open) {
  let depth = 1, quote = null;
  for (let i = open + 1; i < text.length; i++) {
    if (quote) {
      if (text[i] === '\\') { i++; continue; }
      if (text.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
      continue;
    }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); assert.notEqual(end, -1, 'unterminated Groovy comment'); i = end + 1; continue; }
    for (const delimiter of ["'''", '"""', "'", '"']) {
      if (text.startsWith(delimiter, i)) { quote = delimiter; i += delimiter.length - 1; break; }
    }
    if (quote) continue;
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return i;
  }
  throw Error('unterminated Groovy block');
}

function opsMethod(source, name = 'wlOpsRun') {
  const header = new RegExp('\\bdef\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(source);
  assert(header, 'doctor must have the package-owned ' + name + ' adapter');
  const open = header.index + header[0].lastIndexOf('{');
  return source.slice(open + 1, endOfBlock(source, open));
}

function credentialBlocks(source) {
  const scopes = [];
  for (const match of source.matchAll(/\bwithCredentials\s*\(/g)) {
    const open = source.indexOf('{', match.index);
    assert(open >= 0, 'credential binding must have an explicit closure');
    const end = endOfBlock(source, open);
    scopes.push({declaration: source.slice(match.index, open), body: source.slice(open + 1, end)});
  }
  return scopes;
}

test('运维监督无需项目登记即可先盘点，检查与通知为三个独立动作', () => {
  const helper = opsMethod(native());
  const inventory = helper.indexOf('jenkins ops inventory');
  const inspect = helper.indexOf('jenkins ops inspect');
  const finish = helper.indexOf('jenkins ops finish');
  assert(inventory >= 0 && inspect > inventory && finish > inspect, 'inventory → inspect → finish must be explicit');
  assert.match(helper, /--cluster/);
  assert.match(helper, /--target/);
  assert.match(helper, /--inventory/);
  assert.match(helper, /--results/);
  assert.doesNotMatch(helper, /jenkins fleet (?:inventory|plan|apply)|jenkins (?:bind|plan)|review-publish|jenkins (?:admit|build)/,
    'ops supervision must not require the project registry or silently authorize a build/review');
});

test('源码检出和项目接入检查不持有Jenkins接口、飞书或签发凭据', () => {
  const helper = opsMethod(native());
  const scopes = credentialBlocks(helper);
  assert(scopes.length >= 2, 'read credentials and notice credentials must be separately scoped');
  for (const scope of scopes) {
    assert.doesNotMatch(scope.body, /\bcheckout\s*\(|jenkins ops inspect/,
      'SCM checkout/inspection must happen outside API and bot credential closures');
    assert.doesNotMatch(scope.declaration, /wl-jenkins-config-manager|wl-jenkins-build-dispatch|wl-review-signing-key|wl-quality-sso-client-secret/,
      'read-only supervision cannot obtain write, dispatch, signing or SSO credentials');
  }
  const reader = scopes.find(scope => scope.body.includes('jenkins ops inventory'));
  const notifier = scopes.find(scope => scope.body.includes('jenkins ops notify'));
  assert(reader, 'inventory must use a scoped Jenkins read credential');
  assert(notifier, 'finish must use a scoped CI bot credential');
  assert.match(reader.declaration, /wl-jenkins-ci-readonly/);
  assert.doesNotMatch(reader.declaration, /feishu/);
  assert.match(notifier.declaration, /wl-feishu-ci-webhook/);
  assert.match(notifier.declaration, /wl-feishu-ci-signing-secret/);
  assert.doesNotMatch(notifier.declaration, /wl-feishu-project/);assert.match(notifier.declaration,/wl-jenkins-ci-readonly/);
});

test('项目检查失败仍进入汇总，运维报告归档且不启动旧部署任务', () => {
  const helper = opsMethod(native());
  assert.match(helper, /\btry\s*\{/);
  assert.match(helper, /\bfinally\s*\{/,
    'inspection failures need a finally path for the aggregate report/notice');
  assert.match(helper, /archiveArtifacts/);
  assert.match(helper, /returnStatus\s*:\s*true/,
    'a missing project prerequisite must be recorded before ending the monitoring run');
  assert.doesNotMatch(helper, /\bbuild\s*\(|\/buildWithParameters|\/build[?'"`\s]|createItem|config\.xml/,
    'supervision does not rewrite or execute discovered custom deployment jobs');
});

test('默认doctor执行监督，机器人测试仅走显式连通测试', () => {
  const source = native();
  assert.match(source, /cfg\.role\s*==\s*['"]node['"]/);
  assert.match(source, /params\.TEST_NOTIFICATION/);
  const call = source.lastIndexOf('wlOpsRun(cfg)');
  assert(call > source.indexOf('def call('), 'node routing must invoke the ops adapter by default');
  assert.match(source, /wlGateNotificationTest\(\)/);
});

test('承接仅启动持久claim给出的CHECK，启动后记录实际编号，未持有通知或签发凭据', () => {
  const helper = opsMethod(native(), 'wlOpsContinue');
  const claim = helper.indexOf('jenkins ops claim-check'), build = helper.indexOf('build('), ack = helper.indexOf('jenkins ops ack-check');
  assert(claim >= 0 && build > claim && ack > build, 'durable claim → actual CHECK start → actual number acknowledgment');
  assert.match(helper, /claim\.status\s*==\s*['"]claimed['"]/);
  assert.match(helper, /build\(job:\s*claim\.job/);
  assert.match(helper, /waitForStart:\s*true/);
  assert.match(helper, /--build-number/);
  assert.match(helper, /--dispatch-id/);
  assert.match(helper, /started\.number/);
  assert.match(helper, /name:\s*['"]WL_REVIEW_SHA['"],\s*value:\s*claim\.sha/);
  assert.match(helper, /name:\s*['"]WL_GATE_DISPATCH_ID['"],\s*value:\s*claim\.dispatchId/);
  for (const scope of credentialBlocks(helper)) {
    assert.doesNotMatch(scope.declaration, /feishu|signing-key|build-dispatch|config-manager|sso-client-secret/);
    assert.doesNotMatch(scope.body, /\bbuild\s*\(/, 'Jenkins interface credentials must end before the child CHECK starts');
  }
  assert.doesNotMatch(helper, /review-publish|jenkins (?:admit|build)|\/buildWithParameters/);
  assert.match(helper, /archiveArtifacts/);
  assert.match(opsMethod(native()), /wlOpsContinue\(cfg,\s*summary\)/);
});

test('人工终止不继续检出，通知凭据失败仍保留无发送汇总与归档', () => {
  const helper = opsMethod(native());
  assert.match(helper, /catch\s*\(org\.jenkinsci\.plugins\.workflow\.steps\.FlowInterruptedException interrupted\)\s*\{\s*throw interrupted\s*\}/);
  assert.match(helper, /finally\s*\{\s*deleteDir\(\)\s*\}/);
  const finishes = helper.split('\n').filter(command => /\bjenkins ops finish\b/.test(command));
  assert.match(helper,/jenkins ops notify[\s\S]*--send/,'configured bot must notify only after archive');
  assert(finishes.some(command => !/--send\b/.test(command)), 'missing credential path must still generate a non-sending summary');
  assert.match(helper, /finally\s*\{\s*archiveArtifacts/);
});

test('原生Groovy执行监督与承接：凭据隔离、固定SHA、失败不漏档且继续其它项目', {skip: !process.env.WL_GROOVY_JAR}, t => {
  const jar = process.env.WL_GROOVY_JAR;
  assert(existsSync(jar), 'WL_GROOVY_JAR must point to an existing Groovy runtime');
  const directory = mkdtempSync(path.join(tmpdir(), 'wl-ops-groovy-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const harness = path.join(directory, 'ops.groovy');
  writeFileSync(harness, String.raw`
def loader = new GroovyClassLoader()
def interruptedClass = loader.parseClass('package org.jenkinsci.plugins.workflow.steps; class FlowInterruptedException extends Exception { FlowInterruptedException(String message) { super(message) } }')
def parser = loader.parseClass('package groovy.json; class JsonSlurperClassic { static Map values=[:]; def parseText(String text) { assert values.containsKey(text):text; return values[text] } }')
def source = new File(args[0]).text
for (def mode in ['normal', 'no-bot', 'interrupted', 'claim-failure', 'claim-missing', 'claim-unknown', 'already-started', 'ack-failure']) {
  def events=[], files=[:], env=[:], currentBuild=[:], working=[], credentials=0, builds=0, cleanups=0, startedKeys=[], acknowledgedKeys=[]
  def multi=mode in ['claim-failure', 'claim-missing', 'claim-unknown', 'ack-failure']
  def inventory=[runId:'fixture-run', jobsDiscovered:2, targets:[[key:'a'*24, checkoutAllowed:true, branch:'test', repository:'https://gitlab.example.invalid/group/produce.git', credentialId:'scm'],[key:'b'*24, checkoutAllowed:false, branch:null]]]
  def summary=[status:'ready', runId:'fixture-run', globalGaps:(mode in ['no-bot','interrupted'] ? [[id:'pending']] : []), projects:[[key:'a'*24, status:'ready', checkJob:'produce/CHECK']]]
  if(multi){inventory.targets[1]=[key:'b'*24,checkoutAllowed:true,branch:'test',repository:'https://gitlab.example.invalid/group/produce.git',credentialId:'scm'];summary.projects<<[key:'b'*24,status:'ready',checkJob:'produce/NEXT-CHECK']}
  def claim=[status:'claimed', job:'produce/CHECK', sha:'c'*40, dispatchId:'ops-fixture-approved-check']
  def nextClaim=[status:'claimed', job:'produce/NEXT-CHECK', sha:'d'*40, dispatchId:'ops-fixture-next-check']
  parser.values=[inventory:inventory, summary:summary, claim:claim, nextClaim:nextClaim, unknown:[status:'unknown',reason:'fixture start unknown'], already:[status:'already-started',job:'produce/CHECK']]
  Binding binding=new Binding([env:env, params:[:], currentBuild:currentBuild])
  def shell=new GroovyShell(loader,binding)
  binding.setVariable('pwd',{->'/workspace'})
  binding.setVariable('dir',{location,body->working<<location;try{return body()}finally{working.remove(working.size()-1)}})
  binding.setVariable('deleteDir',{->cleanups++;events<<'cleanup'})
  binding.setVariable('writeFile',{options->files[options.file]=options.text})
  binding.setVariable('readJSON',{options->assert options.returnPojo==true;return parser.values[options.text ?: files[options.file.toString()]]})
  binding.setVariable('readFile',{location->def key=location.toString();assert files.containsKey(key):key;return files[key]})
  binding.setVariable('fileExists',{location->files.containsKey(location.toString())})
  binding.setVariable('archiveArtifacts',{options->events<<'archive'})
  binding.setVariable('stage',{name,body->events<<name;body()})
  binding.setVariable('timeout',{options,body->body()})
  binding.setVariable('echo',{message->events<<'echo'})
  binding.setVariable('withEnv',{values,body->def old=new LinkedHashMap(env);values.each{value->def pair=value.split('=',2);env[pair[0]]=pair[1]};try{return body()}finally{env.clear();env.putAll(old)}})
  ['usernamePassword','string','file'].each{name->binding.setVariable(name,{options->options})}
  binding.setVariable('withCredentials',{values,body->
    if(mode=='no-bot'&&values.any{it.credentialsId.startsWith('wl-feishu')})throw new RuntimeException('fixture missing bot credential')
    def old=new LinkedHashMap(env);credentials++
    values.each{value->if(value.variable)env[value.variable]='fixture';if(value.usernameVariable){env[value.usernameVariable]='fixture';env[value.passwordVariable]='fixture'}}
    try{return body()}finally{credentials--;env.clear();env.putAll(old)}
  })
  binding.setVariable('checkout',{options->
    assert credentials==0:'SCM checkout held API/bot credentials'
    assert options.scm.branches[0].name=='origin/test'
    assert options.scm.userRemoteConfigs[0].credentialsId=='scm'
    events<<'checkout'
    if(mode=='interrupted')throw interruptedClass.newInstance('fixture manual cancellation')
    return [GIT_COMMIT:'c'*40]
  })
  binding.setVariable('build',{options->
    assert credentials==0:'CHECK start held interface/bot credentials'
    def expected=env.WL_OPS_KEY=='a'*24?claim:nextClaim
    assert options.job==expected.job
    assert options.waitForStart==true&&options.wait==false&&options.propagate==false
    assert options.parameters.find{it.name=='WL_REVIEW_SHA'}.value==expected.sha
    assert options.parameters.find{it.name=='WL_GATE_DISPATCH_ID'}.value==expected.dispatchId
    builds++;startedKeys<<env.WL_OPS_KEY;events<<'CHECK-start';return [number:40+builds]
  })
  binding.setVariable('sh',{options->
    String command=options instanceof Map?options.script:options
    if(command.contains('jenkins ops inventory')){assert env.WL_JENKINS_READ_TOKEN;assert !env.WL_FEISHU_CI_SECRET;files['wl-ops-public/inventory.json']='inventory';events<<'inventory'}
    else if(command.contains('jenkins ops inspect')){assert credentials==0;events<<'inspect'}
    else if(command.contains('jenkins ops notify')){assert env.WL_JENKINS_READ_TOKEN&&env.WL_FEISHU_CI_SECRET;assert events.contains('archive');events<<'notify';return 0}
    else if(command.contains('jenkins ops finish')){if(command.contains('--send'))assert env.WL_FEISHU_CI_SECRET;else assert credentials==0;files['wl-ops-public/summary.json']='summary';events<<'finish';return mode in ['no-bot','interrupted']?2:0}
    else if(command.contains('jenkins ops claim-check')){
      assert env.WL_JENKINS_READ_TOKEN;assert !env.WL_FEISHU_CI_SECRET;events<<'claim'
      if(env.WL_OPS_KEY=='a'*24&&mode=='claim-failure')return 2
      if(env.WL_OPS_KEY=='a'*24&&mode=='claim-missing')return 0
      files[env.WL_OPS_CLAIM]=env.WL_OPS_KEY=='b'*24?'nextClaim':mode=='claim-unknown'?'unknown':mode=='already-started'?'already':'claim'
    }
    else if(command.contains('jenkins ops ack-check')){
      def expected=env.WL_OPS_KEY=='a'*24?claim:nextClaim
      assert env.WL_OPS_BUILD==(40+builds).toString()
      assert env.WL_OPS_DISPATCH==expected.dispatchId
      assert command.contains('--dispatch-id')
      if(mode=='ack-failure'&&env.WL_OPS_KEY=='a'*24)throw new RuntimeException('fixture ACK write failed')
      acknowledgedKeys<<env.WL_OPS_KEY;events<<'ack'
    }
    else assert false:command
    return 0
  })
  def script=shell.parse(source,'native_ops.groovy');script.run()
  def failure=null
  try{script.wlOpsRun([gateRoot:'/fixed/gate',clusterFile:'/controlled/cluster.json'])}catch(Exception expected){failure=expected}
  assert events.contains('inventory')&&events.contains('finish')&&events.contains('archive')
  assert credentials==0
  if(mode=='normal'){
    assert failure==null:failure
    assert builds==1&&events.indexOf('claim')<events.indexOf('CHECK-start')&&events.indexOf('CHECK-start')<events.indexOf('ack')
    assert events.count('inspect')==2
  }else if(mode=='no-bot'){
    assert failure==null:failure
    assert builds==0&&currentBuild.result=='UNSTABLE'
  }else if(mode=='interrupted'){
    assert interruptedClass.isInstance(failure)
    assert builds==0&&events.count('checkout')==1&&events.count('inspect')==0
    assert cleanups>=2
  }else if(mode=='already-started'){
    assert failure==null:failure
    assert builds==0&&currentBuild.result==null
  }else{
    assert failure==null:failure
    assert currentBuild.result=='UNSTABLE'
    assert events.count('archive')>=2
    if(mode=='ack-failure'){assert startedKeys==['a'*24,'b'*24];assert acknowledgedKeys==['b'*24]}
    else{assert startedKeys==['b'*24];assert acknowledgedKeys==['b'*24]}
  }
}
println 'Operations native Groovy mock passed: normal/no-bot/interrupted/claim-failure/claim-missing/claim-unknown/already-started/ack-failure.'
`);
  const result = spawnSync(process.env.JAVA || 'java', ['-cp', jar, 'groovy.ui.GroovyMain', harness, fileURLToPath(new URL('../../templates/ci/jenkins-native.groovy', import.meta.url))], {encoding: 'utf8', timeout: 30000});
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  assert.match(result.stdout, /Operations native Groovy mock passed/);
});
