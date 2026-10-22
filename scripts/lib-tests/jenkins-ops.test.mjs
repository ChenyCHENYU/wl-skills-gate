import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {randomUUID, createHmac} from 'node:crypto';
import {fixture, git, put, commit, bind} from '../test-support/jenkins-fixture.mjs';
import {planJenkinsInstallation, applyJenkinsInstallation} from '../../lib/jenkins-installation.js';
import {inventoryOps, inspectOpsProject, finishOps, opsReportHtml} from '../../lib/jenkins-ops.js';
import {nativePipelineEntry} from '../../lib/jenkins-entry-contract.js';
import {renderFleetJob} from '../../lib/jenkins-job-config.js';

const repository = 'https://gitlab.example.invalid/produce/wl-produce.git';
const readEnv = {WL_JENKINS_READ_USER: 'readonly', WL_JENKINS_READ_TOKEN: 'fixture-read-secret'};
const noticeEnv = {
  WL_FEISHU_CI_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-fixture-ci',
  WL_FEISHU_CI_SECRET: 'fixture-ci-signing-secret',
  JOB_NAME: 'wl-quality-doctor', BUILD_NUMBER: '21',
  BUILD_URL: 'https://jenkins.example.invalid/job/wl-quality-doctor/21/',
};
const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const scmXml = (branch = 'test') => `<flow-definition><properties/><definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition"><scm class="hudson.plugins.git.GitSCM"><userRemoteConfigs><hudson.plugins.git.UserRemoteConfig><url>${repository}</url><credentialsId>scm-readonly</credentialsId></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs><branches><hudson.plugins.git.BranchSpec><name>${branch}</name></hudson.plugins.git.BranchSpec></branches></scm><scriptPath>Jenkinsfile</scriptPath></definition><disabled>false</disabled></flow-definition>`;
const inlineXml = script => `<flow-definition><properties/><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition"><script>${escapeXml(script)}</script><sandbox>true</sandbox></definition><disabled>false</disabled></flow-definition>`;

function install(t) {
  const f = fixture(t);
  git(f.root, 'remote', 'set-url', 'origin', repository);
  const options = {prefix: path.join(f.base, 'install'), configDir: path.join(f.base, 'config'), registryFiles: [f.registryFile], jenkinsOrigin: 'https://jenkins.example.invalid/', centralAgentLabel: 'central', reviewSignerAgentLabel: 'signer'};
  const plan = planJenkinsInstallation(options);
  const installed = applyJenkinsInstallation({...options, confirm: true, planHash: plan.planHash});
  const configFile = path.join(options.configDir, 'jenkins-ops.json');
  const config = JSON.parse(readFileSync(configFile));
  config.people = {manager: {name: '技术经理', feishu: {idType: 'open_id', id: 'ou_fixture_manager', verified: true}}};
  config.owners = {'wl-produce': {technicalManager: 'manager'}};
  put(options.configDir, 'jenkins-ops.json', config);
  return {...f, installed, clusterFile: installed.clusterFile, configDir: options.configDir};
}

function jenkinsProvider(jobs) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url);
    calls.push({url: endpoint.href, method: options.method || 'GET'});
    assert.equal(endpoint.origin, 'https://jenkins.example.invalid');
    assert.equal(options.method, 'GET', 'ops inventory must never write Jenkins');
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('readonly:fixture-read-secret').toString('base64'));
    const segments = endpoint.pathname.split('/').filter(Boolean), job = [];
    let index = 0;
    while (segments[index] === 'job') { job.push(decodeURIComponent(segments[index + 1])); index += 2; }
    const suffix = segments.slice(index).join('/'), full = job.join('/');
    if (suffix === 'api/json') {
      const children = new Map();
      for (const name of jobs.keys()) {
        if (full && !name.startsWith(full + '/')) continue;
        const parts = (full ? name.slice(full.length + 1) : name).split('/');
        children.set(parts[0], {name: parts[0], _class: parts.length > 1 ? 'com.cloudbees.hudson.plugins.folder.Folder' : 'org.jenkinsci.plugins.workflow.job.WorkflowJob'});
      }
      return new Response(JSON.stringify({jobs: [...children.values()]}));
    }
    if (suffix === 'config.xml') return jobs.has(full) ? new Response(jobs.get(full)) : new Response('', {status: 404});
    throw Error('unexpected read route: ' + endpoint.pathname);
  };
  return {calls, fetchImpl};
}

