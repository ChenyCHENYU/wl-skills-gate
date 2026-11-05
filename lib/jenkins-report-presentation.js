import path from 'node:path';
import {existsSync} from 'node:fs';
import {controlledPath,readControlledJson} from './control-store.js';
import {publicationInput} from './report-publication.js';
import {inspectJenkinsBinding,assertBoundCheckout,inside,digest} from './jenkins-integration.js';
import {assertNativeProof,ENTRY_CONTEXT_PATH,entryPointHash} from './jenkins-entry-contract.js';
import {loadOpsDirectory,mergeOpsDirectory} from './ops-responsibility.js';
import {checkObservations} from './jenkins-check-notification.js';
import {git,safePath} from './source-state.js';
const assert=(ok,message)=>{if(!ok)throw Error(message);};

// Called after project commands have ended. Only central configuration supplies
// authenticated people and the prior CHECK; Git authors never become executors.
export function jenkinsReportInput({summaryFile,reviewIndexFile,registryFile,configDir,root=process.cwd(),env=process.env}) {
  root=controlledPath(path.resolve(root));configDir=controlledPath(path.resolve(configDir));
  assert(!inside(root,configDir),'报告人员配置须位于业务工作区外');
  assert(controlledPath(path.resolve(summaryFile))===controlledPath(safePath(root,'quality-reports/quality-summary.json')),'报告必须读取本轮固定原件');
  const input=publicationInput({summaryFile,reviewIndexFile}),report=input.summary;
  const context=inspectJenkinsBinding({registryFile,root,env}),binding=context.binding;
  assert(context.mode==='check','报告人员与复检展示只用于批准CHECK');
  const source=assertBoundCheckout(context,root,env);
  assert(report.run.project===binding.project&&report.run.commitSha===source.sha&&report.run.sourceDigest===source.sourceDigest&&report.run.stage==='ci','报告不是本轮批准源码的CI结果');
  const proof=readControlledJson(safePath(root,ENTRY_CONTEXT_PATH));
  assertNativeProof(proof,{project:binding.project,scope:binding.scope,jobPath:env.JOB_NAME,nativeEntry:{runtimeHash:context.config.nativeEntry.runtimeHash,entryPointHash:entryPointHash(context.config.nativeEntry)}},{sha:source.sha,runId:env.BUILD_NUMBER});
  assert(proof.bindingHash===context.bindingHash&&proof.registryHash===context.registryHash&&proof.sourceDigest===source.sourceDigest,'报告公共入口证据已经变化');
  const opsFile=path.join(configDir,'jenkins-ops.json');
  const config=mergeOpsDirectory(existsSync(opsFile)?readControlledJson(opsFile):{},loadOpsDirectory(configDir));
  const owner=config.owners?.[binding.project]||{};
  const executor=[env.WL_GATE_BUILD_USER_ID,env.BUILD_USER_ID,env.gitlabUserUsername].find(id=>id&&config.people?.[id]);
  const stateFile=path.join(configDir,'check-notification-state',digest(`${env.JOB_NAME}:${binding.id}`)+'.json');
  let previous=null;
  if(existsSync(stateFile)){const state=readControlledJson(stateFile);assert(state.schemaVersion===1&&state.kind==='wl-ci-notification-state','上一轮检查记录格式无效');previous=state.last;}
  let ancestorVerified=false,changedFiles=[];
  try{const from=previous?.run?.commitSha||binding.approvedSource.sha;git(['merge-base','--is-ancestor',from,source.sha],root);ancestorVerified=true;changedFiles=git(['diff','--no-ext-diff','--name-only',from,source.sha],root).split('\n').filter(Boolean);}catch{}
  input.presentation={domain:owner.domain,submitterId:executor,submitterName:config.people?.[executor]?.name,
    technicalManagerName:config.people?.[owner.technicalManager]?.name,pipelineLabel:`${env.JOB_NAME} · #${env.BUILD_NUMBER}`,
    buildUrl:env.BUILD_URL,networkAccess:config.networkAccess,observations:checkObservations(previous,report,{ancestorVerified}),
    changeFindings:report.findings.filter(f=>changedFiles.includes(f.file)&&f.ruleId!=='GOV/CHECK-INVALID')};
  return input;
}
