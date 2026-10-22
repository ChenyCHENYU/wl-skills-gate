import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readControlledJson, lockedJson } from './control-store.js';
import { digest } from './jenkins-integration.js';
import { stableStringify } from './util.js';
import { inspectJenkinsReadiness } from './jenkins-readiness.js';
import { nativePipelineEntry } from './jenkins-entry-contract.js';
import { jobContract } from './jenkins-job-config.js';
import { fleetClient, jobPath } from './jenkins-fleet-client.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => digest(stableStringify(value));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_ATTEMPTS = 3, REPORT_AGE = 30 * 60 * 1000, NEW_CLAIM_GRACE = 60 * 1000;
const params = run => {
  const rows = (Array.isArray(run?.actions) ? run.actions : []).flatMap(a => Array.isArray(a?.parameters) ? a.parameters : []);
  const values = name => rows.filter(p => p?.name === name).map(p => p.value);
  const dispatch = values('WL_GATE_DISPATCH_ID'), sha = values('WL_REVIEW_SHA');
  return dispatch.length === 1 && sha.length === 1 ? { dispatchId: dispatch[0], sha: sha[0] } : null;
};
const matches = (run, record) => { const p = params(run); return p?.dispatchId === record.dispatchId && p.sha === record.sha; };
const context = async clusterFile => {
  // The main operations module re-exports this module. Resolve context only
  // inside calls, after module initialization, to avoid a cyclic startup read.
  const { opsContext } = await import('./jenkins-ops.js');
  assert(typeof opsContext === 'function', '运维上下文入口未准备');
  return opsContext(clusterFile);
};
const publicRecord = (record, status, extra = {}) => ({ status, job: record.job, sha: record.sha, dispatchId: record.dispatchId, attempt: record.attempt,
  ...(record.buildNumber ? { buildNumber: record.buildNumber } : {}), ...extra });

function assertState(state) {
  assert(state?.schemaVersion === 1 && state.claims && typeof state.claims === 'object' && !Array.isArray(state.claims), 'CHECK承接台账损坏；先恢复真实台账，不能忽略历史重新触发');
}
function assertRecord(record) {
  assert(record && ['claimed', 'started'].includes(record.status) && UUID.test(record.dispatchId || '') && UUID.test(record.runId || '')
    && /^[a-f0-9]{24}$/.test(record.key || '') && SHA.test(record.sha || '') && Number.isInteger(record.attempt) && record.attempt >= 1 && record.attempt <= MAX_ATTEMPTS
    && Number.isFinite(Date.parse(record.claimedAt)) && Array.isArray(record.history), '已有CHECK启动记录不完整；需人工核对，不能盲目重新触发');
}

async function currentJob(client, c, project, binding) {
  const xml = await client.config(project.checkJob);
  assert(xml && digest(xml) === project.configHash, 'CHECK实际Job配置已漂移或无法读取，重新巡检后再承接');
  const actual = jobContract(xml);
  const triggers = actual.triggers.filter(v => v.type === 'com.dabsquared.gitlabjenkins.GitLabPushTrigger');
  assert(actual.script === nativePipelineEntry(c.nativeEntry).trim() && actual.sandbox === 'true' && actual.disabled === 'false'
    && triggers.length === 1 && triggers[0].fields.includeBranchesSpec === binding.branch && triggers[0].fields.triggerOnPush === 'true'
    && triggers[0].fields.branchFilterType === 'NameBasedFilter', 'CHECK实际受控入口、运行状态或目标分支触发已变化，重新巡检');
  for (const name of ['WL_REVIEW_SHA', 'WL_GATE_DISPATCH_ID']) assert(actual.parameters.filter(p => p.name === name && p.type === 'hudson.model.StringParameterDefinition').length === 1, 'CHECK缺少唯一受控候选SHA或启动追踪参数，不能承接');
}