const freshInventory = inventory => ({...inventory, runId: randomUUID()});
const failureResult = (f, inventory) => inspectOpsProject({clusterFile: f.clusterFile, inventory, targetKey: inventory.targets[0].key, failure: 'checkout-not-completed'});
const inspection = (f, inventory) => inspectOpsProject({clusterFile: f.clusterFile, inventory, targetKey: inventory.targets[0].key, root: f.root});

async function controlledProject(t) {
  const f = install(t);
  put(f.root, 'pom.xml', '<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId><profiles><profile><id>wl-quality-audit</id></profile><profile><id>wl-quality-unit</id></profile></profiles></project>');
  put(f.root, '.wl-skills-bd/capabilities.json', {schemaVersion: 1, fixture: true});
  const policy = JSON.parse(readFileSync(path.join(f.root, 'quality/policy.yml')));
  policy.checks[0].profiles.push('release'); policy.releaseRequires = ['FIXTURE'];
  put(f.root, 'quality/policy.yml', policy);
  commit(f.root);
  const seed = JSON.parse(readFileSync(f.seedFile)); seed.binding.repository = repository;
  put(f.base, 'seed.json', seed);
  await bind(f);
  const registry = JSON.parse(readFileSync(f.registryFile)); registry.nativeEntry = f.installed.nativeEntry;
  put(f.base, 'bindings.json', registry);
  // Readiness performs file-level handover checks. These controlled fixture
  // documents are not used to pretend a real SSO, Review signer or build ran.
  for (const name of ['automation-config', 'governance-config', 'control-config', 'review-publish-config']) {
    put(f.configDir, name + '.json', {schemaVersion: 1, projects: {'wl-produce': {}}, sources: [{id: 'fixture'}], dataDir: f.base, publicKeyFile: 'approved-fixture.pem', identity: {provider: 'fixture'}, authorizationIssuer: 'fixture', reviewPrivateKeyEnv: 'FIXTURE_PRIVATE_FILE'});
  }
  put(f.configDir, 'jenkins-fleet.json', {schemaVersion: 1, kind: 'wl-gate-jenkins-fleet', jenkinsOrigin: 'https://jenkins.example.invalid/', dataDir: path.join(f.base, 'fleet'), registryFiles: [f.registryFile], automationConfigFile: path.join(f.configDir, 'automation-config.json'), selection: {projects: ['wl-produce'], branches: ['test']}, approvers: ['fixture']});
  const binding = registry.bindings[0];
  const xml = renderFleetJob({script: nativePipelineEntry(f.installed.nativeEntry), binding, mode: 'check', secret: 'fixture-gitlab-hook-secret'});
  const jobs = new Map([[binding.jobs.check, xml]]), provider = jenkinsProvider(jobs);
  const inventory = await inventoryOps({clusterFile: f.clusterFile, env: readEnv, fetchImpl: provider.fetchImpl});
  return {...f, registry, binding, jobs, provider, inventory};
}

async function readyReport(f, inventory = f.inventory) {
  const result = inspection(f, inventory);
  assert.equal(result.status, 'ready', JSON.stringify(result.gaps));
  assert.equal(result.pinsVerified, true);
  const report = await finishOps({clusterFile: f.clusterFile, inventory, results: [result], send: false});
  assert.equal(report.status, 'ready', JSON.stringify(report.globalGaps));
  return report;
}

