#!/usr/bin/env node
// 安装后仅核验并恢复受控Git入口；不执行全量扫描。
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync,realpathSync} from 'node:fs';
try {
  const root=realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'));
  const workspace=JSON.parse(readFileSync(path.join(root,'quality/workspace.json'),'utf8'));
  const modules=realpathSync(path.join(root,'node_modules'));
  const gate=realpathSync(path.join(modules,'@agile-team/wl-skills-gate'));
  if(!modules.startsWith(root+path.sep)||!gate.startsWith(modules+path.sep))throw Error('固定Gate依赖不在本项目内');
  const pkg=JSON.parse(readFileSync(path.join(gate,'package.json'),'utf8'));
  if(pkg.name!=='@agile-team/wl-skills-gate'||pkg.version!==workspace.gateVersion)throw Error('Gate版本与已接入清单不一致');
  const {prepareProjectHooks}=await import(pathToFileURL(path.join(gate,'lib/prepare-hooks.js')));
  const result=prepareProjectHooks({root});
  console.log('[quality] 已核验并恢复Git Hook：'+result.hooksPath+'；未执行全量扫描。');
} catch(error) { console.error('[quality] '+error.message);process.exitCode=2; }
