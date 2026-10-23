import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,existsSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planOnboarding,applyOnboarding} from '../../lib/onboard.js';
import {planLifecycle} from '../../lib/onboard-lifecycle.js';
import {shellExecutionLines} from '../../lib/prepare-hooks.js';
const huskySource=process.env.WL_TEST_HUSKY_ROOT;
const needsHusky={skip:!huskySource?'真实Husky离线回归需要WL_TEST_HUSKY_ROOT指向已安装Husky9':false};
const gate=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const put=(r,f,v)=>{mkdirSync(path.dirname(path.join(r,f)),{recursive:true});writeFileSync(path.join(r,f),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n');};
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t,prepare='husky'){
 const r=mkdtempSync(path.join(os.tmpdir(),'wl-prepare-'));t.after(()=>rmSync(r,{recursive:true,force:true}));git(r,'init','-q');git(r,'config','user.name','fixture');git(r,'config','user.email','fixture@example.invalid');
 put(r,'package.json',{name:'wl-ui-produce',type:'module',packageManager:'pnpm@10.34.5',dependencies:{vue:'3.5.0'},devDependencies:{'@agile-team/wl-skills-kit':'2.33.1',husky:'9.1.7'},scripts:{prepare}});
 git(r,'add','.');git(r,'-c','core.hooksPath=/dev/null','commit','-qm','fixture');return r;
}
function apply(r){const input={root:r,registry:'https://registry.npmjs.org/',allowDependencyUpdates:true};const p=planOnboarding(input);assert.equal(p.hardConflicts.length,0,JSON.stringify(p.hardConflicts));applyOnboarding({...input,planHash:p.planHash,confirm:true});return p;}
function install(r){
 const h=huskySource;
 cpSync(h,path.join(r,'node_modules/husky'),{recursive:true,dereference:true});
 const pkg=JSON.parse(readFileSync(path.join(gate,'package.json')));put(r,'node_modules/@agile-team/wl-skills-gate/package.json',{...pkg});for(const file of ['npm-shrinkwrap.json','lib','bin','templates','assets','schemas','scripts'])cpSync(path.join(gate,file),path.join(r,'node_modules/@agile-team/wl-skills-gate',file),{recursive:true});put(r,'node_modules/@agile-team/wl-skills-gate/assets/java-reference.lock.json',readFileSync(path.join(gate,'assets/java-reference.lock.json'),'utf8'));put(r,'node_modules/@agile-team/wl-skills-gate/templates/onboarding/automation/project-env.sh',readFileSync(path.join(gate,'templates/onboarding/automation/project-env.sh'),'utf8'));
}
test('全行注释不算重复执行，真实命令保留',()=>{assert.equal(shellExecutionLines(' # node wl-skills-kit validate\nnode check.js'),'node check.js');assert.match(shellExecutionLines('node wl-skills-kit validate'),/validate/);});
test('注释旧Hook不误报，而活动旧生产者仍阻断',t=>{const r=fixture(t);put(r,'.husky/pre-push','#!/bin/sh\n# node node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js validate --typecheck\n');const p=planOnboarding({root:r});assert.ok(!p.gaps.some(g=>g.id==='LEGACY-DUPLICATE-CHECK'));put(r,'.husky/pre-push','#!/bin/sh\nnode node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js validate --typecheck\n');assert.ok(planOnboarding({root:r}).gaps.some(g=>g.id==='LEGACY-DUPLICATE-CHECK'));});
test('真实新clone npm prepare保留Husky准备并恢复三个受控Hook，重复执行无扫描',needsHusky,t=>{
 const r=fixture(t);apply(r);git(r,'add','.');git(r,'-c','core.hooksPath=/dev/null','commit','-qm','adopt');const clone=r+'-clone';t.after(()=>rmSync(clone,{recursive:true,force:true}));execFileSync('git',['clone','-q',r,clone]);install(clone);
 for(let i=0;i<2;i++){const run=spawnSync('npm',['run','prepare','--ignore-scripts=false'],{cwd:clone,encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(git(clone,'config','--get','core.hooksPath'),'.githooks');assert.ok(existsSync(path.join(clone,'.husky/_/h')));assert.ok(!existsSync(path.join(clone,'quality-reports/quality-summary.json')));assert.ok(existsSync(path.join(clone,'.git/wl-quality/project-environment.json')));const environment=JSON.parse(readFileSync(path.join(clone,'.git/wl-quality/project-environment.json')));assert.equal(environment.tools.manager.name,'pnpm');assert.equal(environment.tools.manager.version,'10.34.5');assert.equal(environment.notCiAuthorization,true);}
});
test('伪造Hook摘要或受管prepare脚本后拒绝执行且不让Husky抢走Gate',needsHusky,t=>{const r=fixture(t);apply(r);install(r);put(r,'.githooks/pre-commit','#!/bin/sh\nexit 0\n');const run=spawnSync('npm',['run','prepare'],{cwd:r,encoding:'utf8'});assert.equal(run.status,2);assert.match(run.stderr,/Hook摘要不符/);assert.equal(git(r,'config','--get','core.hooksPath'),'.githooks');});
test('自定义prepare保留原文并由生命周期适配明确阻断',t=>{const r=fixture(t,'node scripts/custom.js');const p=planOnboarding({root:r});const m=JSON.parse(p.files.find(f=>f.path==='package.json').afterContent);assert.equal(m.scripts.prepare,'node scripts/custom.js');const lifecycle=planLifecycle({root:r,kind:'frontend',manifestContent:JSON.stringify(m)});assert.ok(lifecycle.blockers.some(b=>b.lifecycle==='prepare'));});

test('已有Husky转发模式仍保留真实转发器并恢复受控Hook链',needsHusky,t=>{const r=fixture(t);git(r,'config','core.hooksPath','.husky/_');apply(r);install(r);const run=spawnSync('npm',['run','prepare'],{cwd:r,encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(git(r,'config','--get','core.hooksPath'),'.husky/_');assert.ok(existsSync(path.join(r,'.husky/_/pre-commit')));});
