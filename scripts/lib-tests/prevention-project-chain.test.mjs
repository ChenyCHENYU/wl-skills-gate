import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { planOnboarding, applyOnboarding } from '../../lib/onboard.js';
import { planWorkspaceInitialization, applyWorkspaceInitialization } from '../../lib/workspace-init.js';
import { snapshotSource } from '../../lib/source-state.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '../..');
const VERSION = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'))).version;
const REGISTRY = 'https://registry.example.invalid/';
const EVIDENCE_ROOT = process.env.WL_PREVENTION_PROJECT_EVIDENCE_ROOT;
const digest = value => createHash('sha256').update(value).digest('hex');
const put = (root, relative, value) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitResult = (root, ...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 90000 });
const bypassCommit = (root, message) => {
  git(root, 'add', '.');
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
};

// This is an integration canary, not a claim that a Java/Vue product has been
// scanned: only package installation and the native checker are fixture inputs.
// Configuration generation, clone, Git dispatch, Gate, review generation,
// mechanical plan/application, rescan and reports use the actual implementation.
function fixture(t, kind) {
  const parent = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'wl-prevention-chain-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source'); mkdirSync(source);
  git(source, 'init', '-q'); git(source, 'config', 'user.name', 'canary'); git(source, 'config', 'user.email', 'canary@example.invalid');
  if (kind === 'frontend') put(source, 'package.json', {
    name: 'wl-ui-produce-canary', private: true, packageManager: 'pnpm@10.34.5', dependencies: { vue: '3.5.0' },
    devDependencies: { '@agile-team/wl-skills-kit': '2.33.1', 'vue-tsc': '3.0.0' },
  });
  else {
    put(source, 'pom.xml', '<project><modelVersion>4.0.0</modelVersion><profiles><profile><id>wl-quality-audit</id></profile><profile><id>wl-quality-unit</id></profile></profiles></project>\n');
    put(source, 'wl-produce-pl/wl-produce-pl-service/pom.xml', '<project><artifactId>wl-produce-pl-service</artifactId></project>\n');
  }
  put(source, 'src/canary.txt', 'safe\n');
  bypassCommit(source, 'fixture: initial source');
  const options = { root: source, kind, registry: REGISTRY };
  const plan = planOnboarding(options);
  assert.equal(plan.hardConflicts.length, 0, JSON.stringify(plan.hardConflicts));
  const applied = applyOnboarding({ ...options, planHash: plan.planHash, confirm: true });
  assert.equal(applied.status, 'configuration-applied');
  const manifest = JSON.parse(readFileSync(path.join(source, 'quality/workspace.json')));
  assert.equal(manifest.gateVersion, VERSION);
  assert.equal(manifest.dependencyDirectory, kind === 'frontend' ? '.' : 'quality-tools');

  // The project owner approves this deterministic canary policy before committing
  // adoption; new-clone initialization must preserve it rather than regenerate it.
  rmSync(path.join(source, 'quality/policy.yml'));
  put(source, 'quality/policy.json', {
    schemaVersion: 1, project: kind === 'frontend' ? 'wl-ui-produce-canary' : 'wl-produce-canary', releaseRequires: ['CANARY'],
    checks: [{ id: 'CANARY', tool: 'cmd-json', command: 'node scripts/quality/canary-scan.mjs', versionCommand: 'node scripts/quality/canary-scan.mjs --version', profiles: ['fast', 'standard', 'release'] }],
    fixers: [{ id: 'mechanical-canary', ruleIds: ['CANARY/UNSAFE'], files: ['src/canary.txt'], command: 'node scripts/quality/canary-fix.mjs' }],
  });
  put(source, 'quality/rules.lock.json', { lockVersion: 1, 'wl-skills-gate': VERSION, tools: { CANARY: 'canary-checker@1.0.0' } });
  if (kind === 'backend') {
    const policy = JSON.parse(readFileSync(path.join(source, 'quality/review-policy.json'))); policy.project = 'wl-produce-canary';
    put(source, 'quality/review-policy.json', policy);
  }
  const evidencePlan = JSON.parse(readFileSync(path.join(source, 'quality/review-evidence.plan.json')));
  evidencePlan.project = kind === 'frontend' ? 'wl-ui-produce-canary' : 'wl-produce-canary'; evidencePlan.requiredTestCheckIds = [];
  put(source, 'quality/review-evidence.plan.json', evidencePlan);
  put(source, 'scripts/quality/canary-scan.mjs', `import fs from 'node:fs';
if(process.argv.includes('--version')) console.log('canary-checker@1.0.0');
else { const text=fs.readFileSync('src/canary.txt','utf8'); console.log(JSON.stringify({findings:text.includes('unsafe')?[{ruleId:'CANARY/UNSAFE',severity:'error',file:'src/canary.txt',line:1,message:'危险代码必须在推送前消除',suggestion:'使用已批准的机械脚本改为 safe，再自动复扫',autoFixable:true,fixerId:'mechanical-canary'}]:[]})); }
`);
  put(source, 'scripts/quality/canary-fix.mjs', "import fs from 'node:fs'; fs.writeFileSync('src/canary.txt',fs.readFileSync('src/canary.txt','utf8').replaceAll('unsafe','safe'));\n");
  put(source, kind === 'frontend' ? 'pnpm-lock.yaml' : 'quality-tools/package-lock.json', kind === 'frontend' ? "lockfileVersion: '9.0'\n" : { lockfileVersion: 3, packages: {} });
  put(source, kind === 'frontend' ? '.wl-skills/copilot-instructions-full.md' : '.wl-skills-bd/capabilities.json', kind === 'frontend' ? 'approved canary native assets\n' : {});
  bypassCommit(source, 'fixture: approved canary adoption');
  const root = path.join(parent, 'clone'); execFileSync('git', ['clone', '--no-local', '-q', source, root]);
  git(root, 'config', 'user.name', 'canary'); git(root, 'config', 'user.email', 'canary@example.invalid');
  assert.equal(gitResult(root, 'config', '--local', '--get', 'core.hooksPath').status, 1);
  const calls = [];
  const runner = (executable, args, runOptions) => {
    if (args[0] === 'config') return { status: 0, stdout: JSON.stringify({ registry: REGISTRY, userAgent: 'pnpm/10.34.5 npm/? node/v24' }), stderr: '' };
    if (['install', 'ci'].includes(args[0])) {
      calls.push({ executable, args });
      const prefix = kind === 'frontend' ? '' : 'quality-tools/';
      const location = path.join(root, `${prefix}node_modules/@agile-team/wl-skills-gate`); mkdirSync(location, { recursive: true });
      for (const file of ['package.json', 'lib', 'bin', 'schemas', 'templates']) cpSync(path.join(PACKAGE_ROOT, file), path.join(location, file), { recursive: true });
      for (const [name, version] of kind === 'frontend' ? [['kit', '2.33.1'], ['ui', '1.22.1']] : [['bd', '0.41.1']]) {
        put(root, `${prefix}node_modules/@agile-team/wl-skills-${name}/package.json`, { name: `@agile-team/wl-skills-${name}`, version });
        const bin = name === 'kit' ? 'wl-skills' : name === 'ui' ? 'wl-ui' : 'wl-skills-bd';
        put(root, `${prefix}node_modules/@agile-team/wl-skills-${name}/bin/${bin}.js`, `// Isolated native update/version fixture; no production rule evaluation.\nif(process.argv.includes('--version')) console.log('${version}'); else if(process.argv.includes('update')) console.log(${name === 'bd' ? "JSON.stringify({planHash:'a'.repeat(64)})" : "'fixture native assets unchanged'"});\n`);
      }
      return { status: 0, stdout: 'isolated package installation fixture; no network', stderr: '' };
    }
    return spawnSync(executable, args, runOptions);
  };
  const actions = action => spawnSync(process.execPath, [path.join(root, 'scripts/quality/project-actions.mjs'), ...action], { cwd: root, encoding: 'utf8', timeout: 90000 });
  const initPlan = planWorkspaceInitialization({ root, runner });
  assert.deepEqual(initPlan.blockers, []);
  const installed = applyWorkspaceInitialization({ root, runner, planHash: initPlan.planHash, confirm: true });
  assert.equal(installed.status, 'workspace-approval-required', JSON.stringify(installed));
  assert.equal(installed.localValidated, false);
  const readyPlan = planWorkspaceInitialization({ root, runner });
  const ready = applyWorkspaceInitialization({ root, runner, planHash: readyPlan.planHash, confirm: true });
  assert.equal(ready.status, 'local-validated-awaiting-remote-acceptance', JSON.stringify(ready));
  assert.equal(ready.localValidated, true); assert.equal(ready.remoteValidated, false); assert.equal(ready.businessClosureValidated, false);
  assert.equal(calls.length, 1);
  assert.equal(git(root, 'status', '--porcelain'), '');
  const summaryFile = path.join(root, 'quality-reports/quality-summary.json');
  return { root, source, parent, calls, runner, ready, actions, summaryFile, summary: () => JSON.parse(readFileSync(summaryFile)), read: relative => JSON.parse(readFileSync(path.join(root, relative))) };
}

