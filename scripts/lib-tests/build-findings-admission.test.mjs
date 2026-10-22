import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertResolvedBuildFindings, verifyReleaseReview } from '../../lib/release-review.js';
import { createReleaseReviewFixture } from '../test-support/release-review-fixture.mjs';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const summary = () => ({schemaVersion:1,run:{project:'demo',profile:'standard',commitSha:'b'.repeat(40),eventId:'build-findings-check',startedAt:'2026-10-20T01:00:00Z',durationMs:1,tool:'gate',sourceBound:true,sourceDigest:'a'.repeat(64)},policy:{policyHash:'a'.repeat(64),ruleSetHash:'a'.repeat(64),baselineHash:'a'.repeat(64),waiversHash:'a'.repeat(64),requiredCheckIds:['CHECK'],checksSelected:1,lockedToolVersions:{CHECK:'tool@1'}},checks:[{checkId:'CHECK',status:'ok',required:true,toolVersionVerified:true,toolVersion:'tool@1'}],findings:[],counts:{new:0,existing:0,waived:0,expired:0,blockingNew:0},decision:{status:'passed',reasons:[]}});

test('构建准入接受完整、真实源码绑定且所有发现清零的报告，不伪造台账关闭',()=>{
  const clean=summary(),before=JSON.stringify(clean);
  assert.doesNotThrow(()=>assertResolvedBuildFindings(clean));
  assert.equal(JSON.stringify(clean),before);
});
for (const [severity,status] of [['blocker','new'],['error','new'],['warning','new'],['info','new'],['warning','existing'],['info','waived']]) test(`构建准入拒绝残留${severity}/${status}，即使扫描宣称passed`,()=>{
  const input=summary();input.findings=[{severity,status}];
  assert.throws(()=>assertResolvedBuildFindings(input),/未消除发现/);
});
for (const [name,change] of [
  ['增量报告',s=>{s.run.scope='staged';}],['差异报告',s=>{s.run.base='a'.repeat(40);}],['未绑定源码',s=>{s.run.sourceBound=false;}],
  ['无检查',s=>{s.checks=[];}],['工具未验证',s=>{s.checks[0].toolVersionVerified=false;}],['未清零的历史计数',s=>{s.counts.existing=1;}],['缺失计数',s=>{delete s.counts.waived;}]
]) test(`构建准入拒绝${name}`,()=>{const input=summary();change(input);assert.throws(()=>assertResolvedBuildFindings(input));});

test('真实签名Review的固定信任启用清零卡控，返回可验收字段且不授予关闭权限',(t)=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-build-findings-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const now=new Date('2026-10-20T01:00:00Z'),s=summary();
  const f=createReleaseReviewFixture({root,project:'demo',sha:s.run.commitSha,summary:s,now});
  const trust=JSON.parse(readFileSync(f.trustFile));trust.projects.demo.requireResolvedFindings=true;writeFileSync(f.trustFile,JSON.stringify(trust));
  const checked=verifyReleaseReview({configFile:f.trustFile,project:'demo',sha:s.run.commitSha,recordFile:f.recordFile,evidenceRoot:f.evidenceRoot,now});
  assert.equal(checked.preBuildFindingsResolved,true);
  assert.equal(checked.record.closureAuthorized,false);
});

test('真实签名的零阻断Review仍有提示时，固定构建策略拒绝；未启用的旧策略保持原行为',(t)=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'wl-build-note-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const now=new Date('2026-10-20T01:00:00Z'),s=summary();
  s.findings=[{checkId:'CHECK',tool:'tool',ruleId:'INFO-NOTE',severity:'info',dimension:'coding',message:'需要处理的提示',file:'src/Order.java',line:10,status:'new',fingerprint:'c'.repeat(64),duplicates:0,occurrences:[{line:10,message:'需要处理的提示'}]}];s.counts.new=1;
  const f=createReleaseReviewFixture({root,project:'demo',sha:s.run.commitSha,summary:s,now});
  const options={configFile:f.trustFile,project:'demo',sha:s.run.commitSha,recordFile:f.recordFile,evidenceRoot:f.evidenceRoot,now};
  assert.equal(verifyReleaseReview(options).approved,true);
  const trust=JSON.parse(readFileSync(f.trustFile));trust.projects.demo.requireResolvedFindings=true;writeFileSync(f.trustFile,JSON.stringify(trust));
  assert.throws(()=>verifyReleaseReview(options),/未消除发现/);
});
