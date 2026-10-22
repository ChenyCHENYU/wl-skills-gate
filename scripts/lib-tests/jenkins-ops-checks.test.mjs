import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, bind, put, git } from '../test-support/jenkins-fixture.mjs';
import { planJenkinsInstallation, applyJenkinsInstallation } from '../../lib/jenkins-installation.js';
import { loadJenkinsCluster } from '../../lib/jenkins-cluster.js';
import { digest } from '../../lib/jenkins-integration.js';
import { stableStringify } from '../../lib/util.js';
import { nativePipelineEntry } from '../../lib/jenkins-entry-contract.js';
import { renderFleetJob } from '../../lib/jenkins-job-config.js';
import { claimOpsCheck, acknowledgeOpsCheck } from '../../lib/jenkins-ops-checks.js';

const env = { WL_JENKINS_READ_USER: 'fixture-reader', WL_JENKINS_READ_TOKEN: 'private-fixture-read-token' };
const read = file => JSON.parse(readFileSync(file));
const hash = value => digest(stableStringify(value));
async function setup(t) {
  const f = fixture(t);
  const options = { prefix: path.join(f.base, 'install'), configDir: path.join(f.base, 'config'), registryFiles: [f.registryFile], jenkinsOrigin: 'https://jenkins.example.invalid/', centralAgentLabel: 'central', reviewSignerAgentLabel: 'signer' };
  const plan = planJenkinsInstallation(options), installed = applyJenkinsInstallation({ ...options, confirm: true, planHash: plan.planHash });
  await bind(f);
  const registry = read(f.registryFile); registry.nativeEntry = installed.nativeEntry; put(f.base, 'bindings.json', registry);
  for (const name of ['automation-config', 'governance-config', 'control-config', 'review-publish-config']) put(options.configDir, name + '.json', {
    schemaVersion: 1, projects: { 'wl-produce': {} }, sources: [{ id: 'fixture' }], dataDir: f.base, publicKeyFile: 'approved-fixture.pem', identity: { provider: 'fixture' }, authorizationIssuer: 'fixture', reviewPrivateKeyEnv: 'FIXTURE_PRIVATE_FILE',
  });
  put(options.configDir, 'jenkins-fleet.json', { schemaVersion: 1, kind: 'wl-gate-jenkins-fleet', jenkinsOrigin: options.jenkinsOrigin, dataDir: path.join(f.base, 'fleet'), registryFiles: [f.registryFile], automationConfigFile: path.join(options.configDir, 'automation-config.json'), selection: { projects: ['wl-produce'], branches: ['test'] }, approvers: ['fixture'] });
  const binding = registry.bindings[0], cluster = loadJenkinsCluster(installed.clusterFile);
  let xml = renderFleetJob({ script: nativePipelineEntry(installed.nativeEntry), binding, mode: 'check', secret: 'fixture-shared-gitlab-secret' });
  const project = { key: 'a'.repeat(24), project: binding.project, branch: binding.branch, scope: binding.scope, job: binding.jobs.check, jobs: [binding.jobs.check], status: 'ready', gaps: [], pinsVerified: true, entryVerified: true, checkJob: binding.jobs.check, bindingId: binding.id, registryFile: f.registryFile, bindingHash: hash(binding), sha: git(f.root, 'rev-parse', 'HEAD'), configHash: digest(xml) };
  const report = { schemaVersion: 1, kind: 'jenkins-ops-report', runId: randomUUID(), checkedAt: new Date().toISOString(), clusterHash: cluster.configHash, jenkinsOrigin: options.jenkinsOrigin, status: 'ready', globalGaps: [], projects: [project], qualityPassed: false, buildAuthorized: false };
  const reports = path.join(options.configDir, 'ops-state/runs');
  const save = value => put(reports, value.runId + '/report.json', value);
  save(report);
  const runs = new Map(), summaries = new Map(), calls = [];
  let failReads = false;
  const response = data => new Response(JSON.stringify(data));
  const fetchImpl = async (url, request = {}) => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    assert.equal(u.origin, 'https://jenkins.example.invalid'); assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, 'Basic ' + Buffer.from('fixture-reader:private-fixture-read-token').toString('base64'));
    assert.equal(request.redirect, 'error');
    if (failReads) throw Error('network-private-token');
    if (u.pathname.endsWith('/config.xml')) return new Response(xml);
    const build = /\/([0-9]+)\/api\/json$/.exec(u.pathname);
    if (build) return runs.has(build[1]) ? response(runs.get(build[1])) : new Response('', { status: 404 });
    if (u.pathname.endsWith('/api/json')) return response({ builds: [...runs.values()].sort((a, b) => b.number - a.number).slice(0, 25) });
    const artifact = /\/([0-9]+)\/artifact\/quality-reports\/quality-summary\.json$/.exec(u.pathname);
    if (artifact) return summaries.has(artifact[1]) ? response(summaries.get(artifact[1])) : new Response('', { status: 404 });
    throw Error('unexpected Jenkins route');
  };
  const args = { clusterFile: installed.clusterFile, runId: report.runId, key: project.key, env, fetchImpl };
  const stateFile = path.join(options.configDir, 'ops-state/checks.json');
  const state = () => read(stateFile), current = () => Object.values(state().claims)[0];
  const run = (number, claim, extra = {}) => ({ number, building: false, result: 'SUCCESS', actions: [{ parameters: [{ name: 'WL_GATE_DISPATCH_ID', value: claim.dispatchId }, { name: 'WL_REVIEW_SHA', value: claim.sha }] }], artifacts: [], ...extra });
  return { ...f, args, report, project, options, binding, reports, save, stateFile, state, current, runs, summaries, calls, run, xml: () => xml, setXml: value => { xml = value; }, setFailReads: value => { failReads = value; } };
}