function retain(f, name, extra) {
  if (!EVIDENCE_ROOT) return;
  const dir = path.join(path.resolve(EVIDENCE_ROOT), name); mkdirSync(dir, { recursive: true });
  cpSync(path.join(f.root, 'quality-reports'), path.join(dir, 'quality-reports'), { recursive: true });
  put(dir, 'simulation.json', {
    schemaVersion: 1, generatedAt: new Date().toISOString(), gateVersion: VERSION,
    implementation: ['lib/onboard.js', 'lib/onboard-config.js', 'lib/workspace-init.js', 'lib/run.js', 'lib/fix.js', 'lib/review-auto.js', 'templates/onboarding/automation/project-actions.mjs'].map(file => ({ path: file, sha256: digest(readFileSync(path.join(PACKAGE_ROOT, file))) })),
    boundary: { real: ['configuration onboarding', 'isolated git clone', 'git hooks', 'local git push to bare remote', 'gate execution', 'mechanical plan', 'explicit confirmed repair', 'automatic rescan', 'nine-dimensional review draft'], stubs: ['package-manager install/config', 'deterministic native checker'], realBusinessProjectChanged: false, networkUsed: false, feishuSent: false, remotePermissionsValidated: false },
    ...extra,
  });
}

for (const kind of ['frontend', 'backend']) test(`全项目预防链 ${kind}：实际接入清单→clone→Hook阻断→明确预览确认→脚本修复自动复扫→允许推送`, t => {
  const f = fixture(t, kind), initial = f.summary(), initialHead = git(f.root, 'rev-parse', 'HEAD');
  const remote = path.join(f.parent, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]);
  git(f.root, 'remote', 'add', 'canary', remote);
  const branch = git(f.root, 'symbolic-ref', '--short', 'HEAD');
  assert.equal(initial.decision.status, 'passed');
  put(f.root, 'src/canary.txt', 'unsafe new-case\n'); git(f.root, 'add', 'src/canary.txt');
  const rejectedCommit = kind === 'frontend' ? gitResult(f.root, 'commit', '-m', 'fix(quality): 验证危险代码-提交应拒绝') : null;
  if (rejectedCommit) {
    assert.notEqual(rejectedCommit.status, 0); assert.equal(git(f.root, 'rev-parse', 'HEAD'), initialHead);
    assert.equal(f.summary().run.profile, 'fast'); assert.equal(f.summary().decision.status, 'blocked');
  }
  const blockedPush = gitResult(f.root, 'push', 'canary', `HEAD:refs/heads/${branch}`);
  assert.notEqual(blockedPush.status, 0);
  assert.notEqual(gitResult(remote, 'rev-parse', '--verify', `refs/heads/${branch}`).status, 0, '危险代码的推送不能写入本地bare远端');
  const blockedSummary = f.summary();
  assert.equal(blockedSummary.decision.status, 'blocked');
  assert.notEqual(blockedSummary.run.eventId, initial.run.eventId);
  assert.equal(blockedSummary.run.profile, 'standard'); assert.equal(blockedSummary.counts.blockingNew, 1);
  const index = f.read('quality-reports/review-latest.json');
  assert.equal(index.schemaVersion, 2); assert.equal(index.eventId, blockedSummary.run.eventId);
  assert.equal(index.approved, false); assert.ok(index.pendingDimensions.length > 0);
  assert.ok(existsSync(path.join(f.root, 'quality-reports', index.bodyFile)));

  const preview = f.actions(['preview-repair']); assert.equal(preview.status, 0, preview.stderr);
  assert.equal(readFileSync(path.join(f.root, 'src/canary.txt'), 'utf8'), 'unsafe new-case\n');
  const plan = f.read('quality-reports/repair/fix-plan.json'), receipt = f.read('quality-reports/repair/preview-confirmation.json');
  assert.equal(receipt.planHash, plan.planHash); assert.equal(plan.items[0].action, 'command');
  const beforeIndex = git(f.root, 'ls-files', '--stage', '-z');
  const beforeRepair = f.summary();
  const repaired = f.actions(['apply-repair', '确认已预览的机械修复', plan.planHash, digest(readFileSync(path.join(f.root, 'quality-reports/repair/fix-plan.json')))]);
  assert.equal(repaired.status, 0, repaired.stderr + repaired.stdout);
  assert.equal(readFileSync(path.join(f.root, 'src/canary.txt'), 'utf8'), 'safe new-case\n');
  assert.equal(git(f.root, 'ls-files', '--stage', '-z'), beforeIndex, '确认修复不能暗中暂存');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), initialHead, '确认修复不能暗中提交');
  const afterRepair = f.summary(), fixReport = f.read('quality-reports/repair/fix-report.json');
  assert.notEqual(afterRepair.run.eventId, beforeRepair.run.eventId);
  assert.equal(afterRepair.decision.status, 'passed'); assert.equal(fixReport.scanResolved, true);
  assert.equal(fixReport.closed, false); assert.equal(fixReport.nextState, 'pending-verification');
  assert.equal(fixReport.fixed.length, 1); assert.equal(fixReport.remaining.length, 0); assert.equal(fixReport.regressions.length, 0);
  const comparison = f.read('quality-reports/review-latest.json').comparison;
  assert.equal(comparison.before.error, 1); assert.equal(comparison.after.error, 0);
  assert.equal(comparison.comparable, false, '本地未提交观测不能冒充受控CI同口径改善证据');
  assert.ok(comparison.changedBasis.includes('incompleteExecutionEvidence'));

  git(f.root, 'add', 'src/canary.txt');
  const committed = gitResult(f.root, 'commit', '-m', 'fix(quality): 消除危险代码-脚本修复复扫通过');
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  const pushed = gitResult(f.root, 'push', 'canary', `HEAD:refs/heads/${branch}`);
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), git(f.root, 'rev-parse', 'HEAD'));
  assert.equal(f.summary().decision.status, 'passed');
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  retain(f, `${kind}-prevention-chain`, { status: 'passed', init: f.ready, events: { initial: initial.run.eventId, blocked: blockedSummary.run.eventId, beforeRepair: beforeRepair.run.eventId, afterRepair: afterRepair.run.eventId, finalPush: f.summary().run.eventId }, stages: { invalidFrontendCommitRejected: rejectedCommit?.status ?? 'backend-no-pre-commit-by-design', prePushRejected: blockedPush.status, repaired: repaired.status, finalCommit: committed.status, localBarePush: pushed.status }, outputs: { blockedPush: blockedPush.stdout + blockedPush.stderr, preview: preview.stdout + preview.stderr, repaired: repaired.stdout + repaired.stderr } });
});

