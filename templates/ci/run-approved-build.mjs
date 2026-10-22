#!/usr/bin/env node
// The approved, read-only shell script lives outside the candidate workspace.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { controlledPath } from '../../lib/control-store.js';

try {
  const [script, expectedHash, ...extra] = process.argv.slice(2);
  if (!script || !path.isAbsolute(script) || !/^[a-f0-9]{64}$/.test(expectedHash || '') || extra.length) throw new Error('必须提供工作区外批准的构建脚本绝对路径和SHA256');
  const root = realpathSync(process.cwd()), file = realpathSync(controlledPath(script)), relative = path.relative(root, file);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('构建入口不能来自业务候选工作区');
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expectedHash) throw new Error('批准构建脚本摘要不匹配');
  const execution = spawnSync('/bin/sh', [file], { cwd: root, shell: false, stdio: 'inherit', env: process.env });
  process.exitCode = Number.isInteger(execution.status) ? execution.status : 2;
} catch (error) {
  console.error(`[approved-build] ${error.message}`);
  process.exitCode = 2;
}