test('无登记／中央配置也能真实盘点、发现项目缺Gate并通过CI机器人持久提醒；不变不刷屏', async t => {
  const f = install(t);
  rmSync(path.join(f.root, 'quality'), {recursive: true});
  commit(f.root);
  const provider = jenkinsProvider(new Map([['生产/后端-test', scmXml()]]));
  const inventory = await inventoryOps({clusterFile: f.clusterFile, env: readEnv, fetchImpl: provider.fetchImpl});
  assert(!existsSync(f.registryFile));
  assert(!existsSync(path.join(f.configDir, 'automation-config.json')));
  assert.equal(inventory.targets.length, 1);
  assert.equal(inventory.targets[0].checkoutAllowed, true);
  assert.equal(inventory.remoteModified, false);
  assert.equal(provider.calls.every(call => call.method === 'GET'), true);
  const result = inspection(f, inventory);
  assert.equal(result.status, 'attention');
  assert(result.gaps.some(g => g.id === 'PROJECT-GATE'));
  assert(result.gaps.some(g => g.id === 'UNCONTROLLED-JOB'));
  const sent = [];
  const send = async (url, options) => {
    assert.equal(url, noticeEnv.WL_FEISHU_CI_WEBHOOK);
    const card = JSON.parse(options.body);
    assert.equal(card.sign, createHmac('sha256', `${card.timestamp}\n${noticeEnv.WL_FEISHU_CI_SECRET}`).update('').digest('base64'));
    sent.push(card);
    return new Response(JSON.stringify({code: 0}));
  };
  const report = await finishOps({clusterFile: f.clusterFile, inventory, results: [result], env: noticeEnv, send: true, fetchImpl: send});
  assert.equal(report.notification.status, 'sent');
  assert.equal(report.notification.mentionMappingComplete, true);
  assert.deepEqual(report.notification.mentions, ['ou_fixture_manager']);
  assert.equal(report.qualityPassed, false);
  assert.equal(report.buildAuthorized, false);
  assert.match(JSON.stringify(sent[0]), /PROJECT-GATE|quality\/workspace|尚未完整接入Gate/);
  const state = JSON.parse(readFileSync(path.join(f.configDir, 'ops-state/state.json')));
  assert(Object.values(state.notices).some(item => item.status === 'sent' && item.runId === inventory.runId));
  assert(existsSync(path.join(f.configDir, 'ops-state/runs', inventory.runId, 'report.json')));
  const next = freshInventory(inventory);
  const again = await finishOps({clusterFile: f.clusterFile, inventory: next, results: [inspection(f, next)], env: noticeEnv, send: true, fetchImpl: send});
  assert.equal(again.notification.status, 'unchanged');
  assert.equal(sent.length, 1);
});

test('飞书送达未知保留待核对；下一轮相同缺项不会自动补发', async t => {
  const f = install(t), provider = jenkinsProvider(new Map([['后端-test', scmXml()]]));
  const inventory = await inventoryOps({clusterFile: f.clusterFile, env: readEnv, fetchImpl: provider.fetchImpl});
  let sends = 0;
  const unknown = async () => { sends++; throw Error('fixture timeout after server may have accepted'); };
  const first = await finishOps({clusterFile: f.clusterFile, inventory, results: [failureResult(f, inventory)], env: noticeEnv, send: true, fetchImpl: unknown});
  assert.equal(first.notification.status, 'unknown');
  const next = freshInventory(inventory);
  const second = await finishOps({clusterFile: f.clusterFile, inventory: next, results: [failureResult(f, next)], env: noticeEnv, send: true, fetchImpl: unknown});
  assert.equal(second.notification.status, 'unknown');
  assert.equal(sends, 1);
  const state = JSON.parse(readFileSync(path.join(f.configDir, 'ops-state/state.json')));
  assert(Object.values(state.notices).some(item => item.status === 'unknown'));
});

test('动态参数不猜固定分支，多仓库不擅选；feature分支不进入目标检查', async t => {
  const f = install(t);
  const dynamic = `pipeline { agent any\nenvironment {\nGIT_URL = '${repository}'\nGIT_CREDENTIAL_ID = 'scm-readonly'\n}\nstages { stage('checkout') { steps { git branch: env.TAG, credentialsId: env.GIT_CREDENTIAL_ID, url: env.GIT_URL } } } }`;
  const multi = scmXml().replace('</userRemoteConfigs>', '<hudson.plugins.git.UserRemoteConfig><url>https://gitlab.example.invalid/common/shared.git</url><credentialsId>scm-readonly</credentialsId></hudson.plugins.git.UserRemoteConfig></userRemoteConfigs>');
  const provider = jenkinsProvider(new Map([['参数分支', inlineXml(dynamic)], ['多仓库', multi], ['自己的分支', scmXml('feature/order-fix')]]));
  const inventory = await inventoryOps({clusterFile: f.clusterFile, env: readEnv, fetchImpl: provider.fetchImpl});
  assert.equal(inventory.jobsDiscovered, 3);
  assert.equal(inventory.targets.length, 2);
  assert(!inventory.targets.some(target => target.job === '自己的分支'));
  for (const target of inventory.targets) {
    assert.equal(target.checkoutAllowed, false);
    assert.equal(target.branch, null);
    assert(target.gaps.some(g => g.id === 'SCM-LOCATION'));
    const result = inspectOpsProject({clusterFile: f.clusterFile, inventory, targetKey: target.key, failure: 'checkout-not-completed'});
    assert.equal(result.status, 'attention');
    assert.equal(result.sha, undefined);
  }
});

