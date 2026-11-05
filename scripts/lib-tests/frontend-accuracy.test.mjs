import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {run as frontend} from '../../lib/adapters/frontend.js';
import {typecheckFindings} from '../../lib/adapters/typecheck.js';
import {frontendModuleDeclarations,declaredFrontendModule} from '../../lib/frontend-modules.js';
const put=(root,file,text)=>{mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),typeof text==='string'?text:JSON.stringify(text));};
function fixture(t,strict=false){const root=mkdtempSync(path.join(os.tmpdir(),'wl-accuracy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));put(root,'tsconfig.json',{compilerOptions:{strict,target:'ES2022',module:'ESNext',moduleResolution:'Bundler'},include:['src/**/*.ts']});return root;}
const ctx=root=>({root,eventId:'accuracy-'+Date.now(),commitSha:'unknown',project:'fixture'});
test('strictNullChecks关闭时条件规则明确记录不适用，不淹没逐文件；漏await仍拦截',async t=>{
 const root=fixture(t);put(root,'src/a.ts','export const enabled=true; if(enabled) console.log(enabled); async function save(){return 1;} save();');
 const result=await frontend({id:'typed',analyzer:'typed'},ctx(root));
 assert.equal(result.status,'ok',result.reason);assert.ok(result.findings.some(f=>f.ruleId.endsWith('no-floating-promises')));
 assert.ok(!result.findings.some(f=>f.ruleId.endsWith('no-unnecessary-condition')));
 assert.equal(result.coverage.inapplicableRules.length,1);assert.deepEqual(result.coverage.inapplicableRules[0].files,['src/a.ts']);
});
test('严格类型工程继续执行条件规则，不整体停用检查',async t=>{
 const root=fixture(t,true);put(root,'src/a.ts','export const enabled=true; if(enabled) console.log(enabled);');
 const result=await frontend({id:'typed',analyzer:'typed'},ctx(root));assert.equal(result.status,'ok',result.reason);
 assert.ok(result.findings.some(f=>f.ruleId.endsWith('no-unnecessary-condition')));assert.equal(result.coverage.inapplicableRules,undefined);
});
test('有意解构排除字段不报无用变量，真正无用变量仍报',async t=>{
 const root=fixture(t,true);put(root,'src/a.ts','const row={editing:true,id:1};const {editing,...payload}=row;console.log(payload);const unused=1;export {};');
 const result=await frontend({id:'typed',analyzer:'typed'},ctx(root));assert.equal(result.status,'ok',result.reason);
 const messages=result.findings.filter(f=>f.ruleId.endsWith('no-unused-vars')).map(f=>f.message);assert.ok(messages.some(m=>m.includes('unused')));assert.ok(!messages.some(m=>m.includes("'editing'")));
});
test('运行图解析包exports并忽略纯类型环，仍拦截真实循环及缺包',async t=>{
 const root=fixture(t,true);
 put(root,'node_modules/export-only/package.json',{name:'export-only',type:'module',exports:{'.':{import:'./runtime.js'}}});put(root,'node_modules/export-only/runtime.js','export const value=1;');
 put(root,'src/type-a.ts','import type {B} from "./type-b";export type A={b?:B};');put(root,'src/type-b.ts','import type {A} from "./type-a";export type B={a?:A};');
 put(root,'src/a.ts','import {b} from "./b";import {value} from "export-only";export const a=()=>b()+value;');put(root,'src/b.ts','import {a} from "./a";export const b=()=>a();');put(root,'src/missing.ts','import {x} from "real-missing";export {x};');
 const result=await frontend({id:'architecture',analyzer:'architecture'},ctx(root));assert.equal(result.status,'ok',result.reason);
 assert.ok(result.findings.some(f=>f.ruleId==='FE/ARCH/no-circular'));assert.ok(!result.findings.some(f=>f.file.includes('type-')));
 assert.ok(result.findings.some(f=>f.ruleId==='FE/ARCH/no-unresolved'&&f.message.includes('real-missing')));assert.ok(!result.findings.some(f=>f.message.includes('export-only')));
});
test('类型诊断保留真实文件、行号及平台归属，不再截成一条泛化失败',()=>{
 const rows=typecheckFindings('/project/src/a.ts(12,3): error TS2300: Duplicate identifier.\n/project/node_modules/platform/a.ts(9,2): error TS2416: Type mismatch.','/project');
 assert.equal(rows.length,2);assert.equal(rows[0].line,12);assert.equal(rows[0].file,'src/a.ts');assert.equal(rows[1].file,'node_modules/platform/a.ts');assert.equal(JSON.parse(rows[1].context).owner,'platform-dependency');
 assert.throws(()=>typecheckFindings('/outside/a.ts(1,1): error TS2300: Invalid.','/project'),/超出/);
});
test('只从实际Vite配置依赖图识别联邦及虚拟声明，不执行配置或伪造远端可用',t=>{
 const root=fixture(t);put(root,'node_modules/@originjs/vite-plugin-federation/package.json',{name:'@originjs/vite-plugin-federation'});
 put(root,'vite.config.ts','import make from "./vite/plugins";throw new Error("不应执行");export default make();');
 put(root,'vite/plugins/index.ts','import federation from "@originjs/vite-plugin-federation";import svg from "./svg";export default function make(){const remotes={main:"/assets/remoteEntry.js"};return [federation({remotes:{...remotes}}),svg()];}');
 put(root,'vite/plugins/svg.ts','const REGISTER="virtual:svg-icons-register";export default ()=>({resolveId(id){return id===REGISTER?id:null;}});');
 put(root,'vite/unused.ts','const unused="virtual:fake";export function resolveId(){return unused;}');
 const declarations=frontendModuleDeclarations(root);
 assert.ok(declaredFrontendModule('main/store',declarations));assert.ok(declaredFrontendModule('virtual:__federation__',declarations));assert.ok(declaredFrontendModule('virtual:svg-icons-register',declarations));
 assert.ok(!declaredFrontendModule('virtual:fake',declarations));assert.ok(!declaredFrontendModule('missing/store',declarations));assert.equal(declarations.remoteAvailabilityVerified,false);
});
test('缺少真实插件安装或配置未引用的声明不会成为通配白名单',t=>{
 const root=fixture(t);put(root,'vite.config.ts','import federation from "@originjs/vite-plugin-federation";federation({remotes:{fake:"/x"}});');
 const declarations=frontendModuleDeclarations(root);assert.equal(declaredFrontendModule('fake/store',declarations),false);
});