test('首次claim持久保存唯一dispatch和候选SHA；ack实际编号幂等，运行中和成功跨轮不重复', async t => {
  const f = await setup(t), claimed = await claimOpsCheck(f.args);
  assert.equal(claimed.status, 'claimed'); assert.equal(claimed.sha, f.project.sha); assert.match(claimed.dispatchId, /^[a-f0-9-]{36}$/);
  assert.equal(claimed.attempt, 1); assert.equal(f.current().status, 'claimed'); assert.equal(f.current().dispatchId, claimed.dispatchId);
  assert.equal((await claimOpsCheck(f.args)).status, 'unknown');
  await assert.rejects(acknowledgeOpsCheck({ ...f.args, buildNumber: 0 }), /实际Jenkins运行编号/);
  await assert.rejects(acknowledgeOpsCheck({ ...f.args, runId: randomUUID(), buildNumber: 31 }), /不存在唯一/);
  assert.equal((await acknowledgeOpsCheck({ ...f.args, buildNumber: 31 })).status, 'started');
  assert.equal((await acknowledgeOpsCheck({ ...f.args, buildNumber: 31 })).status, 'started');
  await assert.rejects(acknowledgeOpsCheck({ ...f.args, buildNumber: 32 }), /不能覆盖/);
  f.runs.set('31', f.run(31, claimed, { building: true, result: null }));
  assert.equal((await claimOpsCheck(f.args)).status, 'already-started');
  f.runs.set('31', f.run(31, claimed));
  const next = { ...f.report, runId: randomUUID() }; f.save(next);
  assert.equal((await claimOpsCheck({ ...f.args, runId: next.runId })).status, 'already-started');
  assert.equal(f.current().attempt, 1);
});
test('启动返回前中断，凭近期25次运行的dispatchId及SHA找到唯一实际运行后补ack', async t => {
  const f = await setup(t), claimed = await claimOpsCheck(f.args);
  f.runs.set('7', f.run(7, claimed));
  const pending = { ...f.report, runId: randomUUID(), status: 'attention', projects: [{ ...f.project, status: 'attention', gaps: [{ id: 'CHECK-DISPATCH-UNKNOWN', message: '待核对实际启动' }] }] }; f.save(pending);
  const reconciled = await claimOpsCheck({ ...f.args, runId: pending.runId });
  assert.equal(reconciled.status, 'already-started'); assert.equal(reconciled.buildNumber, '7');
  assert.equal(f.current().status, 'started'); assert.equal(f.current().attempt, 1);
  assert(f.calls.some(c => c.includes('{0,25}') || c.includes('%7B0,25%7D')));
});
test('未知启动不盲发；一分钟观察后只有显式确认且对账无匹配才可有界重试', async t => {
  const f = await setup(t), instant = Date.now(), claimed = await claimOpsCheck({ ...f.args, now: instant });
  assert.equal((await claimOpsCheck({ ...f.args, now: instant + 60001 })).status, 'unknown');
  assert.equal((await claimOpsCheck({ ...f.args, now: instant + 1000, retryUnknown: true })).status, 'unknown');
  const retry = await claimOpsCheck({ ...f.args, now: instant + 60001, retryUnknown: true });
  assert.equal(retry.status, 'claimed'); assert.equal(retry.attempt, 2); assert.notEqual(retry.dispatchId, claimed.dispatchId);
  assert.equal(f.current().history[0].dispatchId, claimed.dispatchId);
  await assert.rejects(acknowledgeOpsCheck({ ...f.args, buildNumber: 31, dispatchId: claimed.dispatchId }), /迟到或其他dispatchId/);
  assert.equal(f.current().status, 'claimed');
  assert.equal((await acknowledgeOpsCheck({ ...f.args, buildNumber: 32, dispatchId: retry.dispatchId })).status, 'started');
});
test('重复追踪、错误SHA、不可读运行都不能被当成无运行重新启动', async t => {
  const f = await setup(t), instant = Date.now(), claimed = await claimOpsCheck({ ...f.args, now: instant });
  f.runs.set('7', f.run(7, claimed)); f.runs.set('8', f.run(8, claimed));
  assert.equal((await claimOpsCheck({ ...f.args, now: instant + 60001, retryUnknown: true })).status, 'unknown');
  f.runs.clear(); await acknowledgeOpsCheck({ ...f.args, buildNumber: 9 });
  f.runs.set('9', f.run(9, { ...claimed, sha: 'b'.repeat(40) }));
  assert.equal((await claimOpsCheck({ ...f.args, retryUnknown: true })).status, 'unknown');
  f.runs.clear(); assert.equal((await claimOpsCheck({ ...f.args, retryUnknown: true })).status, 'unknown');
  assert.equal(f.current().attempt, 1);
});
test('只读重验实际Job摘要、受控入口、参数和目标Push触发；漂移先于写启动台账被拒绝', async t => {
  const f = await setup(t), original = f.xml();
  f.setXml(original.replace('<includeBranchesSpec>test</includeBranchesSpec>', '<includeBranchesSpec>sit</includeBranchesSpec>'));
  await assert.rejects(claimOpsCheck(f.args), /配置已漂移/); assert(!existsSync(f.stateFile));
  // Even a matching updated digest cannot turn an unprotected script into a
  // CHECK. This isolates the semantic check from the raw config pin check.
  f.setXml(original.replace('<sandbox>true</sandbox>', '<sandbox>false</sandbox>'));
  f.project.configHash = digest(f.xml()); f.save(f.report);
  await assert.rejects(claimOpsCheck(f.args), /受控入口/); assert(!existsSync(f.stateFile));
  f.setXml(original.replace('<name>WL_REVIEW_SHA</name>', '<name>OTHER_SHA</name>')); f.project.configHash = digest(f.xml()); f.save(f.report);
  await assert.rejects(claimOpsCheck(f.args), /候选SHA或启动追踪参数/); assert(!existsSync(f.stateFile));
});
test('过期、未来、其他集群、BUILD或缺pins的报告不可借旧ready触发', async t => {
  const f = await setup(t), original = structuredClone(f.report);
  for (const mutate of [
    r => { r.checkedAt = new Date(Date.now() - 31 * 60000).toISOString(); },
    r => { r.checkedAt = new Date(Date.now() + 60000).toISOString(); },
    r => { r.clusterHash = 'b'.repeat(64); },
    r => { r.globalGaps = [{ id: 'CENTRAL-CONFIG' }]; },
    r => { r.projects[0].pinsVerified = false; },
    r => { r.projects[0].checkJob = 'produce/BUILD'; },
    r => { r.projects[0].gaps = [{ id: 'PROJECT-GATE' }]; r.projects[0].status = 'attention'; },
  ]) {
    const value = structuredClone(original); mutate(value); f.save(value);
    await assert.rejects(claimOpsCheck(f.args), /巡检报告|仅本轮/); assert(!existsSync(f.stateFile));
  }
});
test('已核验实际终止的环境失败可重试；同一SHA最多三次，台账完整保存每次dispatch', async t => {
  const f = await setup(t); let claim = await claimOpsCheck(f.args);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(claim.attempt, attempt);
    await acknowledgeOpsCheck({ ...f.args, buildNumber: 10 + attempt });
    f.runs.set(String(10 + attempt), f.run(10 + attempt, claim, { building: false, result: attempt === 2 ? 'ABORTED' : 'FAILURE', artifacts: [] }));
    const next = await claimOpsCheck(f.args);
    if (attempt < 3) { assert.equal(next.status, 'claimed'); assert.notEqual(next.dispatchId, claim.dispatchId); claim = next; }
    else assert.equal(next.status, 'retry-limit');
  }
  assert.equal(f.current().history.length, 2); assert.equal(f.current().attempt, 3);
});
test('真实质量发现失败不自动重刷；报告下载失败不能冒充无质量原件', async t => {
  const f = await setup(t), claim = await claimOpsCheck(f.args);
  await acknowledgeOpsCheck({ ...f.args, buildNumber: 17 });
  f.runs.set('17', f.run(17, claim, { result: 'FAILURE', artifacts: [{ relativePath: 'quality-reports/quality-summary.json' }] }));
  const noOriginal = await claimOpsCheck(f.args); assert.equal(noOriginal.status, 'failed-needs-confirmation');
  f.summaries.set('17', { run: { project: f.project.project, commitSha: claim.sha, stage: 'ci' }, findings: [{ severity: 'error', ruleId: 'FIXTURE/RISK' }], checks: [{ status: 'passed' }] });
  assert.equal((await claimOpsCheck(f.args)).status, 'quality-failed');
  assert.equal((await claimOpsCheck({ ...f.args, retryKnownFailure: true })).status, 'quality-failed');
  assert.equal(f.current().attempt, 1);
});
test('不完整质量结果只读留待确认，明确非代码执行失败才可自动复检', async t => {
  const f = await setup(t), claim = await claimOpsCheck(f.args);
  await acknowledgeOpsCheck({ ...f.args, buildNumber: 19 });
  f.runs.set('19', f.run(19, claim, { result: 'FAILURE', artifacts: [{ relativePath: 'quality-reports/quality-summary.json' }] }));
  f.summaries.set('19', { run: { project: f.project.project, commitSha: claim.sha, stage: 'ci' }, findings: [], checks: [{ status: 'invalid' }] });
  assert.equal((await claimOpsCheck(f.args)).status, 'failed-needs-confirmation');
  f.summaries.set('19', { run: { project: f.project.project, commitSha: claim.sha, stage: 'ci' }, findings: [], checks: [{ status: 'passed' }] });
  assert.equal((await claimOpsCheck(f.args)).status, 'claimed');
  assert.equal(f.current().attempt, 2);
});
test('台账或工程配置损坏不能忽略后重新启动', async t => {
  const f = await setup(t); await claimOpsCheck(f.args);
  put(path.dirname(f.stateFile), 'checks.json', { schemaVersion: 1, claims: null });
  await assert.rejects(claimOpsCheck(f.args), /台账损坏/);
  rmSync(path.join(f.options.configDir, 'control-config.json'));
  await assert.rejects(claimOpsCheck(f.args), /工程配置变化/);
});