test('检出失败、缺失结果、重复结果和旧runId均保留待处理；不复用历史绿灯', async t => {
  const f = install(t), provider = jenkinsProvider(new Map([['后端-test', scmXml()]]));
  const first = await inventoryOps({clusterFile: f.clusterFile, env: readEnv, fetchImpl: provider.fetchImpl});
  const failed = failureResult(f, first);
  assert(failed.gaps.some(g => g.id === 'CHECKOUT'));
  assert.equal(failed.sha, undefined);
  assert.equal(failed.qualityPassed, false);
  for (const mode of ['failed', 'missing', 'old', 'duplicate']) {
    const inventory = freshInventory(first), current = {...failed, runId: inventory.runId};
    const results = mode === 'missing' ? [] : mode === 'old' ? [failed] : mode === 'duplicate' ? [current, current] : [current];
    const report = await finishOps({clusterFile: f.clusterFile, inventory, results, send: false});
    assert.equal(report.projects[0].status, 'attention', mode);
    assert(report.projects[0].gaps.some(g => g.id === (mode === 'failed' ? 'CHECKOUT' : 'INSPECTION-MISSING')), mode);
    assert.equal(report.buildAuthorized, false, mode);
  }
});

test('干净检出没有node_modules是待固定依赖准备，不误报未声明Gate', async t => {
  const f = install(t), provider = jenkinsProvider(new Map([['后端-test', scmXml()]]));
  assert(!existsSync(path.join(f.root, 'quality-tools/node_modules')));
  const inventory = await inventoryOps({clusterFile: f.clusterFile, env: readEnv, fetchImpl: provider.fetchImpl});
  const report = inspection(f, inventory);
  assert.equal(report.projectKind, 'backend');
  assert(!report.gaps.some(g => g.id === 'PROJECT-GATE' || /^(?:INSTALLED-|ENGINES-)/.test(g.id)));
  assert(report.dependenciesPreparedByCheck.includes('INSTALLED-GATE'));
  assert(report.dependenciesPreparedByCheck.includes('INSTALLED-BD'));
  assert(!report.gaps.some(g => g.id === 'PIN-GATE'));
  assert.equal(report.qualityPassed, false);
  assert.equal(report.buildAuthorized, false);
});

test('真实接入前置恢复后发送恢复提醒；同一缺项复发不能被历史sent吞掉', async t => {
  const f = await controlledProject(t), first = f.inventory;
  assert.equal(first.errors.length, 0);
  let calls = 0;
  const send = async () => { calls++; return new Response(JSON.stringify({code: 0})); };
  const before = await finishOps({clusterFile: f.clusterFile, inventory: first, results: [failureResult(f, first)], env: noticeEnv, send: true, fetchImpl: send});
  assert.equal(before.status, 'attention');
  assert.equal(before.notification.status, 'sent');
  const next = freshInventory(first), result = inspection(f, next);
  assert.equal(result.status, 'ready', JSON.stringify(result.gaps));
  assert.equal(result.pinsVerified, true);
  const after = await finishOps({clusterFile: f.clusterFile, inventory: next, results: [result], env: noticeEnv, send: true, fetchImpl: send});
  assert.equal(after.status, 'ready');
  assert.equal(after.recovered, true);
  assert.equal(after.notification.status, 'sent');
  assert.equal(after.qualityPassed, false);
  assert.equal(after.buildAuthorized, false);
  const recurring = freshInventory(first);
  const recurrence = await finishOps({clusterFile: f.clusterFile, inventory: recurring, results: [failureResult(f, recurring)], env: noticeEnv, send: true, fetchImpl: send});
  assert.equal(recurrence.notification.status, 'sent', 'a new recurrence after recovery needs a fresh reminder');
  assert.equal(calls, 3);
});

test('HTML把项目、Job和缺项当不可信文本转义，不形成脚本与属性注入', () => {
  const html = opsReportHtml({checkedAt: '<script>alert(1)</script>', status: 'attention', globalGaps: [{message: '<img src=x onerror=alert(1)>', action: '& " < >'}], projects: [{key: 'x" onclick="alert(1)', project: '<script>project()</script>', branch: '<b>test</b>', jobs: ['<img src=x>'], gaps: [{id: '<svg>', message: '<iframe>', action: '<script>fix()</script>'}]}]});
  assert.doesNotMatch(html, /<script>|<img\b|<iframe>|<svg>|<b>test/);
  assert.match(html, /&lt;script&gt;project\(\)&lt;\/script&gt;/);
  assert.match(html, /id="x&quot; onclick=&quot;alert\(1\)"/);
  assert.match(html, /&amp; &quot; &lt; &gt;/);
});