async function fetchRun(client, job, number) {
  const response = await client.request('GET', `${jobPath(job)}${number}/api/json?tree=number,building,result,actions[parameters[name,value]],artifacts[fileName,relativePath]`);
  if (response.status !== 200) return null;
  try { const run = JSON.parse(response.body); return String(run.number) === String(number) ? run : null; } catch { return null; }
}
async function reconcileUnknown(client, record) {
  try {
    const data = await client.json(`${jobPath(record.job)}api/json?tree=builds[number,building,result,actions[parameters[name,value]],artifacts[fileName,relativePath]]{0,25}`);
    if (!Array.isArray(data.builds) || data.builds.length > 25) return { status: 'unknown', reason: '未取得完整的近期CHECK记录；不自动重复启动' };
    const found = data.builds.filter(run => matches(run, record));
    if (found.length !== 1 || !/^[1-9][0-9]*$/.test(String(found[0]?.number || ''))) return { status: 'unknown', reason: found.length > 1 ? '同一追踪ID匹配多次运行，需人工核对；不自动重发' : '近期运行尚未找到唯一追踪ID与候选SHA；不自动重发', notFound: found.length === 0 };
    record.status = 'started'; record.buildNumber = String(found[0].number); record.reconciledAt = new Date().toISOString();
    return { status: 'found', run: found[0] };
  } catch { return { status: 'unknown', reason: 'Jenkins运行对账未完成；保留本轮启动记录，不自动重发' }; }
}
async function failureKind(client, record, run, project) {
  // Only explicit artifact metadata can establish absence. A broken/read-denied
  // JSON response is not evidence that no quality check ran.
  if (!Array.isArray(run.artifacts)) return 'unverified';
  const reports = run.artifacts.filter(a => a.relativePath === 'quality-reports/quality-summary.json');
  if (!reports.length) return 'execution';
  if (reports.length !== 1) return 'unverified';
  try {
    const response = await client.request('GET', `${jobPath(record.job)}${record.buildNumber}/artifact/quality-reports/quality-summary.json`);
    if (response.status !== 200) return 'unverified';
    const summary = JSON.parse(response.body);
    if (summary?.run?.commitSha !== record.sha || summary.run.project !== project.project || summary.run.stage !== 'ci' || !Array.isArray(summary.findings) || !Array.isArray(summary.checks)) return 'unverified';
    if (summary.findings.length) return 'quality';
    return summary.checks.length && summary.checks.every(check => check.status === 'passed') ? 'execution' : 'unverified';
  } catch { return 'unverified'; }
}

