import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {run as frontend} from '../../lib/adapters/frontend.js';
import {run as eslint} from '../../lib/adapters/eslint.js';
import {resolveTypedFiles,verifiedManagedLoaders,validateDuplicateStatistics} from '../../lib/frontend-scope.js';
function fixture(t){const root=mkdtempSync(path.join(os.tmpdir(),'wl-frontend-scope-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
const put=(r,f,v)=>{mkdirSync(path.dirname(path.join(r,f)),{recursive:true});writeFileSync(path.join(r,f),typeof v==='string'?v:JSON.stringify(v));};
const ctx=root=>({root,eventId:'scope-'+Date.now(),project:'fixture',commitSha:'unknown'});
test('类型工程未纳入mjs时显式记录边界，TS漏await仍真实命中且JS安全风险另行检查',async t=>{
 const root=fixture(t);put(root,'src/a.ts','async function save(){return 1;}\nsave();\nexport {};');put(root,'src/check.mjs','export function show(value){document.body.innerHTML=value;}');put(root,'tsconfig.json',{compilerOptions:{strict:true,module:'ESNext',target:'ES2022',moduleResolution:'Bundler'},include:['src/**/*.ts']});
 const typed=await frontend({id:'typed',analyzer:'typed'},ctx(root));assert.equal(typed.status,'ok',typed.reason);assert.ok(typed.findings.some(f=>f.ruleId.endsWith('no-floating-promises')));assert.deepEqual(typed.coverage.notInTypeProject,['src/check.mjs']);
 const security=await frontend({id:'security',analyzer:'security'},ctx(root));assert.equal(security.status,'ok',security.reason);assert.ok(security.findings.some(f=>f.file==='src/check.mjs'&&f.ruleId.includes('no-unsanitized')));
});
test('真实Vue重复扫描保留物理文件与多语言片段统计，不将虚拟来源数当作文件数',async t=>{
 const root=fixture(t);const code=Array.from({length:30},(_,i)=>`export const value${i} = ${i} * 55 + 88;`).join('\n');put(root,'src/a.vue',`<template><div>工单</div></template>\n<script lang="ts">\n${code}\n</script>\n<style>.order { color: red; }</style>`);put(root,'src/b.vue',readFileSync(path.join(root,'src/a.vue'),'utf8'));
 const result=await frontend({id:'duplicates',analyzer:'duplicates'},ctx(root));assert.equal(result.status,'ok',result.reason);assert.equal(result.coverage.physicalInputs,2);assert.ok(result.coverage.nativeVirtualSources>2);assert.ok(result.findings.length>0);
 const native=JSON.parse(readFileSync(path.join(root,result.production.reports[0].file),'utf8')).native;const corrupt=structuredClone(native);corrupt.statistics.total.sources++;assert.throws(()=>validateDuplicateStatistics(corrupt,['src/a.vue','src/b.vue'],root),/不一致/);
});
test('固定薄加载器须同时匹配本包原件和受管摘要，修改后不能借清单绕过扫描',t=>{
 const root=fixture(t),relative='scripts/quality/project-actions.mjs';const bytes=readFileSync(new URL('../../templates/onboarding/automation/project-actions.mjs',import.meta.url));put(root,relative,bytes.toString());const hash=b=>createHash('sha256').update(b).digest('hex');
 put(root,'quality/workspace.json',{kind:'wl-quality-workspace',projectKind:'frontend',managedFiles:[{path:relative,sha256:hash(bytes)}]});assert.deepEqual(verifiedManagedLoaders(root,[relative]),[relative]);
 const modified=bytes.toString()+'\ndocument.body.innerHTML=location.hash;';put(root,relative,modified);put(root,'quality/workspace.json',{kind:'wl-quality-workspace',projectKind:'frontend',managedFiles:[{path:relative,sha256:hash(modified)}]});assert.deepEqual(verifiedManagedLoaders(root,[relative]),[]);
});
test('增量ESLint仅接收批准src范围，脚本不能被错误送入不适用的项目配置',async t=>{
 const root=fixture(t);execFileSync('git',['init','-q',root]);put(root,'src/a.ts','export const a=1;');put(root,'scripts/quality/a.mjs','export const a=1;');execFileSync('git',['-C',root,'add','.']);
 const outside=await eslint({id:'lint',targets:['missing-scope']},{...ctx(root),scope:'staged'});assert.equal(outside.status,'ok');assert.equal(outside.coverage.noApplicableFiles,true);assert.deepEqual(outside.coverage.requestedFiles,[]);
});
