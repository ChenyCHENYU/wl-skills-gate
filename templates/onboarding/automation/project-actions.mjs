#!/usr/bin/env node
// Thin project loader. Gate owns Hook execution, reports and approved repair/rescan.
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readFileSync, realpathSync, lstatSync} from 'node:fs';
try {
  const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const manifestFile = path.join(root, 'quality/workspace.json');
  if (lstatSync(manifestFile).isSymbolicLink() || !realpathSync(manifestFile).startsWith(root + path.sep)) throw Error('工作副本清单越界');
  const manifest = JSON.parse(readFileSync(manifestFile));
  if (manifest.kind !== 'wl-quality-workspace' || !['frontend','backend'].includes(manifest.projectKind)) throw Error('项目接入清单无效');
  const prefix = manifest.projectKind === 'backend' ? 'quality-tools/' : '';
  const local = realpathSync(path.join(root, prefix + 'node_modules/@agile-team/wl-skills-gate'));
  if (!local.startsWith(root + path.sep)) throw Error('Gate必须来自项目内固定安装');
  const pkg = JSON.parse(readFileSync(path.join(local,'package.json')));
  if (pkg.name !== '@agile-team/wl-skills-gate' || pkg.version !== manifest.gateVersion) throw Error('Gate版本与批准清单不一致');
  const {runProjectActions} = await import(pathToFileURL(path.join(local,'lib/project-actions.js')).href);
  process.exitCode = await runProjectActions({root, argv:process.argv.slice(2)});
} catch(error) {
  console.error(`[quality] 固定Gate入口不可用：${error.message}；请使用项目初始化任务恢复，检查不会跳过。`);
  process.exitCode = 2;
}
