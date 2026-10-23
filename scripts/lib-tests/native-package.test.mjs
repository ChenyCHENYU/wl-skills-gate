import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,lstatSync,symlinkSync,chmodSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {nativePackageDigest} from '../../lib/native-package.js';
import {artifactDigest} from '../../lib/source-state.js';
const json=x=>JSON.stringify(x,null,2)+'\n';
test('真实npm安装产生合法.bin符号链接，包自有摘要可核验而全局制品摘要仍拒绝',t=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-real-npm-layout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const child=path.join(root,'child'),native=path.join(root,'native');mkdirSync(child);mkdirSync(native);
 writeFileSync(path.join(child,'package.json'),json({name:'wl-local-layout-child',version:'1.0.0',bin:{'wl-layout-bin':'cli.js'}}));writeFileSync(path.join(child,'cli.js'),'#!/usr/bin/env node\nconsole.log("fixture");\n',{mode:0o755});
 writeFileSync(path.join(native,'package.json'),json({name:'@agile-team/native-layout-fixture',version:'1.0.0'}));writeFileSync(path.join(native,'owned.js'),'export const controlled = 1;\n');
 const packed=JSON.parse(execFileSync('npm',['pack',child,'--json','--ignore-scripts','--offline','--pack-destination',root,'--cache',path.join(root,'cache')],{encoding:'utf8',env:{...process.env,CI:'true'}}))[0];
 execFileSync('npm',['install','--prefix',native,'--ignore-scripts','--no-audit','--no-fund','--offline','--cache',path.join(root,'cache'),path.join(root,packed.filename)],{encoding:'utf8',env:{...process.env,CI:'true'}});
 const bin=path.join(native,'node_modules/.bin/wl-layout-bin');assert.equal(lstatSync(bin).isSymbolicLink(),true,'layout must come from real npm');
 assert.throws(()=>artifactDigest(native),/符号链接/);
 const first=nativePackageDigest(native);writeFileSync(path.join(native,'node_modules/wl-local-layout-child/cli.js'),'dependency changed');assert.equal(nativePackageDigest(native),first,'dependency provenance remains separately checked');
 writeFileSync(path.join(native,'owned.js'),'export const controlled = 2;\n');assert.notEqual(nativePackageDigest(native),first);
 assert.ok(existsSync(path.join(native,'package-lock.json')));
});
test('无嵌套依赖时摘要兼容原制品定义且执行权限变更会漂移',t=>{const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-own-digest-'));t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(path.join(root,'owned.js'),'code',{mode:0o644});const first=nativePackageDigest(root);assert.equal(first,artifactDigest(root));chmodSync(path.join(root,'owned.js'),0o755);assert.notEqual(first,nativePackageDigest(root));});
test('原生包根、自有顶层文件及嵌套自有资产符号链接仍拒绝',t=>{const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-native-links-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const pkg=path.join(root,'pkg');mkdirSync(pkg);writeFileSync(path.join(pkg,'owned.js'),'code');symlinkSync(pkg,path.join(root,'linked'));assert.throws(()=>nativePackageDigest(path.join(root,'linked')),/符号链接/);symlinkSync(path.join(pkg,'owned.js'),path.join(pkg,'link.js'));assert.throws(()=>nativePackageDigest(pkg),/符号链接/);rmSync(path.join(pkg,'link.js'));mkdirSync(path.join(pkg,'assets'));symlinkSync(path.join(pkg,'owned.js'),path.join(pkg,'assets/link.js'));assert.throws(()=>nativePackageDigest(pkg),/符号链接/);});
test('真实CI下首次批准依赖变更用no-frozen更新锁，后续frozen再次通过且不联网',t=>{
 const root=mkdtempSync(path.join(realpathSync(os.tmpdir()),'wl-real-pnpm-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const name of ['one','two']){mkdirSync(path.join(root,name));writeFileSync(path.join(root,name,'package.json'),json({name:'wl-local-'+name,version:'1.0.0'}));}
 const file=path.join(root,'package.json');writeFileSync(file,json({name:'wl-real-lock-fixture',version:'1.0.0',dependencies:{'wl-local-one':'file:./one'}}));
 const common=['install','--offline','--ignore-scripts','--store-dir',path.join(root,'store'),'--config.manage-package-manager-versions=false'],env={...process.env,CI:'true'};
 const run=extra=>spawnSync('pnpm',[...common,...extra],{cwd:root,encoding:'utf8',env});
 let r=run(['--no-frozen-lockfile']);assert.equal(r.status,0,r.stdout+r.stderr);
 writeFileSync(file,json({name:'wl-real-lock-fixture',version:'1.0.0',dependencies:{'wl-local-one':'file:./one','wl-local-two':'file:./two'}}));
 r=run(['--frozen-lockfile']);assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/OUTDATED_LOCKFILE/);
 r=run(['--no-frozen-lockfile']);assert.equal(r.status,0,r.stdout+r.stderr);assert.match(readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8'),/wl-local-two/);
 r=run(['--frozen-lockfile']);assert.equal(r.status,0,r.stdout+r.stderr);
});
