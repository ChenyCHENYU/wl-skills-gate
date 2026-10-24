import { stableStringify } from './util.js';

const levels = ['blocker', 'error', 'warning', 'info'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const counts = report => Object.fromEntries(levels.map(level => [level, report.findings.filter(f => f.severity === level).length]));
const sorted = values => [...values].sort();
const same = (a, b) => stableStringify(a) === stableStringify(b);
const checkScope = check => Object.fromEntries(['mode', 'targets', 'requestedFiles', 'scannedFiles', 'ignoredFiles', 'ignoredDirectories', 'sourceExclusions'].filter(key => check.coverage?.[key] !== undefined).map(key => [key, Array.isArray(check.coverage[key]) ? sorted(check.coverage[key]) : check.coverage[key]]));

// Counts or a vanished rule/file are observations, never proof that a repair
// ran. Keep this deliberately separate from authorized repair / issue closure.
export function compareNotificationScans(before, after, targets = []) {
  const reasons = [];
  const reject = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  for (const report of [before, after]) {
    if (!report?.run || !Array.isArray(report.findings)) reject('扫描原件缺失');
    if (!Array.isArray(report?.checks) || !report.checks.length || report.checks.some(check => !check?.checkId || !check.toolVersion || check.status !== 'ok' || check.toolVersionVerified !== true || check.coverage?.complete === false)) reject('检查未有效完成');
    if (!report?.run?.project || !report?.run?.stage || !report?.run?.profile) reject('扫描项目与阶段信息缺失');
    if (!report?.run?.eventId || !digest(report?.run?.sourceDigest)) reject('缺少源码与运行标识');
    if (!Array.isArray(report?.findings) || report.findings.some(f => !digest(f?.fingerprint) || !levels.includes(f?.severity)) || new Set(report?.findings?.map(f => f?.fingerprint)).size !== report?.findings?.length) reject('问题指纹不完整或重复');
  }
  if (!Array.isArray(targets) || targets.some(f => !digest(f?.fingerprint)) || new Set(targets.map(f => f?.fingerprint)).size !== targets.length) reject('关注问题指纹缺失或重复');
  if (reasons.length) return { comparable: false, reasons, repaired: null, closed: false, label: '修复未核验' };
  for (const key of ['project', 'stage', 'profile', 'scope', 'base', 'head', 'targetEnv']) if (!same(before.run[key] ?? null, after.run[key] ?? null)) reject('项目、阶段或检查范围不同');
  for (const report of [before, after]) {
    const ids = report.checks.map(check => check.checkId), required = report.policy?.requiredCheckIds;
    if (!Array.isArray(required) || !required.length || new Set(required).size !== required.length || required.some(id => !ids.includes(id)) || new Set(ids).size !== ids.length || !report.policy?.lockedToolVersions || !Object.keys(report.policy.lockedToolVersions).length) reject('必需检查或锁定版本不完整');
  }
  for (const key of ['policyHash', 'ruleSetHash', 'baselineHash', 'waiversHash']) if (!digest(before.policy?.[key]) || before.policy[key] !== after.policy?.[key]) reject('规则或治理配置已变化');
  if (!same(before.policy?.lockedToolVersions, after.policy?.lockedToolVersions) || !same(sorted(before.policy?.requiredCheckIds || []), sorted(after.policy?.requiredCheckIds || []))) reject('检查工具或必需项目已变化');
  const checks = report => report.checks.map(check => ({ id: check.checkId, version: check.toolVersion, scope: checkScope(check) })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!same(checks(before), checks(after))) reject('两轮实际检查内容或文件集合不同');
  const finished = Date.parse(before.run.finishedAt), started = Date.parse(after.run.startedAt);
  if (before.run.eventId === after.run.eventId || !Number.isFinite(finished) || !Number.isFinite(started) || started < finished) reject('缺少按时间顺序产生的独立复扫');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(before.run.commitSha || '') || before.run.commitSha !== after.run.commitSha) reject('候选提交已变化，不能据数量推断修复');
  const original = new Set(before.findings.map(f => f.fingerprint));
  if (targets.some(f => !digest(f.fingerprint) || !original.has(f.fingerprint))) reject('关注问题不属于本轮原件');
  if (reasons.length) return { comparable: false, reasons, repaired: null, closed: false, label: '修复未核验' };
  const current = new Set(after.findings.map(f => f.fingerprint));
  const absent = before.findings.filter(f => !current.has(f.fingerprint)).map(f => f.fingerprint);
  const added = after.findings.filter(f => !original.has(f.fingerprint)).map(f => f.fingerprint);
  const targetAbsent = targets.filter(f => !current.has(f.fingerprint)).map(f => f.fingerprint);
  const sameSource = before.run.sourceDigest === after.run.sourceDigest;
  return { comparable: true, beforeCounts: counts(before), afterCounts: counts(after), absent, added, targetAbsent, sameSource, repaired: null, closed: false,
    label: sameSource ? '同一源码复扫，不能认定执行过修复' : '复扫观测，修复未核验' };
}