test('真实Hook失败/查看报告必须定位本轮 schemaVersion 2 九维草稿，而不是误报草稿缺失', t => {
  const f = fixture(t, 'frontend');
  put(f.root, 'src/canary.txt', 'unsafe\n');
  const blocked = gitResult(f.root, 'hook', 'run', 'pre-push'); assert.notEqual(blocked.status, 0);
  const index = f.read('quality-reports/review-latest.json'), view = f.actions(['view-report']);
  assert.equal(view.status, 0);
  assert.match(view.stdout, /九维 Review（待确认）/);
  assert.doesNotMatch(view.stdout, /当前扫描没有可核验的九维草稿/);
  assert.ok(view.stdout.includes(path.join(f.root, 'quality-reports', index.bodyFile)));
  const old = { ...index, schemaVersion: 1 };
  for (const key of ['bodyFile', 'recordFile', 'summaryFile']) old[key] = `quality-reports/${old[key]}`;
  put(f.root, 'quality-reports/review-latest.json', old);
  assert.match(f.actions(['view-report']).stdout, /九维 Review（待确认）/, '旧schema索引继续按项目根解析');
  const indexFile = path.join(f.root, 'quality-reports/review-latest.json'), bodyFile = path.join(f.root, 'quality-reports', index.bodyFile), originalBody = readFileSync(bodyFile);
  for (const mode of ['wrong-event', 'escape', 'wrong-hash', 'body-tampered', 'body-link', 'index-link']) {
    put(f.root, 'quality-reports/review-latest.json', index);
    const damaged = { ...index };
    if (mode === 'wrong-event') damaged.eventId = 'previous-event';
    if (mode === 'escape') damaged.bodyFile = '../quality/policy.json';
    if (mode === 'wrong-hash') damaged.summaryHash = 'a'.repeat(64);
    if (mode === 'body-tampered') writeFileSync(bodyFile, 'fake no problems');
    if (mode === 'body-link') { const duplicate = path.join(f.parent, 'outside-review.md'); writeFileSync(duplicate, originalBody); rmSync(bodyFile); symlinkSync(duplicate, bodyFile); }
    if (mode === 'index-link') { const duplicate = path.join(f.parent, 'outside-index.json'); put(f.parent, 'outside-index.json', index); rmSync(indexFile); symlinkSync(duplicate, indexFile); }
    else put(f.root, 'quality-reports/review-latest.json', damaged);
    const rejected = f.actions(['view-report']); assert.equal(rejected.status, 0);
    assert.match(rejected.stdout, /当前扫描没有可核验的九维草稿/, mode);
    assert.doesNotMatch(rejected.stdout, /九维 Review（待确认）/, mode);
    if (mode === 'body-tampered' || mode === 'body-link') { rmSync(bodyFile); writeFileSync(bodyFile, originalBody); }
    if (mode === 'index-link') rmSync(indexFile);
  }
});

