import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {planOnboarding,applyOnboarding} from '../../lib/onboard.js';
import {gateRuntimeHash,GATE_ROOT,GATE_VERSION} from '../../lib/jenkins-integration.js';
import {planIncrementalUpdate,applyIncrementalUpdate} from '../../lib/incremental-update.js';
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const put=(root,file,value)=>{mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');};
const commit=root=>{git(root,'add','.');git(root,'-c','core.hooksPath=/dev/null','commit','-qm','chore: seed test fixture');};
function adopted(t,{kind='frontend',hooks='.husky/_'}={}){
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-repeat-layout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 git(root,'init','-q');git(root,'config','user.name','Fixture');git(root,'config','user.email','fixture@example.invalid');git(root,'config','core.hooksPath',hooks);
 if(kind==='frontend')put(root,'package.json',{name:'repeat-layout',private:true,dependencies:{vue:'3.5.42'},devDependencies:{'@agile-team/wl-skills-kit':'2.33.1'},packageManager:'pnpm@10.34.5'});
 else{put(root,'pom.xml','<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId></project>');put(root,'wl-produce-pl/wl-produce-pl-service/pom.xml','<project><artifactId>service</artifactId></project>');put(root,'wl-produce-pl/wl-produce-pl-service/src/main/java/example/Fixture.java','package example; public class Fixture {}\n');mkdirSync(path.join(root,'wl-produce-pl/wl-produce-pl-service/src/test/java'),{recursive:true});}
 commit(root);const input={root,kind,registry:'https://registry.npmjs.org/'};const p=planOnboarding(input);assert.deepEqual(p.hardConflicts,[]);applyOnboarding({...input,confirm:true,planHash:p.planHash});commit(root);git(root,'config','--unset','core.hooksPath');return {root,input};
}
for(const [kind,hooks] of [['frontend','.husky/_'],['frontend','scripts/approved-hooks'],['backend','scripts/quality/git-hooks']])test(kind+'新克隆沿用'+hooks+'，不另建Hook目录',t=>{
 const f=adopted(t,{kind,hooks});const before=git(f.root,'status','--porcelain'),p=planOnboarding({...f.input,allowDependencyUpdates:true});
 assert.deepEqual(p.hardConflicts,[]);assert.equal(p.hooks.activation.after,hooks);assert.equal(p.hooks.destination,hooks==='.husky/_'?'.husky':hooks);
 assert.ok(!p.files.some(item=>item.path.startsWith('.githooks/')&&item.action==='create'));assert.equal(git(f.root,'status','--porcelain'),before);
 const w=JSON.parse(p.files.find(f=>f.path==='quality/workspace.json').afterContent);assert.equal(w.hooksPath,hooks);
});
test('已登记Hook漂移时不新建默认Hook来绕过冲突',t=>{
 const f=adopted(t);put(f.root,'.husky/pre-push','#!/bin/sh\necho custom\n');const p=planOnboarding({...f.input,allowDependencyUpdates:true});
 assert.ok(p.hardConflicts.some(c=>/Hook原件|批准原件/.test(c.reason)));assert.ok(!existsSync(path.join(f.root,'.githooks')));
});
test('已登记Hook越界时保留现场且拒绝恢复',t=>{
 const f=adopted(t);const w=JSON.parse(readFileSync(path.join(f.root,'quality/workspace.json')));w.hooksPath='../outside';put(f.root,'quality/workspace.json',w);commit(f.root);
 const p=planOnboarding({...f.input,allowDependencyUpdates:true});assert.ok(p.hardConflicts.some(c=>/明确路径/.test(c.reason)));assert.ok(!existsSync(path.join(f.root,'.githooks')));
});
test('固定包新增IDE资产只创建一次，第二次增量计划无变化',async t=>{
 const f=adopted(t,{hooks:'.githooks'});rmSync(path.join(f.root,'.vscode/tasks.json'));commit(f.root);
 const input={root:f.root,manifest:{snapshot:'test',packages:[]},map:{gateVersion:GATE_VERSION,runtimeFingerprint:gateRuntimeHash()},settings:{projectRoot:f.root},mode:'project',projectRoot:f.root,gateHome:GATE_ROOT};
 const p=await planIncrementalUpdate(input);assert.deepEqual(p.blockers,[]);assert.equal(p.status,'delta-ready');assert.deepEqual(p.changes.map(c=>path.relative(f.root,c.target)),['.vscode/tasks.json']);
 await applyIncrementalUpdate(p,{confirm:true,planHash:p.planHash});assert.equal((await planIncrementalUpdate(input)).status,'unchanged');
});
test('已有未登记IDE文件不能借新增资产规则被覆盖',async t=>{
 const f=adopted(t,{hooks:'.githooks'});put(f.root,'.vscode/tasks.json',{version:'2.0.0',tasks:[{label:'custom',type:'shell',command:'echo owned'}]});commit(f.root);const before=readFileSync(path.join(f.root,'.vscode/tasks.json'));
 const input={root:f.root,manifest:{snapshot:'test',packages:[]},map:{gateVersion:GATE_VERSION,runtimeFingerprint:gateRuntimeHash()},settings:{projectRoot:f.root},mode:'project',projectRoot:f.root,gateHome:GATE_ROOT};
 const p=await planIncrementalUpdate(input);assert.ok(p.blockers.some(b=>b.id==='UPDATE-NATIVE-ADAPTER-REQUIRED'));assert.deepEqual(readFileSync(path.join(f.root,'.vscode/tasks.json')),before);
});
