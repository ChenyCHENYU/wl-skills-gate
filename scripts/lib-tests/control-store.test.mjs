import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, readdirSync, renameSync, lstatSync } from 'node:fs';
import { lockedJson } from '../../lib/control-store.js';
const MODULE = new URL('../../lib/control-store.js', import.meta.url).href;
function fixture(t) { const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-control-lock-')); t.after(()=>rmSync(root,{recursive:true,force:true})); return {root,file:path.join(root,'state.json')}; }
const read=(f)=>JSON.parse(readFileSync(f,'utf8'));
function owner(file,overrides={}) { return {schemaVersion:1,kind:'central-json-lock',stateFile:file,pid:process.pid,hostname:os.hostname(),nonce:randomUUID(),start:'2000-01-01T00:00:00Z',...overrides}; }
function putLock(file,value) { mkdirSync(file+'.lock');writeFileSync(path.join(file+'.lock','owner.json'),JSON.stringify(value)); }
function childWorker(t,file,{barrier=false}={}) {
  const script=`import {lockedJson} from ${JSON.stringify(MODULE)};
  const file=${JSON.stringify(file)};
  ${barrier ? "process.send({phase:'ready'});await new Promise(resolve=>process.once('message',resolve));" : ''}
  try {await lockedJson(file,{count:0},async(state,checkpoint)=>{state.count++;checkpoint();process.send({phase:'held',pid:process.pid});await new Promise(resolve=>process.once('message',resolve));});process.send({phase:'done'});}
  catch(error){process.send({phase:'blocked',message:error.message});}
  process.disconnect();`;
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{stdio:['ignore','pipe','pipe','ipc']});
  const messages=[],waiters=[];let stderr='',exit=null;
  child.stderr.on('data',c=>stderr+=c); child.on('message',m=>{messages.push(m);for(const wake of waiters.splice(0))wake();});
  const finished=new Promise(resolve=>child.on('close',(code,signal)=>{exit={code,signal};resolve(exit);for(const wake of waiters.splice(0))wake();}));
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const waitFor=async(phases)=>{
    const deadline=Date.now()+10000;
    while(true){const result=messages.find(m=>phases.includes(m.phase));if(result)return result;if(exit)throw new Error(`worker exited ${JSON.stringify(exit)} ${stderr}`);if(Date.now()>deadline)throw new Error('worker phase timeout');await Promise.race([new Promise(resolve=>waiters.push(resolve)),new Promise(resolve=>setTimeout(resolve,50))]);}
  };
  return {child,finished,waitFor,messages};
}

test('checkpoint在异常前持久化，正常释放只删除自己的非空锁',async(t)=>{
  const {file,root}=fixture(t);
  await assert.rejects(lockedJson(file,{count:0},async(state,checkpoint)=>{assert(existsSync(path.join(file+'.lock','owner.json')));state.count=1;checkpoint();state.count=2;throw new Error('after-checkpoint');}),/after-checkpoint/);
  assert.equal(read(file).count,1);assert.equal(existsSync(file+'.lock'),false);assert.equal(readdirSync(root).filter(v=>v.includes('.pending-')).length,0);
  await lockedJson(file,{},state=>{state.count++;});assert.equal(read(file).count,2);
});

test('真实子进程SIGKILL后的同主机死锁可恢复并永久保留旧nonce隔离目录',async(t)=>{
  const {file}=fixture(t),w=childWorker(t,file);await w.waitFor(['held']);const previous=read(path.join(file+'.lock','owner.json'));
  w.child.kill('SIGKILL');await w.finished;
  await lockedJson(file,{},state=>{state.count++;});
  assert.equal(read(file).count,2);assert.equal(existsSync(file+'.lock'),false);
  const quarantine=file+'.lock.recovered-'+previous.nonce;assert.equal(read(path.join(quarantine,'owner.json')).pid,previous.pid);assert(lstatSync(quarantine).isDirectory());assert(readdirSync(quarantine).length>0);
});

test('活锁即使时间很久也不破；被拒者不能删除赢家的锁',async(t)=>{
  const {file}=fixture(t),w=childWorker(t,file);await w.waitFor(['held']);const before=read(path.join(file+'.lock','owner.json'));
  before.start='2000-01-01T00:00:00Z';writeFileSync(path.join(file+'.lock','owner.json'),JSON.stringify(before));
  await assert.rejects(lockedJson(file,{},()=>{throw new Error('must not enter');}),/活锁/);
  assert.equal(read(path.join(file+'.lock','owner.json')).nonce,before.nonce);w.child.send('release');await w.finished;assert.equal(existsSync(file+'.lock'),false);
});

test('两个进程竞争恢复同一死锁，只有一个入临界区且败者不移动/删除赢家的新锁',async(t)=>{
  const {file,root}=fixture(t),dead=childWorker(t,file);await dead.waitFor(['held']);const previous=read(path.join(file+'.lock','owner.json'));dead.child.kill('SIGKILL');await dead.finished;
  const contenders=[childWorker(t,file,{barrier:true}),childWorker(t,file,{barrier:true})];await Promise.all(contenders.map(w=>w.waitFor(['ready'])));contenders.forEach(w=>w.child.send('start'));
  const outcomes=await Promise.all(contenders.map(w=>w.waitFor(['held','blocked'])));assert.equal(outcomes.filter(v=>v.phase==='held').length,1);assert.equal(outcomes.filter(v=>v.phase==='blocked').length,1);
  const index=outcomes.findIndex(v=>v.phase==='held'),winner=contenders[index],loser=contenders[1-index];await loser.finished;
  const actual=read(path.join(file+'.lock','owner.json'));assert.equal(actual.pid,winner.child.pid);assert.notEqual(actual.nonce,previous.nonce);
  assert.equal(read(path.join(file+'.lock.recovered-'+previous.nonce,'owner.json')).nonce,previous.nonce);assert.equal(read(file).count,2);
  winner.child.send('release');await winner.finished;assert.equal(existsSync(file+'.lock'),false);assert.equal(readdirSync(root).filter(v=>v.includes('.pending-')).length,0);
});

for(const mode of ['empty','corrupt','cross-host','wrong-state','invalid-nonce'])test(`旧锁${mode}不能猜测或盲删`,async(t)=>{
  const {file}=fixture(t);
  if(mode==='empty')mkdirSync(file+'.lock');
  else if(mode==='corrupt'){mkdirSync(file+'.lock');writeFileSync(path.join(file+'.lock','owner.json'),'{invalid');}
  else putLock(file,owner(file,mode==='cross-host'?{hostname:'another-host.invalid'}:mode==='wrong-state'?{stateFile:file+'.other'}:{nonce:'../untrusted'}));
  await assert.rejects(lockedJson(file,{},()=>{throw new Error('must not enter');}),/owner|其他主机/);assert(existsSync(file+'.lock'));assert.equal(existsSync(file),false);
});

test('finally拒绝删除被替换成另一个nonce的锁',async(t)=>{
  const {file}=fixture(t);const replacement=owner(file);
  await assert.rejects(lockedJson(file,{count:0},()=>{renameSync(file+'.lock',file+'.lock.original');putLock(file,replacement);}),/owner已变化/);
  assert.equal(read(path.join(file+'.lock','owner.json')).nonce,replacement.nonce);assert(existsSync(file+'.lock.original'));
});