test('预览后源码变化不能沿用旧授权；重新预览确认后恢复，修复失败自动回滚并复扫', t => {
  const f = fixture(t, 'backend');
  put(f.root, 'src/canary.txt', 'unsafe\n');
  assert.equal(f.actions(['preview-repair']).status, 0);
  const oldPlan = f.read('quality-reports/repair/fix-plan.json'), oldDigest = digest(readFileSync(path.join(f.root, 'quality-reports/repair/fix-plan.json')));
  put(f.root, 'src/canary.txt', 'unsafe concurrent change\n');
  const stale = f.actions(['apply-repair', '确认已预览的机械修复', oldPlan.planHash, oldDigest]);
  assert.notEqual(stale.status, 0); assert.match(stale.stdout + stale.stderr, /代码\/HEAD 在预览后发生变化/);
  assert.equal(readFileSync(path.join(f.root, 'src/canary.txt'), 'utf8'), 'unsafe concurrent change\n');
  assert.equal(existsSync(path.join(f.root, 'quality-reports/repair/preview-confirmation.json')), false);
  put(f.root, 'scripts/quality/canary-fix.mjs', "import fs from 'node:fs'; fs.writeFileSync('src/canary.txt','safe\\n'); fs.writeFileSync('unexpected.txt','must roll back'); process.exitCode=7;\n");
  assert.equal(f.actions(['preview-repair']).status, 0);
  const nextPlan = f.read('quality-reports/repair/fix-plan.json'), nextDigest = digest(readFileSync(path.join(f.root, 'quality-reports/repair/fix-plan.json')));
  const failed = f.actions(['apply-repair', '确认已预览的机械修复', nextPlan.planHash, nextDigest]);
  assert.equal(failed.status, 2);
  const report = f.read('quality-reports/repair/fix-report.json');
  assert.equal(report.rolledBack, true); assert.equal(report.manualRecoveryRequired, false); assert.equal(report.scanResolved, false); assert.equal(report.closed, false);
  assert.equal(report.rollbackVerification.sourceRestored, true); assert.equal(report.after.decision, 'blocked');
  assert.equal(readFileSync(path.join(f.root, 'src/canary.txt'), 'utf8'), 'unsafe concurrent change\n');
  assert.equal(existsSync(path.join(f.root, 'unexpected.txt')), false);
  retain(f, 'repair-drift-recovery', { status: 'passed', outcomes: { staleRejected: stale.status, failedFix: failed.status, rolledBack: report.rolledBack, rollbackRescanDecision: report.after.decision }, output: { stale: stale.stdout + stale.stderr, failed: failed.stdout + failed.stderr } });
});

