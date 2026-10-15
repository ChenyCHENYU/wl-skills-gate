import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runProjectSetup, parseSetupArgs, writeSetupResult } from '../../lib/setup.js';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(packageRoot, 'bin/wl-skills-gate.js');
const registry = 'https://registry.npmjs.org/';
function root(t) {
 const r=mkdtempSync(path.join(os.tmpdir(),'wl-setup-session-'));
 execFileSync('git',['init','-q',r]); t.after(()=>rmSync(r,{recursive:true,force:true})); return r;
}
const plan=(root, hash, phase='native-ready')=>({root,projectKind:'backend',status:'configuration-planned',planHash:hash,files:[],hardConflicts:[],complete:{status:phase,blockers:[]}});
test('交互协调器每阶段重算并仅携带本阶段已确认hash；成功必须实际localValidated', async t=>{
 const r=root(t), hashes=[], seen=[], states=['native-approval-required','pom-approval-required','lock-approval-required','local-validated-awaiting-remote-acceptance']; let index=0;
 const result=await runProjectSetup({root:r,registry,planner:()=>plan(r,'hash-'+index),onPlan:async p=>{seen.push(p.plan.planHash);return true;},applier:o=>{hashes.push(o.planHash);return {status:states[index++],complete:{localValidated:index===4}};}});
 assert.deepEqual(hashes,seen); assert.equal(hashes.length,4); assert.equal(result.localValidated,true); assert.equal(result.remoteValidated,false); assert.equal(result.businessClosureValidated,false);
 assert.equal(JSON.parse(readFileSync(result.reportFile)).steps.length,4); assert.match(readFileSync(result.htmlFile,'utf8'),/本地验证：通过/);
});
test('预览不写目录、不请求确认、不执行安装',async t=>{
 const r=root(t), before=readdirSync(r); let invoked=false;
 const result=await runProjectSetup({root:r,registry,preview:true,planner:()=>plan(r,'x'),onPlan:()=>{invoked=true;},applier:()=>{invoked=true;}});
 assert.equal(result.status,'preview'); assert.equal(invoked,false); assert.deepEqual(readdirSync(r),before);
});
test('取消不应用计划；重开不会覆盖历史反馈',async t=>{
 const r=root(t); let calls=0; const options={root:r,registry,planner:()=>plan(r,'x'),onPlan:()=>false,applier:()=>{calls++;}};
 const first=await runProjectSetup(options),second=await runProjectSetup(options);
 assert.equal(first.status,'canceled'); assert.equal(calls,0); assert.notEqual(first.reportFile,second.reportFile); assert.ok(existsSync(first.reportFile));
});
test('预检阻断、过期确认、执行失败和重复计划都不给绿且不无限重试',async t=>{
 const r=root(t); let calls=0;
 const blocked=await runProjectSetup({root:r,registry,planner:()=>({...plan(r,'blocked'),hardConflicts:[{reason:'missing runtime'}]}),onPlan:()=>{throw Error('should not ask');},applier:()=>calls++});
 assert.equal(blocked.status,'blocked'); assert.equal(calls,0);
 const stale=await runProjectSetup({root:r,registry,planner:()=>plan(r,'old'),onPlan:()=>true,applier:()=>{calls++;throw Error('planHash changed');}});
 assert.equal(stale.localValidated,false); assert.match(stale.failure,/planHash changed/); assert.equal(calls,1);
 const repeated=await runProjectSetup({root:r,registry,planner:()=>plan(r,'same'),onPlan:()=>true,applier:()=>({status:'native-approval-required'})});
 assert.equal(repeated.steps.length,1); assert.match(repeated.failure,/没有进展/);
 const falseSuccess=await runProjectSetup({root:r,registry,planner:()=>plan(r,'green'),onPlan:()=>true,applier:()=>({status:'local-validated-awaiting-remote-acceptance',complete:{localValidated:false}})});
 assert.equal(falseSuccess.status,'blocked'); assert.equal(falseSuccess.localValidated,false);
});
test('反馈HTML转义不可信错误，报告只新建',t=>{
 const r=root(t),result=writeSetupResult(r,{root:'<script>x</script>',status:'blocked',steps:[{phase:'<img>',failure:'<svg/onload=alert(1)>'}],nextAction:'x'});
 const html=readFileSync(result.htmlFile,'utf8'); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<svg')); assert.match(html,/&lt;script&gt;/);
 assert.throws(()=>writeSetupResult(r,{}),/EEXIST/);
});
test('报告路径链接不能借接入写到项目外',async t=>{
 const r=root(t),external=root(t);symlinkSync(external,path.join(r,'quality-reports'));
 const result=await runProjectSetup({root:r,registry,planner:()=>plan(r,'x'),onPlan:()=>true,applier:()=>{throw Error('must not run');}});
 assert.equal(result.status,'blocked');assert.deepEqual(readdirSync(external),['.git']);
});
test('模式参数严格、预览不能夹带执行/自动确认',()=>{
 for(const args of [['project','--confirm'],['workspace','--registry',registry],['release-input','--start'],['central','--preview','--start'],['central','--confirm'],['workspace','--plan-hash','x'],['project','--root','x','--root','x']]) assert.throws(()=>parseSetupArgs(args));
 assert.equal(parseSetupArgs(['central','--start','--confirm','--plan-hash','x'])['plan-hash'],'x');
});
test('真实非TTY入口预览无项目写入，错误参数非零反馈',t=>{
 const r=root(t);writeFileSync(path.join(r,'package.json'),JSON.stringify({name:'wl-ui-produce',packageManager:'pnpm@11.21.0',dependencies:{vue:'3.5.0'},devDependencies:{'@agile-team/wl-skills-kit':'2.33.1'}}));
 execFileSync('git',['-C',r,'add','.']);execFileSync('git',['-C',r,'-c','user.name=fixture','-c','user.email=f@example.invalid','commit','-qm','fixture']);
 const before=execFileSync('git',['-C',r,'status','--porcelain'],{encoding:'utf8'});
 const result=spawnSync(process.execPath,[cli,'setup','project','--root',r,'--registry',registry,'--json'],{encoding:'utf8'});
 const output=JSON.parse(result.stdout);assert.ok(['preview','blocked'].includes(output.status));assert.equal(existsSync(path.join(r,'quality-reports')),false);
 assert.equal(execFileSync('git',['-C',r,'status','--porcelain'],{encoding:'utf8'}),before);
 const bad=spawnSync(process.execPath,[cli,'setup','project','--confirm'],{encoding:'utf8'});assert.equal(bad.status,2);assert.match(bad.stderr,/不支持/);
});
test('macOS/Linux启动器可带固定参数调用同一CLI，无TTY菜单不擅自执行',t=>{
 const r=root(t);const menu=spawnSync('sh',[path.join(packageRoot,'templates/launchers/setup.command')],{encoding:'utf8'}); assert.equal(menu.status,2);assert.match(menu.stderr,/交互终端/);
 const negative=spawnSync('sh',[path.join(packageRoot,'templates/launchers/setup.sh'),'project','--root',r,'--registry',registry,'--preview','--json'],{encoding:'utf8'});
 assert.equal(negative.status,2);assert.equal(JSON.parse(negative.stdout).status,'blocked'); assert.equal(existsSync(path.join(r,'quality-reports')),false);
});
