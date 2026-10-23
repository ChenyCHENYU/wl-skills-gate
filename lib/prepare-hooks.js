import path from 'node:path';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const command='node scripts/quality/prepare-hooks.mjs';
export const PREPARE_HOOKS_COMMAND=command;
export function shellExecutionLines(value){return String(value).split(/\r?\n/).filter(line=>!/^\s*#/.test(line)).join('\n');}
function file(root,relative){
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git'))throw Error('Hook路径必须位于项目内');
  let current=root;
  for(const part of relative.split('/')){current=path.join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('Hook受管文件不能是符号链接');}
  if(!lstatSync(current).isFile()||!realpathSync(current).startsWith(root+path.sep))throw Error('Hook受管文件不是项目内普通文件');
  return current;
}
export function prepareProjectHooks({root:requestedRoot}={}){
  const root=realpathSync(path.resolve(requestedRoot||'.'));
  const run=(executable,args)=>{const r=spawnSync(executable,args,{cwd:root,encoding:'utf8',shell:false});if(r.error||r.status!==0)throw Error('Hook准备未完成：'+(r.stderr||r.error?.message||executable));return r.stdout.trim();};
  if(realpathSync(run('git',['rev-parse','--show-toplevel']))!==root)throw Error('Hook准备必须在项目Git根执行');
  const workspace=JSON.parse(readFileSync(file(root,'quality/workspace.json'),'utf8'));
  if(workspace.kind!=='wl-quality-workspace'||workspace.projectKind!=='frontend'||workspace.schemaVersion!==1)throw Error('Hook准备缺少有效前端接入清单');
  if(!['.githooks','.husky','.husky/_','scripts/quality/git-hooks'].includes(workspace.hooksPath))throw Error('Hook准备拒绝未知受控入口');
  if(workspace.hooksPath==='.husky/_'&&workspace.prepareHooks?.legacyHusky!==true)throw Error('Husky转发入口必须由固定Husky准备');
  const hookDirectory=workspace.hooksPath==='.husky/_'?'.husky':workspace.hooksPath;
  const expected=['pre-commit','pre-push','commit-msg'].map(name=>hookDirectory+'/'+name);
  if(!Array.isArray(workspace.hookFiles)||workspace.hookFiles.length!==3||expected.some(relative=>workspace.hookFiles.filter(x=>x.path===relative).length!==1))throw Error('Hook准备清单未完整覆盖三个实际入口');
  for(const entry of workspace.hookFiles){if(hash(readFileSync(file(root,entry.path)))!==entry.sha256)throw Error('Hook摘要不符：'+entry.path+'；未激活旧Husky或替换Gate入口');}
  const managed=workspace.managedFiles?.find(x=>x.path==='scripts/quality/prepare-hooks.mjs');
  if(!managed||hash(readFileSync(file(root,managed.path)))!==managed.sha256)throw Error('Hook准备脚本摘要不符');
  const pkg=JSON.parse(readFileSync(file(root,'package.json'),'utf8'));
  if(pkg.scripts?.prepare!==command)throw Error('项目prepare入口不等于受控脚本');
  const previous=spawnSync('git',['config','--local','--get','core.hooksPath'],{cwd:root,encoding:'utf8'}).stdout.trim();
  let huskyPrepared=false;
  try{
    if(workspace.prepareHooks?.legacyHusky===true){
      const modules=realpathSync(path.join(root,'node_modules'));
      if(!modules.startsWith(root+path.sep))throw Error('Husky依赖必须位于项目内');
      const husky=realpathSync(path.join(modules,'husky'));
      if(!husky.startsWith(modules+path.sep))throw Error('Husky不能指向项目外');
      const hp=JSON.parse(readFileSync(path.join(husky,'package.json'),'utf8'));
      if(hp.name!=='husky'||!/^9\.\d+\.\d+$/.test(hp.version))throw Error('仅适配项目固定Husky9');
      run(process.execPath,[path.join(husky,'bin.js'),'.husky']);huskyPrepared=true;
    }
    run('git',['config','--local','core.hooksPath',workspace.hooksPath]);
    if(run('git',['config','--local','--get','core.hooksPath'])!==workspace.hooksPath)throw Error('Git Hook路径回读不一致');
    return {status:'hooks-restored',hooksPath:workspace.hooksPath,verifiedHooks:3,huskyPrepared,fullScanExecuted:false};
  }catch(error){
    if(previous)spawnSync('git',['config','--local','core.hooksPath',previous],{cwd:root});
    else spawnSync('git',['config','--local','--unset','core.hooksPath'],{cwd:root});
    throw error;
  }
}