function makeApprovedLegacyProject(f, kind) {
  const prefix = kind === 'frontend' ? '' : 'quality-tools/';
  const pkg = f.read(`${prefix}package.json`); pkg.devDependencies['@agile-team/wl-skills-gate'] = '0.10.0'; put(f.root, `${prefix}package.json`, pkg);
  const manifest = f.read('quality/workspace.json'); manifest.gateVersion = '0.10.0'; delete manifest.managedFiles; delete manifest.project; put(f.root, 'quality/workspace.json', manifest);
  put(f.root, 'scripts/quality/project-actions.mjs', readFileSync(path.join(PACKAGE_ROOT, 'fixtures/onboarding/managed-assets-0.10.0/project-actions.mjs'), 'utf8'));
  if (kind === 'backend') put(f.root, 'scripts/quality/java-unit.mjs', readFileSync(path.join(PACKAGE_ROOT, 'fixtures/onboarding/managed-assets-0.10.0/java-unit.mjs'), 'utf8'));
  const policy = f.read('quality/policy.json');
  policy.checks.push({ id: 'CUSTOM-JUNIT', tool: 'junit', command: 'node scripts/quality/custom-junit.mjs', file: 'quality-reports/native/TEST-custom.xml',
    versionCommand: 'node --version', requiredTests: ['Fixture#works'], profiles: ['standard', 'release'] });
  policy.releaseRequires.push('CUSTOM-JUNIT'); put(f.root, 'quality/policy.json', policy);
  put(f.root, 'scripts/quality/custom-junit.mjs', `import fs from 'node:fs';fs.mkdirSync('quality-reports/native',{recursive:true});fs.writeFileSync('quality-reports/native/TEST-custom.xml','<testsuite name="Fixture" tests="1" failures="0" errors="0" skipped="0"><testcase classname="Fixture" name="works"/></testsuite>');\n`);
  const lock = f.read('quality/rules.lock.json'); lock['wl-skills-gate'] = '0.10.0'; lock.tools['CUSTOM-JUNIT'] = process.version; put(f.root, 'quality/rules.lock.json', lock);
  const review = f.read('quality/review-policy.json'); const ui = review.dimensions.find(entry => entry.id === 'ui'); ui.applicable = false; ui.reason = 'This adopted canary does not render a UI';
  put(f.root, 'quality/review-policy.json', review);
  const evidencePlan = f.read('quality/review-evidence.plan.json'); evidencePlan.requiredTestCheckIds = ['CUSTOM-JUNIT']; put(f.root, 'quality/review-evidence.plan.json', evidencePlan);
  if (kind === 'backend') {
    const plan = f.read('quality/java-unit.plan.json'); plan.offline = true; put(f.root, 'quality/java-unit.plan.json', plan);
  }
  bypassCommit(f.root, 'fixture: approved legacy custom scope');
  const installed = f.read(`${prefix}node_modules/@agile-team/wl-skills-gate/package.json`); installed.version = '0.10.0'; put(f.root, `${prefix}node_modules/@agile-team/wl-skills-gate/package.json`, installed);
}

