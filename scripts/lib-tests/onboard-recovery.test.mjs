import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {planOnboarding,applyOnboarding} from '../../lib/onboard.js';
import {recoverIncompleteAdoption} from '../../lib/onboard-recovery.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const put=(r,f,v)=>{mkdirSync(path.dirname(path.join(r,f)),{recursive:true});writeFileSync(path.join(r,f),typeof v==='string'?v:JSON.stringify(v,null,2)+'\n');};
function fixture(t,withEvidence=true){
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'wl-recovery-')));t.after(()=>rmSync(root,{recursive:true,force:true}));const git=(...a)=>execFileSync('git',['-C',root,...a],{stdio:['ignore','pipe','pipe']});git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');put(root,'package.json',{name:'wl-ui-produce',packageManager:'pnpm@10.34.5',dependencies:{vue:'3.5.0'},devDependencies:{'@agile-team/wl-skills-kit':'2.33.1'}});git('add','.');git('commit','-qm','fixture');
 const options={root,registry:'https://registry.npmjs.org/',allowDependencyUpdates:true},original=planOnboarding(options);applyOnboarding({...options,planHash:original.planHash,confirm:true});
 const workspace=JSON.parse(readFileSync(path.join(root,'quality/workspace.json')));workspace.gateVersion='0.0.1';put(root,'quality/workspace.json',workspace);const pkg=JSON.parse(readFileSync(path.join(root,'package.json')));pkg.devDependencies['@agile-team/wl-skills-gate']='0.0.1';put(root,'package.json',pkg);
 const plan=structuredClone(original);for(const f of plan.files){f.afterContent=readFileSync(path.join(root,f.path),'utf8');f.afterHash=hash(f.afterContent);}delete plan.planHash;plan.planHash=hash(stable(plan));
 const session=randomUUID(),run=randomUUID(),planFile=path.join(root,'quality-reports/setup',session,'plan-1.json'),receipt=path.join(root,'quality-reports/onboarding/executions',run+'.json');
 if(withEvidence){put(root,path.relative(root,planFile),plan);put(root,path.relative(root,receipt),{schemaVersion:1,kind:'onboarding-execution',root,projectKind:'frontend',runId:run,planHash:plan.planHash,status:'onboarding-execution-blocked',localValidated:false});put(root,'quality-reports/setup/'+session+'/result.json',{schemaVersion:1,kind:'project-setup-session',root,sessionId:session,status:'blocked',localValidated:false,steps:[{planFile,receipt}]});}
 return {root,options,planFile,receipt,workspace};
}
test('失败会话、原计划及不可变执行链完整时允许跨版本恢复，策略保持原字节',t=>{const x=fixture(t);const p=planOnboarding(x.options);assert.deepEqual(p.hardConflicts,[]);assert.ok(p.legacyMigrations.some(m=>m.kind==='verified-incomplete-installation-recovery'));const before=readFileSync(path.join(x.root,'quality/policy.yml'),'utf8');applyOnboarding({...x.options,planHash:p.planHash,confirm:true});assert.equal(readFileSync(path.join(x.root,'quality/policy.yml'),'utf8'),before);});
test('没有原会话链的任意未提交旧manifest仍拒绝',t=>{const x=fixture(t,false);assert.ok(planOnboarding(x.options).hardConflicts.some(c=>c.target==='quality/workspace.json'));});
test('篡改计划而不匹配摘要时拒绝恢复',t=>{const x=fixture(t);const p=JSON.parse(readFileSync(x.planFile));p.files[0].afterContent+='x';writeFileSync(x.planFile,JSON.stringify(p));assert.ok(planOnboarding(x.options).hardConflicts.some(c=>c.target==='quality/workspace.json'));});
test('实际Hook或策略改动不能套旧会话继续',t=>{const x=fixture(t);put(x.root,'.githooks/pre-commit','#!/bin/sh\nexit 0\n');assert.ok(planOnboarding(x.options).hardConflicts.length);});
test('执行记录来自别的项目或已声明完成均不能代替未提交批准',t=>{const x=fixture(t);const e=JSON.parse(readFileSync(x.receipt));e.root+='/foreign';writeFileSync(x.receipt,JSON.stringify(e));assert.ok(planOnboarding(x.options).hardConflicts.length);});
