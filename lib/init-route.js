import path from 'node:path';
import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {safePath} from './source-state.js';
const hash=x=>createHash('sha256').update(x).digest('hex');

// A written workspace manifest is a configuration stage, not proof that the
// first installation, native tools and Hook validation ever finished.
export function projectInitializationRoute({root=process.cwd()}={}){
 root=path.resolve(root);const file=safePath(root,'quality/workspace.json');
 if(!existsSync(file))return {mode:'project',reason:'not-configured'};
 const manifest=JSON.parse(readFileSync(file,'utf8'));
 if(manifest.schemaVersion!==1||manifest.kind!=='wl-quality-workspace'||!['frontend','backend'].includes(manifest.projectKind))throw Error('工作副本清单身份无效；保留配置，请工程维护者核对。');
 const receiptFile=safePath(root,'quality-reports/onboarding/execution.json');
 if(existsSync(receiptFile)){
  if(!lstatSync(receiptFile).isFile())throw Error('接入执行回执不是普通文件');
  let receipt;try{receipt=JSON.parse(readFileSync(receiptFile,'utf8'));}catch{throw Error('接入执行回执无法读取；保留原件，先核对接入记录。');}
  if(receipt.kind!=='onboarding-execution'||receipt.root!==root)throw Error('接入执行回执不属于本项目；保留原件，先核对接入记录。');
  if(receipt.localValidated===true&&receipt.status==='local-validated-awaiting-remote-acceptance')return {mode:'workspace',reason:'local-onboarding-validated',registry:manifest.registry};
  return {mode:'project',reason:'resume-incomplete-onboarding',registry:manifest.registry};
 }
 // A fresh clone or an older adopted project has no machine-local receipt.
 // Require committed adoption identity and the exact declared Hook originals;
 // workspace initialization then verifies the full policy, lock and live tools.
 const committed=relative=>{
  const target=safePath(root,relative),r=spawnSync('git',['-C',root,'show','HEAD:'+relative],{shell:false});
  return r.status===0&&existsSync(target)&&lstatSync(target).isFile()&&hash(r.stdout)===hash(readFileSync(target));
 };
 if(!committed('quality/workspace.json'))return {mode:'project',reason:'resume-uncommitted-configuration',registry:manifest.registry};
 const hooks=manifest.hookFiles;
 if(!Array.isArray(hooks)||!hooks.length||hooks.some(h=>typeof h?.path!=='string'||!/^[a-f0-9]{64}$/.test(h.sha256||'')||!committed(h.path)||hash(readFileSync(safePath(root,h.path)))!==h.sha256))throw Error('已提交接入清单的Hook原件缺失或漂移；不能切回首次接入覆盖，请先恢复批准原件。');
 return {mode:'workspace',reason:'committed-adopted-project',registry:manifest.registry};
}