for (const kind of ['frontend', 'backend']) test(`已接 ${kind} 从0.10固定旧资产升级：自有策略、九维适用性、必测计划、POM原文保留；自有版本锁复用后真实首扫验证`, t => {
  const f = fixture(t, kind); makeApprovedLegacyProject(f, kind);
  const originals = Object.fromEntries(['quality/policy.json', 'quality/review-policy.json', 'quality/review-evidence.plan.json', ...(kind === 'backend' ? ['pom.xml', 'quality/java-unit.plan.json'] : [])].map(file => [file, readFileSync(path.join(f.root, file), 'utf8')]));
  const options = { root: f.root, kind, registry: REGISTRY, complete: true, runner: f.runner, allowDependencyUpdates: true };
  const notApproved = planOnboarding({ ...options, allowDependencyUpdates: false }); assert.ok(notApproved.hardConflicts.length > 0);
  const first = planOnboarding(options); assert.deepEqual(first.hardConflicts, []); assert.deepEqual(first.complete.blockers, []);
  assert.ok(first.legacyMigrations.some(entry => entry.kind === 'approved-managed-script-upgrade' && entry.target === 'scripts/quality/project-actions.mjs'));
  const migrated = applyOnboarding({ ...options, confirm: true, planHash: first.planHash }); assert.equal(migrated.status, 'native-approval-required', JSON.stringify(migrated));
  const second = planOnboarding(options); assert.deepEqual(second.hardConflicts, []); assert.deepEqual(second.complete.blockers, []);
  assert.ok(second.complete.lock.queries.some(query => query.status === 'reused-approved-lock' && query.id === 'CUSTOM-JUNIT' && query.executed === false));
  const completed = applyOnboarding({ ...options, confirm: true, planHash: second.planHash });
  assert.equal(completed.status, 'local-validated-awaiting-remote-acceptance', JSON.stringify(completed));
  assert.equal(completed.complete.localValidated, true); assert.equal(completed.complete.remoteValidated, false);
  for (const [file, bytes] of Object.entries(originals)) assert.equal(readFileSync(path.join(f.root, file), 'utf8'), bytes, `升级不能改写 ${file}`);
  const newManifest = f.read('quality/workspace.json'); assert.equal(newManifest.gateVersion, VERSION);
  assert.ok(newManifest.managedFiles.some(entry => entry.path === 'scripts/quality/project-actions.mjs'));
  assert.equal(f.summary().checks.find(check => check.checkId === 'CUSTOM-JUNIT').toolVersion, process.version);
  assert.equal(f.summary().checks.find(check => check.checkId === 'CUSTOM-JUNIT').testEvidence.counts.passed, 1);
  const recovery = planOnboarding(options); assert.deepEqual(recovery.complete.blockers, []);
  assert.ok(recovery.complete.lock.queries.some(query => query.status === 'reused-approved-lock' && query.resumedGateVersionOnly));
  bypassCommit(f.root, 'fixture: approve upgraded managed assets');
  const clone = path.join(f.parent, 'upgraded-clone'); execFileSync('git', ['clone', '--no-local', '-q', f.root, clone]);
  const prefix = kind === 'frontend' ? '' : 'quality-tools/';
  const cloneRunner = (executable, args, runOptions) => {
    if (args[0] === 'config') return { status: 0, stdout: JSON.stringify({ registry: REGISTRY, userAgent: 'pnpm/10.34.5 npm/? node/v24' }), stderr: '' };
    if (['ci', 'install'].includes(args[0])) { cpSync(path.join(f.root, `${prefix}node_modules`), path.join(clone, `${prefix}node_modules`), { recursive: true }); return { status: 0, stdout: 'isolated fixed package install fixture', stderr: '' }; }
    return spawnSync(executable, args, runOptions);
  };
  let clonePlan = planWorkspaceInitialization({ root: clone, runner: cloneRunner }); assert.deepEqual(clonePlan.blockers, []);
  assert.equal(applyWorkspaceInitialization({ root: clone, runner: cloneRunner, confirm: true, planHash: clonePlan.planHash }).status, 'workspace-approval-required');
  clonePlan = planWorkspaceInitialization({ root: clone, runner: cloneRunner });
  const cloneReady = applyWorkspaceInitialization({ root: clone, runner: cloneRunner, confirm: true, planHash: clonePlan.planHash });
  assert.equal(cloneReady.status, 'local-validated-awaiting-remote-acceptance', JSON.stringify(cloneReady));
  for (const [file, bytes] of Object.entries(originals)) assert.equal(readFileSync(path.join(clone, file), 'utf8'), bytes);
  assert.equal(git(clone, 'status', '--porcelain'), '');
  retain(f, `${kind}-managed-upgrade`, { status: 'passed', migrations: first.legacyMigrations, queries: second.complete.lock.queries, preservedFiles: Object.keys(originals), upgradedGateVersion: newManifest.gateVersion, result: completed.status });
});

test('升级不覆盖自有脚本，不在预览执行未提交的新版本查询；变更后的旧批准计划零写拒绝', t => {
  const f = fixture(t, 'frontend'); makeApprovedLegacyProject(f, 'frontend');
  const options = { root: f.root, kind: 'frontend', registry: REGISTRY, complete: true, runner: f.runner, allowDependencyUpdates: true };
  const approved = planOnboarding(options); assert.deepEqual(approved.hardConflicts, []);
  const policy = f.read('quality/policy.json'); policy.checks[0].versionCommand = 'touch should-never-execute.txt'; put(f.root, 'quality/policy.json', policy);
  const preview = planOnboarding(options); assert.ok(preview.hardConflicts.some(conflict => /policy/.test(conflict.target)));
  assert.equal(existsSync(path.join(f.root, 'should-never-execute.txt')), false);
  assert.throws(() => applyOnboarding({ ...options, confirm: true, planHash: approved.planHash }), /planHash.*零写入/);
  assert.equal(f.read('quality/workspace.json').gateVersion, '0.10.0');
  git(f.root, 'checkout', '--', 'quality/policy.json');
  put(f.root, 'scripts/quality/project-actions.mjs', '// project-customized action; preserve it\n'); bypassCommit(f.root, 'fixture: custom implementation');
  const conflict = planOnboarding(options);
  assert.ok(conflict.hardConflicts.some(entry => entry.target === 'scripts/quality/project-actions.mjs' && /摘要/.test(entry.reason)));
  assert.equal(readFileSync(path.join(f.root, 'scripts/quality/project-actions.mjs'), 'utf8'), '// project-customized action; preserve it\n');
});

