#!/usr/bin/env node
// Jenkins calls one fixed entry. The engineer supplies the approved config;
// ci-prepare detects frontend/backend from the committed workspace manifest.
import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const inside = (root, file) => { const relative = path.relative(root, file); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(packageRoot, 'bin/wl-skills-gate.js');
const packageInfo = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

function command(args, root) {
  const execution = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, stdio: 'inherit', shell: false,
    env: { ...process.env, CI: 'true', HUSKY: '0', WL_GATE_TRIGGER: 'ci' },
  });
  return Number.isInteger(execution.status) ? execution.status : 2;
}

try {
  const args = process.argv.slice(2);
  const prepareOnly = args.length === 3 && args[2] === '--prepare-only';
  assert((args.length === 2 || prepareOnly) && args[0] === '--config' && args[1], '用法：node <固定Gate目录>/templates/ci/check-project.mjs --config <运维持有的项目配置.json> [--prepare-only]');
  const root = realpathSync(process.cwd());
  assert(!lstatSync(path.resolve(args[1])).isSymbolicLink(), 'CI配置不能是符号链接');
  const configFile = realpathSync(args[1]);
  assert(!inside(root, configFile), '批准的CI配置必须保存在业务工作区外，不能由候选代码替换');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const hashKeys = ['workspaceHash', 'lockHash', 'policyHash', 'rulesHash', 'baselineHash', 'waiversHash'];
  assert(config.schemaVersion === 1 && config.kind === 'wl-quality-ci-check' && typeof config.project === 'string' && config.project, '项目CI配置身份无效');
  assert(config.gateVersion === packageInfo.version, `CI配置要求的Gate版本与固定安装包${packageInfo.version}不一致`);
  for (const key of hashKeys) assert(/^[a-f0-9]{64}$/.test(config[key] || ''), `缺少批准的${key}；由工程工具维护者提供，运维无需自行计算或猜填`);
  const checkout = spawnSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd: root, shell: false, encoding: 'utf8' });
  const [top, sha] = (checkout.stdout || '').trim().split(/\r?\n/);
  assert(checkout.status === 0 && realpathSync(top) === root && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha || ''), '请在Jenkins检出的真实业务仓库根执行');
  const { loadConfig } = await import('../../lib/config.js');
  assert(loadConfig(root).policy.project === config.project, '检出项目与批准的CI配置不一致');
  assert(process.env.JENKINS_URL || process.env.CI_PIPELINE_ID, '本入口用于真实CI；本机诊断请使用Gate run，不生成CI阶段身份');

  console.log(`[quality-ci] ${config.project} / ${sha}：准备依赖`);
  const prepared = command(['ci-prepare', '--root', root, '--apply', '--confirm',
    '--expect-workspace-hash', config.workspaceHash, '--expect-lock-hash', config.lockHash], root);
  if (prepared !== 0) process.exitCode = prepared;
  else if (prepareOnly) console.log(`[quality-ci] ${config.project} / ${sha}：固定依赖已准备；本阶段未运行质量检查或授予构建准入`);
  else {
    console.log(`[quality-ci] ${config.project} / ${sha}：执行standard检查`);
    const gateStatus = command(['run', '--root', root, '--profile', 'standard', '--sha', sha,
      '--expect-policy-hash', config.policyHash, '--expect-rules-hash', config.rulesHash,
      '--expect-baseline-hash', config.baselineHash, '--expect-waivers-hash', config.waiversHash], root);
    process.exitCode = gateStatus;
    const summaryFile = path.join(root, 'quality-reports/quality-summary.json');
    if (existsSync(summaryFile)) {
      console.log(`[quality-ci] ${config.project} / ${sha}：生成本轮Review原始证据`);
      const factsStatus = command(['review-facts', '--root', root, '--summary', summaryFile,
        '--out-dir', path.join(root, 'quality-reports/review'), '--plan', 'quality/review-evidence.plan.json'], root);
      if (factsStatus !== 0) process.exitCode = 2;
    } else process.exitCode = 2;
  }
} catch (error) {
  console.error(`[quality-ci] 未运行或准备失败：${error.message}`);
  process.exitCode = 2;
}
