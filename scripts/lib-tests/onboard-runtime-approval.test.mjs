import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

test('接入审批绑定整个Gate运行时：未手列传递依赖字节改变使planHash失效，无变与恢复保持稳定',async t=>{
 const dir=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-approval-runtime-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=fileURLToPath(new URL('../../',import.meta.url)),gate=path.join(dir,'fixed-gate'),project=path.join(dir,'project');
 mkdirSync(gate);mkdirSync(project);
 for(const name of ['package.json','npm-shrinkwrap.json','bin','lib','templates','schemas','assets','scripts'])cpSync(path.join(source,name),path.join(gate,name),{recursive:true});
 writeFileSync(path.join(project,'package.json'),JSON.stringify({name:'wl-ui-produce',packageManager:'pnpm@10.34.5',dependencies:{vue:'3'},devDependencies:{'@agile-team/wl-skills-kit':'2.33.1'}},null,2)+'\n');
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','initial']]){const r=spawnSync('git',['-C',project,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 const {planOnboarding}=await import(pathToFileURL(path.join(gate,'lib/onboard.js'))),options={root:project,registry:'https://registry.npmjs.org/'};
 const first=planOnboarding(options),same=planOnboarding(options);assert.equal(first.planHash,same.planHash);assert.equal(first.runtimeFingerprint,same.runtimeFingerprint);
 const relative='lib/risk.js',file=path.join(gate,relative),original=readFileSync(file);assert.ok(!first.implementation.some(f=>f.path===relative),'fixture must exercise transitive implementation omitted from manual list');
 writeFileSync(file,Buffer.concat([original,Buffer.from('\n// controlled transitive implementation change\n')]));
 const changed=planOnboarding(options);assert.notEqual(changed.runtimeFingerprint,first.runtimeFingerprint);assert.notEqual(changed.planHash,first.planHash);
 assert.deepEqual(changed.implementation,first.implementation,'manual list is unchanged; complete runtime binding detects this change');
 writeFileSync(file,original);assert.equal(planOnboarding(options).planHash,first.planHash);
});