test('复用HEAD锁不放过实际工具版本漂移；首扫阻断后恢复同一入口不陷入已写Gate锁死循环', t => {
  const f = fixture(t, 'frontend'); makeApprovedLegacyProject(f, 'frontend');
  const scanner = path.join(f.root, 'scripts/quality/canary-scan.mjs'), original = readFileSync(scanner, 'utf8');
  writeFileSync(scanner, original.replace('canary-checker@1.0.0', 'canary-checker@2.0.0')); bypassCommit(f.root, 'fixture: changed native checker needs lock verification');
  const options = { root: f.root, kind: 'frontend', registry: REGISTRY, complete: true, runner: f.runner, allowDependencyUpdates: true };
  let plan = planOnboarding(options); assert.deepEqual(plan.hardConflicts, []);
  assert.equal(applyOnboarding({ ...options, confirm: true, planHash: plan.planHash }).status, 'native-approval-required');
  plan = planOnboarding(options); assert.deepEqual(plan.complete.blockers, []);
  const blocked = applyOnboarding({ ...options, confirm: true, planHash: plan.planHash });
  assert.equal(blocked.status, 'onboarding-execution-blocked'); assert.equal(blocked.complete.localValidated, false);
  const invalid = f.summary().checks.find(check => check.checkId === 'CANARY');
  assert.equal(invalid.status, 'invalid'); assert.match(invalid.reason, /实际工具版本.*与锁定/);
  assert.equal(f.read('quality/rules.lock.json')['wl-skills-gate'], VERSION);
  writeFileSync(scanner, original);
  plan = planOnboarding(options); assert.deepEqual(plan.complete.blockers, []);
  assert.ok(plan.complete.lock.queries.some(query => query.status === 'reused-approved-lock' && query.resumedGateVersionOnly));
  const restored = applyOnboarding({ ...options, confirm: true, planHash: plan.planHash });
  assert.equal(restored.status, 'local-validated-awaiting-remote-acceptance', JSON.stringify(restored));
  retain(f, 'approved-lock-version-recovery', { status: 'passed', actualVersionDriftBlocked: true, beforeFailure: blocked.status, recovered: restored.status, failureCheck: invalid });
});

