import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {planOnboarding,applyOnboarding} from '../../lib/onboard.js';

test('后端接入实际Git忽略根与多层模块缓存，保留Catalog和策略跟踪，重跑无重复差异',t=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-module-ignore-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(rel,body='{}\n')=>{const file=path.join(root,rel);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body);};
 const git=(...args)=>spawnSync('git',['-C',root,...args],{encoding:'utf8'});
 assert.equal(git('init','-q').status,0);
 put('pom.xml','<project><modelVersion>4.0.0</modelVersion><artifactId>wl-produce</artifactId></project>\n');
 put('wl-produce-pl/wl-produce-pl-service/pom.xml','<project><artifactId>wl-produce-pl-service</artifactId></project>\n');
 put('.gitignore','# Existing project setting\n*.local\n');
 const options={root,kind:'backend'},plan=planOnboarding(options);
 assert.equal(plan.hardConflicts.length,0,JSON.stringify(plan.hardConflicts));
 applyOnboarding({...options,planHash:plan.planHash,confirm:true});
 for(const prefix of ['', 'wl-produce-pl/', 'group/module/']){
  for(const rel of ['.wl-skills-bd/runs/run-1/receipt.json','.wl-skills-bd/.state/source-index-cache-v1.json']){
   put(prefix+rel);const r=git('check-ignore','--no-index','-v','--',prefix+rel);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/\*\*\/\.wl-skills-bd\//);
  }
  for(const rel of ['.wl-skills-bd/catalog.config.json','.wl-skills-bd/rules.local.json','.wl-skills-bd/.state/review-trust.json']){
   put(prefix+rel);const r=git('check-ignore','--no-index','--',prefix+rel);assert.equal(r.status,1,`${prefix+rel} must remain trackable: ${r.stdout}`);
  }
 }
 const before=readFileSync(path.join(root,'.gitignore'),'utf8');assert.match(before,/\*\.local/);
 const next=planOnboarding(options);assert.ok(!next.files.some(f=>f.path==='.gitignore'&&f.action!=='unchanged'),JSON.stringify(next.files));
 applyOnboarding({...options,planHash:next.planHash,confirm:true});assert.equal(readFileSync(path.join(root,'.gitignore'),'utf8'),before);
});
