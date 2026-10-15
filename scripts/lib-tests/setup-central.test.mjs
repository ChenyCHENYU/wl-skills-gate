import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, symlinkSync } from 'node:fs';
import { createControlReviewFixture } from '../test-support/control-review-fixture.mjs';
import { planCentralSetup, runCentralSetup } from '../../lib/setup-central.js';
import { automationTick, loadAutomationConfig, startAutomation } from '../../lib/automation.js';
import { readGovernanceState } from '../../lib/governance.js';
import { stableStringify } from '../../lib/util.js';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
async function fixture(t) {
  const f = await createControlReviewFixture(t), governance = read(f.c.governanceConfigFile);
  governance.allowedLinkOrigins.push('https://ci.example.invalid'); write(f.c.governanceConfigFile, governance);
  const reviewCiFile = path.join(f.root, 'review-ci.json'), automationConfigFile = path.join(f.root, 'automation.json'), reviewPublishConfigFile = path.join(f.root, 'publisher.json');
  write(reviewCiFile, { schemaVersion: 1, collectorConfigFile: f.configFile, controlConfigFile: f.controlConfigFile, reviewPolicyFile: path.join(f.root, 'quality/review-policy.json') });
  const publication = { manifestDir: path.join(f.root, 'review-delivery'), publicKeyFile: path.join(f.root, 'review-public.pem'), authorizationPublicKeyFile: path.join(f.root, 'authorization-public.pem'), expectAuthorizationIssuer: f.c.authorizationIssuer, expectReviewPolicyHash: f.collector.reviewPolicyHash, evidenceRoot: f.root };
  const a = { schemaVersion: 1, governanceConfigFile: f.c.governanceConfigFile, stateFile: f.c.stateFile, dataDir: path.join(f.root, 'automation'), receiptPrivateKeyFile: f.c.receiptPrivateKeyFile,
    sources: [{ id: 'demo-standard', configFile: f.ciConfigFile, actors: { '15': 'author' }, since: '2026-10-15T00:00:00Z', environment: 'dev', review: { configFile: reviewCiFile, outRoot: path.join(f.root, 'reviews'), publication } }] };
  write(automationConfigFile, a);
  const p = { schemaVersion: 1, controlCatalogFile: path.join(f.c.dataDir, 'reviews.json'), authorizationDir: path.join(f.c.dataDir, 'authorizations'), stateFile: path.join(f.root, 'signing-state.json'), manifestDir: publication.manifestDir,
    reviewPrivateKeyEnv: 'WL_REVIEW_PRIVATE_KEY_FILE', reviewPublicKeyFile: publication.publicKeyFile, authorizationPublicKeyFile: publication.authorizationPublicKeyFile, authorizationIssuer: f.c.authorizationIssuer,
    projects: { demo: { evidenceRoots: [f.root], reviewers: ['reviewer'], collectorConfigFile: f.configFile, reviewPolicyFile: path.join(f.root, 'quality/review-policy.json'), reviewPolicyHash: f.collector.reviewPolicyHash,
      policyHash: 'a'.repeat(64), rulesHash: 'a'.repeat(64), baselineHash: 'a'.repeat(64), waiversHash: 'a'.repeat(64), profile: 'standard' } } };
  write(reviewPublishConfigFile, p);
  const options = { configDir: f.root, governanceConfigFile: f.c.governanceConfigFile, controlConfigFile: f.controlConfigFile, automationConfigFile, reviewPublishConfigFile,
    env: { TOKEN: 'UNIQUE_CI_SECRET_NEVER_PRINT', WL_REVIEW_PRIVATE_KEY_FILE: path.join(f.root, 'review-private.pem') } };
  return { ...f, a, p, options, automationConfigFile, reviewPublishConfigFile, reviewCiFile };
}
function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const file = path.join(entry.parentPath, entry.name); return [path.relative(root, file), hash(readFileSync(file))];
  }));
}
function stubRuntime() {
  const calls = []; const server = { close(callback) { calls.push({ stage: 'stop-control' }); callback(); } };
  return { calls, runtime: { serveControl: async (args) => { calls.push({ stage: 'serve', args }); return server; },
    automationTick: async (args) => { calls.push({ stage: 'tick', args }); return { status: 'ok', networkExecuted: true, sources: [{ id: 'demo' }], errors: [] }; },
    startAutomation: (args) => { calls.push({ stage: 'watch', args }); return { stop() { calls.push({ stage: 'stop-watch' }); } }; } } };
}
test('真实配置加载器预检九维Review接线：不写状态、不启动、不查询、不发送、不泄露凭据', async (t) => {
  const f = await fixture(t), before = snapshot(f.root), stub = stubRuntime();
  const result = await runCentralSetup(f.options, stub.runtime);
  assert.equal(result.status, 'ready', JSON.stringify(result.steps)); assert.equal(result.mode, 'read-only');
  assert.deepEqual(stub.calls, []); assert.deepEqual(snapshot(f.root), before);
  assert.equal(result.networkExecuted, false); assert.equal(result.messagesSent, false);
  assert.equal(result.environment.find((e) => e.name === 'TOKEN').present, true);
  assert.equal(result.environment.find((e) => e.name === 'GROUP_WEBHOOK').required, false);
  assert(!JSON.stringify(result).includes('UNIQUE_CI_SECRET_NEVER_PRINT'));
  assert(!JSON.stringify(result).includes('BEGIN PRIVATE KEY'));
  assert(result.filePins.some((p) => p.role === 'runtime' && /^[a-f0-9]{64}$/.test(p.sha256)));
  assert(result.steps.some((s) => s.id === 'external-acceptance' && s.status === 'unverified'));
});
test('摘要确认后单次启动复用实际入口，默认 send=false，并关闭本次监听', async (t) => {
  const f = await fixture(t), stub = stubRuntime(), plan = planCentralSetup(f.options);
  const result = await runCentralSetup({ ...f.options, start: true, expectPlanHash: plan.planHash }, stub.runtime);
  assert.equal(result.status, 'completed'); assert.deepEqual(stub.calls.map((c) => c.stage), ['serve', 'tick', 'stop-control']);
  assert.equal(stub.calls[1].args.send, false); assert.equal(stub.calls[1].args.env, f.options.env);
  assert.equal(stub.calls[0].args.host, '127.0.0.1'); assert.equal(result.execution.controlListening, false);
  assert.equal(result.execution.fieldAcceptance, 'pending');
});
test('明确 watch 后提供可取消句柄，取消同时停止调度和自己的监听', async (t) => {
  const f = await fixture(t), stub = stubRuntime(), options = { ...f.options, watch: true }, plan = planCentralSetup(options);
  const result = await runCentralSetup({ ...options, start: true, expectPlanHash: plan.planHash }, stub.runtime);
  assert.equal(result.status, 'started'); assert.deepEqual(stub.calls.map((c) => c.stage), ['serve', 'watch']);
  assert.equal(stub.calls[1].args.send, false); await result.stop(); await result.stop();
  assert.deepEqual(stub.calls.map((c) => c.stage), ['serve', 'watch', 'stop-watch', 'stop-control']);
});
test('没有确认摘要、确认后配置变化或Gate版本漂移均零启动', async (t) => {
  const f = await fixture(t), stub = stubRuntime(), plan = planCentralSetup(f.options);
  assert.equal((await runCentralSetup({ ...f.options, start: true }, stub.runtime)).status, 'blocked');
  f.a.intervalSeconds = 90; write(f.automationConfigFile, f.a);
  const stale = await runCentralSetup({ ...f.options, start: true, expectPlanHash: plan.planHash }, stub.runtime);
  assert.equal(stale.status, 'blocked'); assert(stale.steps.some((s) => s.id === 'confirmation'));
  const wrongVersion = planCentralSetup({ ...f.options, expectedGateVersion: '0.0.0' }); assert.equal(wrongVersion.status, 'blocked');
  assert.deepEqual(stub.calls, []);
});
test('模板占位、缺少CI凭据和错误来源映射分别给责任人与下一步，失败不启动', async (t) => {
  const f = await fixture(t), stub = stubRuntime();
  const original = read(f.c.governanceConfigFile); write(f.c.governanceConfigFile, { ...original, issuer: 'REPLACE_APPROVED_ISSUER' });
  const template = await runCentralSetup({ ...f.options, start: true, expectPlanHash: 'a'.repeat(64) }, stub.runtime);
  assert.equal(template.status, 'blocked'); assert.match(template.steps.find((s) => s.id === 'governance').detail, /占位符/);
  write(f.c.governanceConfigFile, original);
  const absent = planCentralSetup({ ...f.options, env: { WL_REVIEW_PRIVATE_KEY_FILE: f.options.env.WL_REVIEW_PRIVATE_KEY_FILE } });
  assert.match(absent.steps.find((s) => s.id === 'automation').detail, /TOKEN/);
  f.a.sources[0].actors['15'] = 'reviewer'; write(f.automationConfigFile, f.a);
  const actor = planCentralSetup(f.options); assert.match(actor.steps.find((s) => s.id === 'automation').detail, /允许作者/);
  assert.deepEqual(stub.calls, []); assert(template.nextActions.every((a) => a.owner && a.action));
});
test('正式Review发布目录、项目策略或治理台账路径串线均阻断', async (t) => {
  const f = await fixture(t); f.p.manifestDir = path.join(f.root, 'wrong-delivery'); write(f.reviewPublishConfigFile, f.p);
  const delivery = planCentralSetup(f.options); assert.match(delivery.steps.find((s) => s.id === 'publisher').detail, /回流目录/);
  f.p.manifestDir = f.a.sources[0].review.publication.manifestDir; f.p.projects.demo.policyHash = 'f'.repeat(64); write(f.reviewPublishConfigFile, f.p);
  const policy = planCentralSetup(f.options); assert.match(policy.steps.find((s) => s.id === 'publisher').detail, /批准摘要/);
  f.a.stateFile = path.join(f.root, 'different-ledger.json'); write(f.automationConfigFile, f.a);
  const state = planCentralSetup(f.options); assert.match(state.steps.find((s) => s.id === 'automation').detail, /台账/);
});
test('丢失配套台账、配置身份变化、活锁均不能重置或自动删除', async (t) => {
  const f = await fixture(t); mkdirSync(f.a.dataDir);
  const config = loadAutomationConfig(f.automationConfigFile), binding = hash(stableStringify({ ...config, governance: config.governance }));
  const file = path.join(f.a.dataDir, 'automation-state.json');
  write(file, { schemaVersion: 1, binding, runs: {}, history: [], health: {} });
  let result = planCentralSetup(f.options); assert.match(result.steps.find((s) => s.id === 'states').detail, /台账缺失/);
  write(file, { schemaVersion: 1, binding: 'f'.repeat(64), runs: {}, history: [], health: {} });
  result = planCentralSetup(f.options); assert.match(result.steps.find((s) => s.id === 'states').detail, /配置身份变化/);
  write(file, { schemaVersion: 1, binding, runs: {}, history: [], health: {} });
  const fileBytes = readFileSync(file); assert.deepEqual(readFileSync(file), fileBytes);
  const lock = f.c.stateFile + '.lock'; mkdirSync(lock);
  write(f.c.stateFile, readGovernanceState({ configFile: f.c.governanceConfigFile, stateFile: f.c.stateFile }));
  result = planCentralSetup(f.options); assert.equal(result.status, 'blocked'); assert.match(result.steps.find((s) => s.id === 'states').detail, /锁/); assert(existsSync(lock));
  assert.deepEqual(readFileSync(file), fileBytes);
});
test('显式发送之前检查全部消息环境变量；默认预览不要求群凭据', async (t) => {
  const f = await fixture(t); assert.equal(planCentralSetup(f.options).status, 'ready');
  const missing = planCentralSetup({ ...f.options, send: true }); assert.equal(missing.status, 'blocked');
  assert.match(missing.steps.find((s) => s.id === 'notifications').detail, /GROUP_WEBHOOK/);
  const env = { ...f.options.env, GROUP_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/hidden-hook-id', GROUP_SECRET: 'UNIQUE_GROUP_SECRET_NEVER_PRINT' };
  const ready = planCentralSetup({ ...f.options, send: true, env }); assert.equal(ready.status, 'ready', JSON.stringify(ready.steps));
  assert(!JSON.stringify(ready).includes('hidden-hook-id')); assert(!JSON.stringify(ready).includes('UNIQUE_GROUP_SECRET_NEVER_PRINT'));
});
test('独立签发可明确留在独立环境，但不能冒称已完成签发验收', async (t) => {
  const f = await fixture(t); const result = planCentralSetup({ ...f.options, reviewPublishConfigFile: null, env: { TOKEN: 'read-only-token' } });
  assert.equal(result.status, 'ready', JSON.stringify(result.steps));
  assert(result.steps.some((s) => s.id === 'publisher-external' && s.status === 'unverified'));
  assert(!result.filePins.some((p) => p.file.endsWith('review-private.pem')));
});
test('符号链接与缺失批准证据根阻断；不会创建目录或转写目标', async (t) => {
  const f = await fixture(t), alias = path.join(f.root, 'linked-automation.json'); symlinkSync(f.automationConfigFile, alias);
  const linked = planCentralSetup({ ...f.options, automationConfigFile: alias }); assert.equal(linked.status, 'blocked');
  assert.match(linked.steps.find((s) => s.id === 'automation').detail, /符号链接/);
  f.c.reviewPolicies.demo.evidenceRoot = path.join(f.root, 'not-provisioned'); write(f.controlConfigFile, f.c);
  const missing = planCentralSetup(f.options); assert.match(missing.steps.find((s) => s.id === 'control').detail, /目录不存在/);
  assert(!existsSync(f.c.reviewPolicies.demo.evidenceRoot));
});
test('采集启动故障清理自身监听，反馈实际失败且保留状态文件', async (t) => {
  const f = await fixture(t), stub = stubRuntime(), plan = planCentralSetup(f.options), before = snapshot(f.root);
  stub.runtime.automationTick = async () => { throw new Error('provider-unreachable'); };
  const result = await runCentralSetup({ ...f.options, start: true, expectPlanHash: plan.planHash }, stub.runtime);
  assert.equal(result.status, 'attention'); assert.equal(result.execution.controlListening, false);
  assert.deepEqual(stub.calls.map((c) => c.stage), ['serve', 'stop-control']); assert.deepEqual(snapshot(f.root), before);
});
test('真实本地操作监听 + 实际automation单周期：只隔离CI发现，不发送并自动结束监听', async (t) => {
  const f = await fixture(t), reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const options = { ...f.options, port }, plan = planCentralSetup(options);
  let realTick;
  const result = await runCentralSetup({ ...options, start: true, expectPlanHash: plan.planHash }, {
    automationTick: async (args) => { realTick = await automationTick({ ...args, now: Date.parse('2026-10-15T03:00:00Z'),
      discoverImpl: async () => ({ runs: [], discoveryErrors: [], attemptedRecheckRunIds: [], partial: false }),
      fetchImpl: async () => { assert.fail('隔离验收不能访问真实CI或消息渠道'); } }); return realTick; },
  });
  assert.equal(result.status, 'completed', JSON.stringify(realTick)); assert.equal(result.messagesSent, false);
  assert(existsSync(f.c.stateFile)); assert(existsSync(path.join(f.a.dataDir, 'automation-state.json')));
  assert.equal(result.execution.controlListening, false); assert.equal(realTick.errors.length, 0);
  const resumed = planCentralSetup(options); assert.equal(resumed.status, 'ready', JSON.stringify(resumed.steps));
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve) => reservation.close(resolve));
});
test('同批两个CI来源均给检查反馈，不能第一个失败就漏掉另一个', async (t) => {
  const f = await fixture(t);
  const secondFile = path.join(f.root, 'broken-second-ci.json'); write(secondFile, { schemaVersion: 1, system: 'unknown' });
  f.a.sources.push({ ...f.a.sources[0], id: 'second', configFile: secondFile }); write(f.automationConfigFile, f.a);
  const result = planCentralSetup({ ...f.options, env: { WL_REVIEW_PRIVATE_KEY_FILE: f.options.env.WL_REVIEW_PRIVATE_KEY_FILE } });
  assert.equal(result.status, 'blocked');
  assert.match(result.steps.find((s) => s.id === 'source:demo-standard').detail, /TOKEN/);
  assert.match(result.steps.find((s) => s.id === 'source:second').detail, /CI采集配置身份/);
});
test('AbortSignal在确认后取消，不会启动；持续运行可由signal清理', async (t) => {
  const f = await fixture(t), stub = stubRuntime(), signal = new AbortController();
  signal.abort(); const options = { ...f.options, watch: true }, plan = planCentralSetup(options);
  const cancelled = await runCentralSetup({ ...options, start: true, expectPlanHash: plan.planHash, signal: signal.signal }, stub.runtime);
  assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(stub.calls, []);
  const active = new AbortController(); const running = await runCentralSetup({ ...options, start: true, expectPlanHash: plan.planHash, signal: active.signal }, stub.runtime);
  assert.equal(running.status, 'started'); active.abort(); await running.stop();
  assert.deepEqual(stub.calls.map((c) => c.stage), ['serve', 'watch', 'stop-watch', 'stop-control']);
});
test('正式Review回流checkpoint损坏与配置外观相同但文件变化都会显式拦截', async (t) => {
  const f = await fixture(t), plan = planCentralSetup(f.options), stub = stubRuntime();
  writeFileSync(f.reviewCiFile, readFileSync(f.reviewCiFile, 'utf8') + '\n');
  const changed = await runCentralSetup({ ...f.options, start: true, expectPlanHash: plan.planHash }, stub.runtime);
  assert.equal(changed.status, 'blocked'); assert.deepEqual(stub.calls, []);
  const directory = path.join(f.a.dataDir, 'formal-reviews', 'demo-standard'); mkdirSync(directory, { recursive: true });
  write(path.join(directory, 'publication-state.json'), { schemaVersion: 1, binding: 'f'.repeat(64), records: {}, canonical: {} });
  const damaged = planCentralSetup(f.options); assert.equal(damaged.status, 'blocked');
  assert.match(damaged.steps.find((s) => s.id === 'states').detail, /正式Review回流checkpoint/);
});
test('真实调度停止等待当前采集、发送和异步结果回调完成；停止返回后不再写账、发送或排新周期', async (t) => {
  const f = await fixture(t), stub = stubRuntime(), now = Date.parse('2026-10-15T03:00:00Z');
  const env = { ...f.options.env, GROUP_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/drain-test', GROUP_SECRET: 'fixture-group-secret' };
  const options = { ...f.options, env, watch: true, send: true }, plan = planCentralSetup(options);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.steps));
  let releaseDiscovery, releaseHandler, discovered = 0, sent = 0, reported = 0, stopped = false;
  let handlerEntered; const handlerReady = new Promise((resolve) => handlerEntered = resolve);
  const timers = t.mock.method(globalThis, 'setTimeout');
  const result = await runCentralSetup({ ...options, start: true, expectPlanHash: plan.planHash,
    onResult: async () => { reported++; handlerEntered(); await new Promise((resolve) => releaseHandler = resolve); },
  }, { serveControl: stub.runtime.serveControl, startAutomation: (args) => startAutomation({ ...args, now,
    discoverImpl: () => { discovered++; return new Promise((resolve) => releaseDiscovery = resolve); },
    fetchImpl: async (url, init) => { assert.equal(url, env.GROUP_WEBHOOK); assert.equal(init.method, 'POST'); sent++; return new Response(JSON.stringify({ code: 0 })); },
  }) });
  assert.equal(result.status, 'started'); assert.equal(discovered, 1); assert.equal(typeof releaseDiscovery, 'function');
  const drain = result.stop().then(() => stopped = true); await new Promise(setImmediate);
  assert.equal(stopped, false); assert.equal(stub.calls.at(-1).stage, 'stop-control');
  releaseDiscovery({ runs: [{ runId: 45, sha: 'b'.repeat(40), ref: 'dev', pipelineUrl: 'https://ci.example.invalid/p/45', dueAt: new Date(now - 1000).toISOString(),
    status: 'success', terminal: true, authorId: 'author', missingJobs: ['quality'] }], discoveryErrors: [], attemptedRecheckRunIds: [] });
  await handlerReady; assert.equal(stopped, false); assert(sent > 0); releaseHandler(); await drain;
  const saved = snapshot(f.root), counts = { discovered, sent, reported }; await result.stop(); await new Promise(setImmediate);
  assert.equal(stopped, true); assert.deepEqual({ discovered, sent, reported }, counts); assert.deepEqual(snapshot(f.root), saved);
  assert.equal(timers.mock.calls.filter((call) => call.arguments[1] === 60000).length, 0);
});
test('忙锁、失败周期与失败结果回调停止时均被收敛，不产生未处理拒绝或新周期', async (t) => {
  const f = await fixture(t); mkdirSync(f.a.dataDir);
  const corrupt = path.join(f.a.dataDir, 'automation-state.json'); write(corrupt, { schemaVersion: 999 });
  const unexpected = [], delivered = []; const listener = (error) => unexpected.push(error);
  process.on('unhandledRejection', listener); t.after(() => process.removeListener('unhandledRejection', listener));
  const failed = startAutomation({ configFile: f.automationConfigFile, onResult: (value) => delivered.push(value) });
  const result = await failed.stop(); assert.equal(result.status, 'attention'); assert.equal(delivered.length, 1);
  const failedHandler = startAutomation({ configFile: f.automationConfigFile, onResult: async () => { throw new Error('fixture-result-handler-failed'); } });
  const handlerResult = await failedHandler.stop(); assert.equal(handlerResult.status, 'attention'); assert.equal(handlerResult.stage, 'result-handler');
  const lock = corrupt + '.lock'; mkdirSync(lock); write(path.join(lock, 'owner.json'), { schemaVersion: 1, kind: 'central-json-lock', stateFile: corrupt, pid: process.pid,
    hostname: (await import('node:os')).hostname(), nonce: (await import('node:crypto')).randomUUID(), start: new Date().toISOString() });
  const busy = startAutomation({ configFile: f.automationConfigFile, onResult: (value) => delivered.push(value) });
  const busyResult = await busy.stop(); assert.equal(busyResult.status, 'attention'); assert.match(busyResult.reason, /活锁/);
  await new Promise(setImmediate); assert.deepEqual(unexpected, []); assert(existsSync(lock));
});