test('桥接真实受控Gate修前修后原件：提交绑定源码→机械脚本修复自动复扫→正常提交后受控复扫', t => {
  const f = fixture(t, 'frontend');
  put(f.root, 'src/canary.txt', 'unsafe bridge-case\n');
  // Deliberately seed a legacy defect in this disposable repository to verify CI
  // catching existing submitted problems. Normal invalid frontend commits above
  // are rejected; no production hook or repository is bypassed here.
  bypassCommit(f.root, 'fixture: seed submitted legacy defect for CI collection');
  const cli = path.join(f.root, 'node_modules/@agile-team/wl-skills-gate/bin/wl-skills-gate.js');
  const controlled = () => spawnSync(process.execPath, [cli, 'run', '--root', f.root, '--profile', 'standard', '--sha', git(f.root, 'rev-parse', 'HEAD')], { cwd: f.root, encoding: 'utf8', timeout: 90000 });
  const beforeCode = controlled(); assert.equal(beforeCode.status, 1, beforeCode.stdout + beforeCode.stderr);
  const beforeBytes = readFileSync(f.summaryFile), before = JSON.parse(beforeBytes), beforeSource = snapshotSource(f.root);
  assert.equal(before.run.sourceBound, true); assert.equal(before.run.sourceDigest, beforeSource.digest); assert.equal(before.decision.status, 'blocked');
  assert.equal(f.actions(['preview-repair']).status, 0);
  const plan = f.read('quality-reports/repair/fix-plan.json'), planHash = digest(readFileSync(path.join(f.root, 'quality-reports/repair/fix-plan.json')));
  const repaired = f.actions(['apply-repair', '确认已预览的机械修复', plan.planHash, planHash]); assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  const fixBytes = readFileSync(path.join(f.root, 'quality-reports/repair/fix-report.json'));
  git(f.root, 'add', 'src/canary.txt'); const commit = gitResult(f.root, 'commit', '-m', 'fix(quality): 修复桥接用例-复扫无危险代码'); assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  const fixedCode = controlled(); assert.equal(fixedCode.status, 0, fixedCode.stdout + fixedCode.stderr);
  const fixedBytes = readFileSync(f.summaryFile), fixed = JSON.parse(fixedBytes), fixedSource = snapshotSource(f.root);
  assert.equal(fixed.run.sourceBound, true); assert.equal(fixed.run.sourceDigest, fixedSource.digest); assert.equal(fixed.decision.status, 'passed');
  assert.notEqual(before.run.commitSha, fixed.run.commitSha); assert.notEqual(before.run.sourceDigest, fixed.run.sourceDigest);
  const comparison = f.read('quality-reports/review-latest.json').comparison;
  // The latest normal local draft may compare with its unbound preview. The
  // separately retained before/fixed original summaries give CI the two actual
  // controlled candidate reports to compare, without relabeling either report.
  assert.equal(comparison.after.error, 0);
  const releaseCode = spawnSync(process.execPath, [cli, 'run', '--root', f.root, '--profile', 'release', '--env', 'uat', '--sha', fixed.run.commitSha], { cwd: f.root, encoding: 'utf8', timeout: 90000 });
  assert.equal(releaseCode.status, 0, releaseCode.stdout + releaseCode.stderr);
  const releaseBytes = readFileSync(f.summaryFile), release = JSON.parse(releaseBytes);
  assert.equal(release.run.sourceBound, true); assert.equal(release.run.sourceDigest, fixedSource.digest); assert.equal(release.run.profile, 'release');
  put(f.root, 'quality-reports/canary-app.bin', 'actually produced canary application artifact\n');
  const manifestCode = spawnSync(process.execPath, [cli, 'manifest', '--root', f.root, '--project', fixed.run.project, '--env', 'uat',
    '--artifacts', 'quality-reports/canary-app.bin', '--configs', 'quality/policy.json,quality/rules.lock.json', '--out', path.join(f.root, 'quality-reports/bridge-manifest.json')], { cwd: f.root, encoding: 'utf8' });
  assert.equal(manifestCode.status, 0, manifestCode.stdout + manifestCode.stderr);
  const manifestBytes = readFileSync(path.join(f.root, 'quality-reports/bridge-manifest.json')), manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.commitSha, fixed.run.commitSha); assert.equal(manifest.sourceDigest, fixedSource.digest);
  put(f.root, 'src/canary.txt', 'unsafe bridge-case\n');
  bypassCommit(f.root, 'fixture: seed independent submitted recurrence to verify CI prevention');
  const recurCode = controlled(); assert.equal(recurCode.status, 1, recurCode.stdout + recurCode.stderr);
  const recurBytes = readFileSync(f.summaryFile), recur = JSON.parse(recurBytes), recurSource = snapshotSource(f.root);
  assert.equal(recur.run.sourceBound, true); assert.equal(recur.run.sourceDigest, recurSource.digest);
  assert.equal(recur.findings[0].fingerprint, before.findings[0].fingerprint); assert.notEqual(recur.run.commitSha, before.run.commitSha);
  if (EVIDENCE_ROOT && process.env.WL_PREVENTION_BRIDGE_WRITE === '1') {
    mkdirSync(path.resolve(EVIDENCE_ROOT), { recursive: true });
    writeFileSync(path.join(EVIDENCE_ROOT, 'bridge-before-summary.json'), beforeBytes);
    writeFileSync(path.join(EVIDENCE_ROOT, 'bridge-fixed-summary.json'), fixedBytes);
    writeFileSync(path.join(EVIDENCE_ROOT, 'bridge-fixed-release-summary.json'), releaseBytes);
    writeFileSync(path.join(EVIDENCE_ROOT, 'bridge-recur-summary.json'), recurBytes);
    writeFileSync(path.join(EVIDENCE_ROOT, 'bridge-fixed-manifest.json'), manifestBytes);
    for (const file of ['quality-reports/canary-app.bin', 'quality/policy.json', 'quality/rules.lock.json']) put(path.join(EVIDENCE_ROOT, 'bridge-artifact-root'), file, readFileSync(path.join(f.root, file), 'utf8'));
    writeFileSync(path.join(EVIDENCE_ROOT, 'bridge-fix-report.json'), fixBytes);
    put(EVIDENCE_ROOT, 'bridge-source-snapshots.json', { before: beforeSource, fixed: fixedSource, recurrence: recurSource, project: before.run.project, requiredCheckIds: before.policy.requiredCheckIds,
      boundary: 'Native checker and dependency install are fixture inputs; Gate, Git, script repair and rescan were actually executed.' });
    execFileSync('git', ['-C', f.root, 'bundle', 'create', path.join(path.resolve(EVIDENCE_ROOT), 'bridge-source.bundle'), '--all']);
    put(EVIDENCE_ROOT, 'bridge-identity.json', { project: before.run.project, requiredCheckIds: before.policy.requiredCheckIds, policyHash: before.policy.policyHash,
      rulesHash: before.policy.ruleSetHash, baselineHash: before.policy.baselineHash, waiversHash: before.policy.waiversHash,
      beforeSha: before.run.commitSha, fixedSha: fixed.run.commitSha, recurSha: recur.run.commitSha, beforeSummaryHash: digest(beforeBytes), fixedSummaryHash: digest(fixedBytes), recurSummaryHash: digest(recurBytes),
      nativeChecker: 'deterministic cmd-json fixture canary-checker@1.0.0', gatesExecuted: true, gitCommitAndSourceBindingVerified: true, realBusinessProjectChanged: false });
    const frozenFiles=['bridge-before-summary.json','bridge-fixed-summary.json','bridge-fixed-release-summary.json','bridge-recur-summary.json','bridge-fixed-manifest.json','bridge-fix-report.json','bridge-source-snapshots.json','bridge-source.bundle','bridge-identity.json',...['quality-reports/canary-app.bin','quality/policy.json','quality/rules.lock.json'].map(file=>'bridge-artifact-root/'+file)];
    put(EVIDENCE_ROOT,'bridge-freeze.json',{schemaVersion:1,files:frozenFiles.map(file=>({path:file,sha256:digest(readFileSync(path.join(EVIDENCE_ROOT,file)))}))});
  }
});
