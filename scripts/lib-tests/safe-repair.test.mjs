import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {previewSafeSource,planSafeRepair,applySafeRepair} from '../../lib/safe-repair.js';

const put=(root,file,text)=>{mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),text);};
function fixture(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'wl-safe-repair-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 execFileSync('git',['init','-q',root]);
 put(root,'src/a.ts','import {foo,foo} from "pkg";\nexport const config={defaultValue:"YTS0",defaultValue:"YTS0",other:2};\n');
 execFileSync('git',['-C',root,'add','.']);
 execFileSync('git',['-C',root,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 return root;
}
test('固定AST修复重复导入和相邻同值字面量，保留字段顺序且幂等',()=>{
 const input='import {a,a,a,b as c,b as c} from "pkg";\nexport const x={a:"x",a:"x",a:"x",b:2};';
 const result=previewSafeSource(input);
 assert.equal(result.output,'import {a,b as c} from "pkg";\nexport const x={a:"x",b:2};');
 assert.equal(result.edits.length,5);assert.equal(previewSafeSource(result.output).edits.length,0);
});
test('不同值、spread、getter、计算键和__proto__全部保留人工判断',()=>{
 const input='const a={x:1,x:2},b={x:1,...a,x:1},c={get x(){return 1},x:1},d={[a]:1,[a]:1},e={__proto__:null,__proto__:null};';
 assert.equal(previewSafeSource(input).output,input);
});
test('不能丢弃注释或猜测动态初始化值',()=>{
 const input='import {a,/*原因*/a} from "pkg";const x={a:load(),a:load()},b={x:1,/*说明*/x:1};';
 const result=previewSafeSource(input);assert.equal(result.output,input);assert.equal(result.skipped.length,2);
});
test('Vue只修改script候选，template与style逐字节保留',()=>{
 const input='<template><div>原界面</div></template>\n<script setup lang="ts">\nimport {a,a} from "pkg";\n</script>\n<style scoped>.x{color:red}</style>';
 const result=previewSafeSource(input,'src/a.vue');assert.equal(result.output,input.replace('{a,a}','{a}'));
});
test('实际应用不改变暂存区；留备份、回执，仍需复扫且不授予构建',t=>{
 const root=fixture(t);const before=execFileSync('git',['-C',root,'ls-files','--stage'],{encoding:'utf8'});
 const plan=planSafeRepair({root});assert.equal(plan.items.length,1);
 const result=applySafeRepair(plan,{confirm:true});
 assert.equal(result.mechanicalEdits,2);assert.equal(result.qualityPassed,false);assert.equal(result.buildAuthorized,false);assert.equal(result.verification,'pending-full-rescan');
 assert.equal(execFileSync('git',['-C',root,'ls-files','--stage'],{encoding:'utf8'}),before);
 assert.equal(planSafeRepair({root}).items.length,0);assert.ok(readFileSync(path.join(result.outDir,'0.before'),'utf8').includes('foo,foo'));
 assert.equal(JSON.parse(readFileSync(path.join(result.outDir,'plan.json'))).planHash,plan.planHash);
 assert.equal(JSON.parse(readFileSync(path.join(result.outDir,'state.json'))).status,'applied-pending-full-rescan');
});
test('无确认或计划篡改时零写入',t=>{
 const root=fixture(t),plan=planSafeRepair({root}),before=readFileSync(root+'/src/a.ts','utf8');
 assert.throws(()=>applySafeRepair(plan),/confirm/);
 plan.items[0].file='package.json';assert.throws(()=>applySafeRepair(plan,{confirm:true}),/计划/);
 assert.equal(readFileSync(root+'/src/a.ts','utf8'),before);
});
test('预览后普通文件或其他源码变化，整次零写入',t=>{
 const root=fixture(t);put(root,'src/other.ts','export const a=1;');
 const plan=planSafeRepair({root}),before=readFileSync(root+'/src/a.ts','utf8');
 put(root,'src/other.ts','export const a=2;');
 assert.throws(()=>applySafeRepair(plan,{confirm:true}),/零写入/);assert.equal(readFileSync(root+'/src/a.ts','utf8'),before);
});
test('范围不能越界或跟随链接，不碰配置和部署脚本',t=>{
 const root=fixture(t);assert.throws(()=>planSafeRepair({root,targets:['package.json']}),/仅允许src/);
 symlinkSync('../outside.ts',root+'/src/link.ts');assert.throws(()=>planSafeRepair({root}),/链接/);
});
test('其他文件语法错误不会阻止确定性冗余项的预览，失效文件明确留待人工',t=>{
 const root=fixture(t);put(root,'src/broken.ts','export const x = ;');
 const plan=planSafeRepair({root});assert.equal(plan.items.length,1);assert.equal(plan.skipped[0].file,'src/broken.ts');
});
test('Node测试文件用fileURLToPath解码中文／空格路径，不改浏览器或HTTP路径',()=>{
 const source='import test from "node:test";\nconst root=new URL(import.meta.url).pathname;\nconst child=new URL("../a",import.meta.url).pathname;\nconst remote=new URL("https://example.com",import.meta.url).pathname;';
 const result=previewSafeSource(source,'scripts/tests/path.test.mjs');
 assert.ok(result.output.includes('fileURLToPath as wlFileURLToPath'));
 assert.ok(result.output.includes('wlFileURLToPath(new URL(import.meta.url))'));
 assert.ok(result.output.includes('new URL("https://example.com",import.meta.url).pathname'));
 assert.equal(previewSafeSource(result.output,'scripts/tests/path.test.mjs').edits.length,0);
 assert.equal(previewSafeSource(source,'src/browser.ts').output,source);
});
test('测试文件URL被局部绑定时不猜测其类型',()=>{
 const source='import test from "node:test";const URL=CustomURL;const root=new URL(import.meta.url).pathname;';
 assert.equal(previewSafeSource(source,'scripts/tests/path.test.mjs').output,source);
});