export async function claimOpsCheck({ clusterFile, runId, key, env = process.env, fetchImpl = fetch, now = Date.now(), retryUnknown = false, retryKnownFailure = false }) {
  const { c, bindings } = await context(clusterFile);
  assert(UUID.test(runId || '') && /^[a-f0-9]{24}$/.test(key || ''), '需要本轮巡检身份');
  const instant = typeof now === 'function' ? now() : now;
  assert(Number.isFinite(instant), 'CHECK承接时间无效');
  const report = readControlledJson(path.join(c.configDir, 'ops-state/runs', runId, 'report.json'));
  const age = instant - Date.parse(report.checkedAt);
  assert(report.kind === 'jenkins-ops-report' && report.schemaVersion === 1 && report.runId === runId && report.clusterHash === c.configHash
    && report.jenkinsOrigin === c.jenkinsOrigin && Number.isFinite(age) && age >= 0 && age <= REPORT_AGE, '巡检报告不属于当前集群或已超过30分钟，重新巡检后再承接');
  const projects = Array.isArray(report.projects) ? report.projects.filter(p => p.key === key) : [], p = projects.length === 1 ? projects[0] : null;
  const bound = bindings.find(b => b.binding.id === p?.bindingId && b.registryFile === p?.registryFile);
  const awaitingReconcile = p?.status === 'attention' && p.gaps?.length === 1 && p.gaps[0].id === 'CHECK-DISPATCH-UNKNOWN';
  assert(Array.isArray(report.globalGaps) && report.globalGaps.length === 0 && p && Array.isArray(p.gaps) && (p.status === 'ready' && !p.gaps.length || awaitingReconcile)
    && p.pinsVerified && p.entryVerified && bound && p.checkJob === bound.binding.jobs.check && p.job === p.checkJob && hash(bound.binding) === p.bindingHash
    && SHA.test(p.sha || '') && /^[a-f0-9]{64}$/.test(p.configHash || ''), '仅本轮实际核验且已登记的CHECK可承接；不会启动旧部署或BUILD');
  assert(inspectJenkinsReadiness({ clusterFile: c.file }).status === 'handover-files-ready', '承接前工程配置变化，重新巡检');
  const client = fleetClient({ origin: c.jenkinsOrigin, env, fetchImpl });
  await currentJob(client, c, p, bound.binding);
  return lockedJson(path.join(c.configDir, 'ops-state/checks.json'), { schemaVersion: 1, kind: 'jenkins-ops-checks', claims: {} }, async state => {
    assertState(state);
    const id = hash({ job: p.checkJob, sha: p.sha, binding: p.bindingHash }), old = state.claims[id];
    let canRetry = false;
    if (old) {
      assertRecord(old);
      assert(old.job === p.checkJob && old.sha === p.sha && old.bindingHash === p.bindingHash, 'CHECK历史记录与当前批准范围不一致');
      let run;
      if (old.status === 'claimed') {
        const reconciliation = await reconcileUnknown(client, old);
        if (reconciliation.status === 'found') run = reconciliation.run;
        else {
          const claimAge = instant - Date.parse(old.claimedAt);
          if (!(retryUnknown === true && reconciliation.notFound && claimAge >= NEW_CLAIM_GRACE)) return publicRecord(old, 'unknown', { reason: retryUnknown && claimAge < NEW_CLAIM_GRACE ? '新启动仍在一分钟观察窗口内，先等待并核对队列；不重复启动' : reconciliation.reason });
          canRetry = true;
        }
      } else {
        try { run = await fetchRun(client, old.job, old.buildNumber); } catch {}
        if (!run || !matches(run, old)) return publicRecord(old, 'unknown', { reason: '实际CHECK运行未唯一核验追踪ID与候选SHA；不自动重复启动' });
      }
      if (run) {
        if (run.building === true || run.result === 'SUCCESS') return publicRecord(old, 'already-started', { building: run.building === true, result: run.result || null });
        if (run.building !== false || !['FAILURE', 'ABORTED'].includes(run.result)) return publicRecord(old, 'unknown', { reason: '实际运行尚未取得明确的终止结果；不自动重复启动' });
        const kind = await failureKind(client, old, run, p);
        old.lastResult = run.result; old.failureKind = kind;
        if (kind === 'quality') return publicRecord(old, 'quality-failed', { reason: '本候选已有真实代码问题；修复并提交新版本后再检查，不重复刷同一候选' });
        if (awaitingReconcile && retryUnknown !== true) return publicRecord(old, 'failed-needs-confirmation', { reason: '已核对到终止失败；本轮仅允许对账，确认修复执行环境后显式重试' });
        if (kind !== 'execution' && retryKnownFailure !== true) return publicRecord(old, 'failed-needs-confirmation', { reason: '已确认运行失败，但未能排除质量失败；查看原件后显式重试' });
        canRetry = true;
      }
      if (canRetry && old.attempt >= MAX_ATTEMPTS) return publicRecord(old, 'retry-limit', { reason: '同一候选已达到三次启动上限；查看实际CHECK原件，修复后由责任人明确处理' });
    } else assert(!awaitingReconcile, '本轮只有待对账缺项，却没有实际启动台账；恢复台账后再处理');
    const record = { status: 'claimed', runId, key, job: p.checkJob, sha: p.sha, bindingHash: p.bindingHash, dispatchId: randomUUID(), claimedAt: new Date(instant).toISOString(), attempt: old ? old.attempt + 1 : 1,
      history: old ? [...old.history, Object.fromEntries(Object.entries(old).filter(([k]) => k !== 'history'))] : [] };
    state.claims[id] = record;
    // lockedJson fsyncs this record before this function returns. The caller
    // may submit exactly this dispatchId/SHA, then acknowledge the actual run.
    return publicRecord(record, 'claimed');
  });
}

export async function acknowledgeOpsCheck({ clusterFile, runId, key, buildNumber, dispatchId }) {
  const { c } = await context(clusterFile);
  assert(UUID.test(runId || '') && /^[a-f0-9]{24}$/.test(key || ''), '需要本轮巡检身份');
  assert(/^[1-9][0-9]*$/.test(String(buildNumber || '')), 'CHECK启动须记录实际Jenkins运行编号');
  return lockedJson(path.join(c.configDir, 'ops-state/checks.json'), { schemaVersion: 1, kind: 'jenkins-ops-checks', claims: {} }, state => {
    assertState(state);
    const rows = Object.values(state.claims).filter(v => v.runId === runId && v.key === key && ['claimed', 'started'].includes(v.status));
    assert(rows.length === 1, '不存在唯一待确认的本轮CHECK启动记录');
    const record = rows[0]; assertRecord(record);
    if (dispatchId !== undefined) assert(UUID.test(dispatchId || '') && dispatchId === record.dispatchId, '迟到或其他dispatchId不能确认当前CHECK启动；先对账实际运行');
    assert(record.status !== 'started' || record.buildNumber === String(buildNumber), '本轮已确认其他实际运行编号，不能覆盖');
    record.status = 'started'; record.buildNumber = String(buildNumber);
    return publicRecord(record, 'started');
  });
}
