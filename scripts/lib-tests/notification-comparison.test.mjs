import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareNotificationScans } from '../../lib/notification-comparison.js';

const hash = n => String(n).repeat(64);
function fixture() {
  const before = {
    run: { project: 'produce', stage: 'local-hook', profile: 'fast', scope: 'staged', commitSha: 'a'.repeat(40), eventId: 'one', sourceDigest: hash(1), startedAt: '2026-10-24T01:00:00Z', finishedAt: '2026-10-24T01:01:00Z' },
    findings: [{ fingerprint: hash(4), severity: 'error', ruleId: 'SEC/XSS', file: 'src/a.ts', line: 3 }],
    policy: { policyHash: hash(5), ruleSetHash: hash(6), baselineHash: hash(7), waiversHash: hash(8), requiredCheckIds: ['SEC'], lockedToolVersions: { SEC: '1.0' } },
    checks: [{ checkId: 'SEC', status: 'ok', toolVersion: '1.0', toolVersionVerified: true, coverage: { complete: true, mode: 'staged', requestedFiles: ['src/a.ts'], scannedFiles: ['src/a.ts'] } }],
  };
  const after = structuredClone(before); Object.assign(after.run, { eventId: 'two', sourceDigest: hash(2), startedAt: '2026-10-24T01:02:00Z', finishedAt: '2026-10-24T01:03:00Z' }); after.findings = [];
  return [before, after];
}
test('同候选同范围有效复扫只报告指纹未检出，不能仅靠数量声称修复或关闭', () => {
  const [before, after] = fixture(); const immutable = JSON.stringify([before, after]);
  const value = compareNotificationScans(before, after, before.findings);
  assert.equal(value.comparable, true); assert.equal(value.absent.length, 1); assert.equal(value.targetAbsent.length, 1);
  assert.equal(value.repaired, null); assert.equal(value.closed, false); assert.match(value.label, /修复未核验/);
  assert.equal(JSON.stringify([before, after]), immutable);
});
test('同源码重新运行或同rule/file换问题均不能被推断为修复完成', () => {
  const [before, after] = fixture(); after.run.sourceDigest = before.run.sourceDigest;
  const value = compareNotificationScans(before, after); assert.equal(value.sameSource, true); assert.equal(value.repaired, null); assert.match(value.label, /同一源码/);
  after.findings = [{ ...before.findings[0], fingerprint: hash(9), line: 9 }];
  const moved = compareNotificationScans(before, after); assert.equal(moved.absent.length, 1); assert.equal(moved.added.length, 1); assert.equal(moved.repaired, null);
});
test('换SHA、规则、工具、基线、阶段、范围或文件集合时不输出修复对比', () => {
  const cases = [r => r.run.commitSha = 'b'.repeat(40), r => r.policy.policyHash = hash(9), r => r.policy.ruleSetHash = hash(9), r => r.policy.baselineHash = hash(9), r => r.policy.lockedToolVersions.SEC = '2.0', r => r.policy.requiredCheckIds = ['OTHER'], r => r.run.stage = 'ci', r => r.run.scope = 'full', r => r.checks[0].coverage.scannedFiles = ['src/b.ts'], r => r.checks[0].coverage.ignoredFiles = ['src/a.ts']];
  for (const mutate of cases) { const [a, b] = fixture(); mutate(b); const result = compareNotificationScans(a, b); assert.equal(result.comparable, false); assert.equal(result.repaired, null); assert.equal(result.absent, undefined); }
});
test('检查缺失失效、覆盖未完成、运行复用、反向时间及目标不属于原件均不冒充有效复扫', () => {
  const cases = [r => r.checks = [], r => r.checks[0].status = 'invalid', r => r.checks[0].toolVersionVerified = false, r => r.checks[0].coverage.complete = false, r => r.run.eventId = 'one', r => r.run.startedAt = '2026-10-24T00:59:00Z', r => delete r.run.sourceDigest, r => delete r.policy.policyHash];
  for (const mutate of cases) { const [a, b] = fixture(); mutate(b); assert.equal(compareNotificationScans(a, b).comparable, false); }
  const [a, b] = fixture(); assert.equal(compareNotificationScans(a, b, [{ fingerprint: hash(9) }]).comparable, false);
});
test('问题计数、指纹缺失或重复不能伪造观测差异', () => {
  for (const bad of [null, {}, { run: {} }]) assert.equal(compareNotificationScans(bad, bad).comparable, false);
  const [a, b] = fixture(); a.findings.push(a.findings[0]); assert.equal(compareNotificationScans(a, b).comparable, false);
  a.findings = [{ severity: 'error' }]; assert.equal(compareNotificationScans(a, b).comparable, false);
});
test('缺少必需检查、重复检查与空规则版本不能伪造有效比较；重复目标不放大改善数', () => {
  for (const mutate of [r => r.policy.requiredCheckIds.push('MISSING'), r => r.checks.push(r.checks[0]), r => delete r.policy.lockedToolVersions, r => r.findings = [null], r => r.checks = [null]]) {
    const [a, b] = fixture(); mutate(b); assert.equal(compareNotificationScans(a, b).comparable, false);
  }
  const [a, b] = fixture();
  for (const targets of [null, [null], [a.findings[0], a.findings[0]]]) assert.equal(compareNotificationScans(a, b, targets).comparable, false);
});
