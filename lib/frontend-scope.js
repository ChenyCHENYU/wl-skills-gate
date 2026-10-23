import path from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function resolveTypedFiles(root,files){
  const ts=await import('typescript');
  const config=path.join(root,'tsconfig.json');
  if(!existsSync(config))throw Error('类型感知检查缺少tsconfig.json');
  const selected=new Set(),seen=new Set();
  function visit(file){
    file=path.resolve(file);if(seen.has(file))return;seen.add(file);
    const read=ts.readConfigFile(file,ts.sys.readFile);if(read.error)throw Error('tsconfig无法读取：'+ts.flattenDiagnosticMessageText(read.error.messageText,' '));
    const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,path.dirname(file),undefined,file,undefined,[{extension:'.vue',isMixedContent:true,scriptKind:ts.ScriptKind.Deferred}]);
    if(parsed.errors.length)throw Error('tsconfig解析失效：'+ts.flattenDiagnosticMessageText(parsed.errors[0].messageText,' '));
    parsed.fileNames.forEach(f=>selected.add(path.resolve(f)));
    for(const ref of parsed.projectReferences||[]){let f=ref.path;if(!f.endsWith('.json'))f=path.join(f,'tsconfig.json');visit(f);}
  }
  visit(config);
  const included=files.filter(f=>selected.has(path.resolve(root,f))),excluded=files.filter(f=>!selected.has(path.resolve(root,f)));
  if(!included.length)throw Error('tsconfig实际类型工程未覆盖任何批准输入');
  return {files:included,excluded,configs:[...seen].map(f=>path.relative(root,f).split(path.sep).join('/'))};
}
export function verifiedManagedLoaders(root,files){
  const templateRoot=new URL('../templates/',import.meta.url);
  const known={
    'scripts/quality/project-actions.mjs':new URL('onboarding/automation/project-actions.mjs',templateRoot),
    'scripts/quality/workspace-setup.mjs':new URL('onboarding/automation/workspace-setup.mjs',templateRoot),
    'scripts/quality/prepare-hooks.mjs':new URL('onboarding/automation/prepare-hooks.mjs',templateRoot),
    'scripts/quality/run.mjs':new URL('scripts-quality/run.mjs',templateRoot)
  };
  let workspace;try{workspace=JSON.parse(readFileSync(path.join(root,'quality/workspace.json'),'utf8'));}catch{return [];}
  if(workspace.kind!=='wl-quality-workspace'||workspace.projectKind!=='frontend'||!Array.isArray(workspace.managedFiles))return [];
  return files.filter(f=>known[f]&&workspace.managedFiles.some(m=>m.path===f&&m.sha256===hash(readFileSync(path.join(root,f))))&&hash(readFileSync(path.join(root,f)))===hash(readFileSync(known[f])));
}
export function validateDuplicateStatistics(raw,files,root){
  const total=raw.statistics?.total,formats=raw.statistics?.formats;
  if(!total||!Array.isArray(raw.duplicates)||!formats||typeof formats!=='object'||!Number.isInteger(total.sources)||total.sources<0)throw Error('jscpd输入覆盖不完整/结构非法');
  const units=Object.values(formats);
  if(units.some(v=>!v||!Number.isInteger(v.sources)||v.sources<0)||units.reduce((n,v)=>n+v.sources,0)!==total.sources)throw Error('jscpd语言片段与总来源统计不一致');
  // Vue is tokenized into multiple native language fragments. The native count
  // is not a physical file count; bound it using the actual SFC block inventory.
  const upper=files.reduce((n,f)=>n+(/\.vue$/i.test(f)?1+(readFileSync(path.join(root,f),'utf8').match(/<(?:template|script|style)\b/gi)||[]).length:1),0);
  if(total.sources>upper)throw Error('jscpd原生片段数量超出实际文件/组件片段上限');
  return {physicalInputs:files.length,nativeVirtualSources:total.sources,sourceCountUpperBound:upper};
}
