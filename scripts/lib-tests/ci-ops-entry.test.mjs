import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const base=fileURLToPath(new URL('../../',import.meta.url)),sha='a'.repeat(40);
const invoke=(entry,args,cwd)=>spawnSync(process.execPath,[path.join(base,'templates/ci',entry),...args],{cwd,encoding:'utf8'});
function fixture(t){const root=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-ci-ops-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('真正运行构建前断言：缺严格清零标识、旧SHA或未复验均返回2，而不是仅看CLI verified',t=>{
  const root=fixture(t),file=path.join(root,'admission.json');
  const good={status:'verified',project:'demo',sha,preBuildFindingsResolved:true,liveVerified:true};
  writeFileSync(file,JSON.stringify(good));assert.equal(invoke('assert-build-admission.mjs',[file,'demo',sha],root).status,0);
  for(const change of [r=>delete r.preBuildFindingsResolved,r=>r.preBuildFindingsResolved=false,r=>r.liveVerified=false,r=>r.sha='b'.repeat(40),r=>r.project='other']){
    const input={...good};change(input);writeFileSync(file,JSON.stringify(input));
    assert.equal(invoke('assert-build-admission.mjs',[file,'demo',sha],root).status,2);
  }
});
test('批准构建入口拒绝候选工作区脚本、错误摘要；正确只读入口执行并保留原始失败码',t=>{
  const root=fixture(t),workspace=path.join(root,'workspace'),scripts=path.join(root,'approved');mkdirSync(workspace);mkdirSync(scripts);
  const inside=path.join(workspace,'build.sh'),outside=path.join(scripts,'build.sh'),marker=path.join(workspace,'executed.txt');
  const text='#!/bin/sh\nprintf done > executed.txt\nexit 7\n';writeFileSync(inside,text);writeFileSync(outside,text);
  const hash=createHash('sha256').update(text).digest('hex');
  assert.equal(invoke('run-approved-build.mjs',[inside,hash],workspace).status,2);
  assert.equal(invoke('run-approved-build.mjs',[outside,'0'.repeat(64)],workspace).status,2);
  assert.equal(existsSync(marker),false);
  assert.equal(invoke('run-approved-build.mjs',[outside,hash],workspace).status,7);
  assert.equal(readFileSync(marker,'utf8'),'done');
});
