import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {projectInitializationRoute} from '../../lib/init-route.js';
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n';
function fixture(t){
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-init-route-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(path.join(root,'quality'));mkdirSync(path.join(root,'.githooks'));writeFileSync(path.join(root,'.githooks/pre-push'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const manifest={schemaVersion:1,kind:'wl-quality-workspace',projectKind:'frontend',registry:'https://registry.npmjs.org/',hookFiles:[{path:'.githooks/pre-push',sha256:hash(readFileSync(path.join(root,'.githooks/pre-push')))}]};
 writeFileSync(path.join(root,'quality/workspace.json'),json(manifest));execFileSync('git',['-C',root,'init','-q']);return root;
}
const commit=root=>{execFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'-c','core.hooksPath=/dev/null','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','chore: fixture']);};
function receipt(root,value){mkdirSync(path.join(root,'quality-reports/onboarding'),{recursive:true});writeFileSync(path.join(root,'quality-reports/onboarding/execution.json'),json({kind:'onboarding-execution',root,...value}));}
test('仅已生成清单且安装失败时同入口继续project，不误转workspace',t=>{const root=fixture(t);receipt(root,{status:'onboarding-execution-blocked',localValidated:false,stages:[{id:'dependencies-install',exitCode:1}]});assert.equal(projectInitializationRoute({root}).mode,'project');assert.equal(projectInitializationRoute({root}).reason,'resume-incomplete-onboarding');});
test('已提交配置但实际首扫未完成也继续project，不能借HEAD假称完成',t=>{const root=fixture(t);commit(root);receipt(root,{status:'native-approval-required',localValidated:false});assert.equal(projectInitializationRoute({root}).mode,'project');});
test('本轮接入真实localValidated回执转workspace',t=>{const root=fixture(t);receipt(root,{status:'local-validated-awaiting-remote-acceptance',localValidated:true});assert.equal(projectInitializationRoute({root}).mode,'workspace');});
test('旧已接项目和新clone无本机回执时用已提交清单及Hook判定workspace',t=>{const root=fixture(t);commit(root);assert.equal(projectInitializationRoute({root}).reason,'committed-adopted-project');assert.equal(projectInitializationRoute({root}).mode,'workspace');});
test('仅生成未提交清单无回执应继续project接入',t=>{const root=fixture(t);assert.equal(projectInitializationRoute({root}).mode,'project');});
test('旧已接Hook漂移不切首次接入覆盖',t=>{const root=fixture(t);commit(root);writeFileSync(path.join(root,'.githooks/pre-push'),'echo edited');assert.throws(()=>projectInitializationRoute({root}),/Hook原件缺失或漂移/);});
test('其他项目和损坏回执都明确拒绝，不自动重置',t=>{const root=fixture(t);receipt(root,{root:'/different',localValidated:false});assert.throws(()=>projectInitializationRoute({root}),/不属于本项目/);writeFileSync(path.join(root,'quality-reports/onboarding/execution.json'),'invalid');assert.throws(()=>projectInitializationRoute({root}),/无法读取/);});
test('回执符号链接不读取，保留原件',t=>{const root=fixture(t),target=path.join(root,'execution.json');writeFileSync(target,json({localValidated:true}));mkdirSync(path.join(root,'quality-reports/onboarding'),{recursive:true});symlinkSync(target,path.join(root,'quality-reports/onboarding/execution.json'));assert.throws(()=>projectInitializationRoute({root}),/符号链接/);});
