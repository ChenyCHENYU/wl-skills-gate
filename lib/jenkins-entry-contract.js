import path from 'node:path';
import {createHash} from 'node:crypto';
import {stableStringify} from './util.js';
const assert=(ok,m)=>{if(!ok)throw Error(m);},HASH=/^[a-f0-9]{64}$/;
export const ENTRY_CONTEXT_PATH='quality-reports/ci-integration/entry-context.json';
export const entryPointHash=v=>createHash('sha256').update(stableStringify(v)).digest('hex');
export function validateNativeEntry(v){
 assert(v&&Object.keys(v).length===3&&Object.keys(v).every(k=>['loaderFile','loaderHash','runtimeHash'].includes(k)),'公共入口配置须包含固定路径、入口摘要和运行时摘要');
 assert(typeof v.loaderFile==='string'&&path.isAbsolute(v.loaderFile)&&!/[\u0000-\u001f'"`$\\]/.test(v.loaderFile)&&[v.loaderHash,v.runtimeHash].every(h=>HASH.test(h||'')),'公共入口需要受控绝对路径和完整摘要');return v;
}
export function nativePipelineEntry(v){validateNativeEntry(v);return `node('wl-quality-router') { load('${v.loaderFile}') }.call()\n`;}
export function validateNativeSource(c){const v=c.nativeEntry;assert(c.system==='jenkins'&&v&&Object.keys(v).length===2&&Object.keys(v).every(k=>['runtimeHash','entryPointHash'].includes(k))&&Object.values(v).every(h=>HASH.test(h||'')),'公共入口来源须固定运行时和入口摘要');assert(c.artifacts.paths.includes(ENTRY_CONTEXT_PATH)&&!c.artifacts.optionalPaths?.includes(ENTRY_CONTEXT_PATH),'公共入口执行证据必须归档且不能可选');}
export function assertNativeProof(v,c,q){
 assert(v?.schemaVersion===1&&v.kind==='wl-quality-native-execution'&&v.project===c.project&&v.scope===c.scope&&v.sha===q.sha&&v.job===c.jobPath&&String(v.buildNumber)===String(q.runId),'公共入口证据项目/范围/作业/SHA/轮次不匹配');
 assert(v.runtimeHash===c.nativeEntry.runtimeHash&&v.entryPointHash===c.nativeEntry.entryPointHash&&HASH.test(v.sourceDigest||'')&&HASH.test(v.registryHash||'')&&HASH.test(v.bindingHash||''),'公共入口或Gate运行时已变化，旧报告不能复用');return true;
}
