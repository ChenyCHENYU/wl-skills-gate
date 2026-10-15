import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../../lib/source-state.js';
import { runGate } from '../../lib/run.js';
import { buildFixPlan, applyFixPlan } from '../../lib/fix.js';
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
function fixture(t, fixer = "import fs from 'node:fs';fs.writeFileSync('src.txt','fixed');") {
  const root = mkdtempSync(path.join(tmpdir(), 'wl-fix-state-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'quality'));
  const files = { '.gitignore': 'quality-reports/\n', 'src.txt': 'bad', 'delete.txt': 'delete me', 'staged.txt': 'original', 'other.txt': 'original',
    'fix.mjs': fixer, 'scan.mjs': "import fs from 'node:fs';console.log(JSON.stringify({findings:fs.readFileSync('src.txt','utf8')==='bad'?[{ruleId:'DEMO/R',severity:'error',file:'src.txt',message:'bad',autoFixable:true,fixerId:'safe'}]:[]}));",
    'quality/policy.json': JSON.stringify({ schemaVersion: 1, project: 'fix-state', checks: [{ id: 'SCAN', tool: 'cmd-json', command: 'node scan.mjs', versionCommand: 'node --version', profiles: ['standard'] }], fixers: [{ id: 'safe', ruleIds: ['DEMO/R'], files: ['src.txt'], command: 'node fix.mjs' }] }),
    'quality/rules.lock.json': JSON.stringify({ lockVersion: 1, 'wl-skills-gate': version, tools: { SCAN: process.version } }) };
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(root, file), content);
  git(['init', '-q'], root); git(['config', 'user.name', 'test'], root); git(['config', 'user.email', 'test@example.invalid'], root); git(['add', '-A'], root); git(['commit', '-qm', 'initial'], root);
  const plan = async () => { assert.equal((await runGate({ argv: ['--root', root] })).exitCode, 1); return buildFixPlan(path.join(root, 'quality-reports/quality-summary.json'), { root }); };
  return { root, plan };
}
for (const stagedDelete of [false, true]) test(`正常${stagedDelete ? '暂存' : '未暂存'}删除及已有暂存保留，修复复扫可以成功`, async (t) => {
  const f = fixture(t); rmSync(path.join(f.root, 'delete.txt'));
  if (stagedDelete) git(['add', 'delete.txt'], f.root);
  writeFileSync(path.join(f.root, 'staged.txt'), 'user staged'); git(['add', 'staged.txt'], f.root);
  const indexBefore = git(['ls-files', '--stage', '-z'], f.root), { planFile } = await f.plan();
  const result = await applyFixPlan(planFile, { root: f.root, confirm: true });
  assert.equal(result.exitCode, 0); assert.equal(result.fixReport.scanResolved, true);
  assert.equal(existsSync(path.join(f.root, 'delete.txt')), false); assert.equal(git(['ls-files', '--stage', '-z'], f.root), indexBefore);
});
test('白名单修复器的 git add 被隔离、判失败并恢复源码，原暂存不变', async (t) => {
  const f = fixture(t, "import fs from 'node:fs';import {spawnSync} from 'node:child_process';fs.writeFileSync('src.txt','fixed');spawnSync('git',['add','src.txt']);");
  rmSync(path.join(f.root, 'delete.txt'));
  writeFileSync(path.join(f.root, 'staged.txt'), 'user staged'); git(['add', 'staged.txt'], f.root);
  const indexBefore = git(['ls-files', '--stage', '-z'], f.root), { planFile } = await f.plan();
  const result = await applyFixPlan(planFile, { root: f.root, confirm: true });
  assert.equal(result.exitCode, 2); assert.equal(result.fixReport.isolatedIndexChanged, true); assert.equal(result.fixReport.indexChanged, false);
  assert.equal(result.fixReport.rolledBack, true); assert.equal(result.fixReport.scanResolved, false);
  assert.equal(readFileSync(path.join(f.root, 'src.txt'), 'utf8'), 'bad'); assert.equal(git(['ls-files', '--stage', '-z'], f.root), indexBefore);
  assert.equal(existsSync(path.join(f.root, 'delete.txt')), false);
});
test('预览后暂存变化零写拒绝，不覆盖新暂存', async (t) => {
  const f = fixture(t), { planFile } = await f.plan();
  writeFileSync(path.join(f.root, 'src.txt'), 'user staged'); git(['add', 'src.txt'], f.root); writeFileSync(path.join(f.root, 'src.txt'), 'bad');
  const index = git(['ls-files', '--stage', '-z'], f.root);
  await assert.rejects(applyFixPlan(planFile, { root: f.root, confirm: true }), /暂存区在预览后/);
  assert.equal(git(['ls-files', '--stage', '-z'], f.root), index); assert.equal(readFileSync(path.join(f.root, 'src.txt'), 'utf8'), 'bad');
});
test('实际暂存区被绕过隔离修改时不回滚并发操作，保留人工恢复证据', async (t) => {
  const f = fixture(t, "import fs from 'node:fs';import {spawnSync} from 'node:child_process';fs.writeFileSync('src.txt','fixed');fs.writeFileSync('other.txt','concurrent');const env={...process.env};delete env.GIT_INDEX_FILE;spawnSync('git',['add','other.txt'],{env});");
  const { planFile } = await f.plan(), result = await applyFixPlan(planFile, { root: f.root, confirm: true });
  assert.equal(result.exitCode, 2); assert.equal(result.fixReport.indexChanged, true); assert.equal(result.fixReport.rolledBack, false); assert.equal(result.fixReport.manualRecoveryRequired, true);
  assert.equal(git(['show', ':other.txt'], f.root), 'concurrent'); assert.equal(readFileSync(path.join(f.root, 'src.txt'), 'utf8'), 'fixed'); assert.deepEqual(result.fixReport.fixed, []);
  assert(existsSync(result.fixReport.originalIndexFile)); assert.equal(result.fixReport.recovery.automaticGitResetPerformed, false);
});
