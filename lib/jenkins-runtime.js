import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { inspectJenkinsBinding, assertBoundCheckout, GATE_ROOT, assert, digest } from './jenkins-integration.js';
import { selectReleaseReview } from './release-review.js';
import { safePath, snapshotSource } from './source-state.js';
import { writeExclusiveJson, controlledPath } from './control-store.js';
import {ENTRY_CONTEXT_PATH,entryPointHash} from './jenkins-entry-contract.js';
import {archiveBuildArtifacts,BUILD_RESULT_PATH} from './build-artifacts.js';

// These are functions of the fixed package, not scripts copied into a business repo.
const childEnvironment = env => Object.fromEntries(Object.entries(env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|CREDENTIAL)/i.test(key)));
const receiptPath = root => safePath(root, 'quality-reports/ci-integration/admission.json');
const compactReview = value => Object.fromEntries(['status','project','sha','sourceDigest','reviewId','reviewerId','authorId','recordHash','reviewDigest','bodyDigest','evidenceDigest','trustHash','preBuildFindingsResolved','liveVerified','liveCheckDirectory'].filter(key => value[key] !== undefined).map(key => [key,value[key]]));

export async function runJenkinsAction({ action, registryFile, root = process.cwd(), env = process.env, admissionHash,
  runner = spawnSync, verifyReview = selectReleaseReview, now = Date.now() }) {
  const started=performance.now(),currentTime=()=>now+Math.max(0,Math.ceil(performance.now()-started));
  assert(['inspect','check','prepare','admit','build'].includes(action), 'jenkins执行入口仅支持inspect/check/prepare/admit/build');
  const context = inspectJenkinsBinding({ registryFile,root,env }), b = context.binding;
  if (action === 'inspect') return { status:'configured',mode:context.mode,id:b.id,project:b.project,scope:b.scope,branch:b.branch,repository:b.repository,
    scmCredentialId:b.scmCredentialId,reportArchiveRoot:b.reports.archiveRoot,reportReaderCredentialId:b.reports.readerCredentialId,credentials:b.credentials,
    artifactGlob:b.build?.artifactGlob,registryHash:context.registryHash,bindingHash:context.bindingHash,approved:false };
  assert(action === 'check' ? context.mode === 'check' : context.mode === 'build', '当前Job不能调用另一类任务的执行动作');
  const source = assertBoundCheckout(context,root,env); root = source.root;
  if (context.config.nativeEntry && ['check','prepare'].includes(action)) writeExclusiveJson(safePath(root,ENTRY_CONTEXT_PATH),{schemaVersion:1,kind:'wl-quality-native-execution',project:b.project,scope:b.scope,sha:source.sha,sourceDigest:source.sourceDigest,job:env.JOB_NAME,buildNumber:env.BUILD_NUMBER,runtimeHash:context.config.nativeEntry.runtimeHash,entryPointHash:entryPointHash(context.config.nativeEntry),registryHash:context.registryHash,bindingHash:context.bindingHash});
  const cleanEnv = { ...childEnvironment(env), CI:'true', HUSKY:'0', WL_GATE_TRIGGER:'ci' };
  const execute = (args, install = false) => {
    const secrets = install ? Object.fromEntries(['NODE_AUTH_TOKEN','NPM_TOKEN'].filter(key=>env[key]).map(key=>[key,env[key]])) : {};
    const result = runner(process.execPath,args,{ cwd:root, shell:false, stdio:'inherit', env:{...cleanEnv,...secrets} });
    return Number.isInteger(result.status) ? result.status : 2;
  };
  const prepare = () => execute([context.cli,'ci-prepare','--root',root,'--apply','--confirm',
    '--expect-workspace-hash',b.pins.workspaceHash,'--expect-lock-hash',b.pins.lockHash],true);
  const unchanged = () => {
    const fresh = inspectJenkinsBinding({registryFile,root,env});
    assert(fresh.registryHash === context.registryHash && fresh.bindingHash === context.bindingHash, '执行期间批准登记变化，停止后续阶段');
    const current = assertBoundCheckout(fresh,root,env);
    assert(current.sha === source.sha && current.sourceDigest === source.sourceDigest, '执行期间源码变化，停止后续阶段');
  };
  if (action === 'check') {
    const preparation = prepare(); if (preparation) return {status:'blocked',phase:'preparation',exitCode:preparation};
    unchanged();
    const status = execute([context.cli,'run','--root',root,'--profile','standard','--sha',source.sha,'--policy',safePath(root,b.policyFile),
      '--expect-policy-hash',b.pins.policyHash,'--expect-rules-hash',b.pins.rulesHash,'--expect-baseline-hash',b.pins.baselineHash,'--expect-waivers-hash',b.pins.waiversHash]);
    const summaryFile = safePath(root,'quality-reports/quality-summary.json');
    if (!existsSync(summaryFile)) return {status:'blocked',phase:'summary-missing',exitCode:2};
    const report = JSON.parse(readFileSync(summaryFile));
    assert(report.run.commitSha === source.sha && report.run.project === b.project && report.run.stage === 'ci' && report.policy?.policyHash === b.pins.policyHash, '报告不是本轮实际项目/SHA/策略，不生成或发布旧Review');
    const facts = execute([context.cli,'review-facts','--root',root,'--summary',summaryFile,'--out-dir',safePath(root,'quality-reports/review'),'--plan',b.evidencePlanFile]);
    unchanged();
    return {status:status === 0 && facts === 0 ? 'checked' : 'blocked',project:b.project,scope:b.scope,sha:source.sha,exitCode:facts ? 2 : status,approved:false};
  }
  if (action === 'prepare') {
    const code=prepare(); unchanged();
    if (!code) writeExclusiveJson(safePath(root,'quality-reports/ci-integration/preparation.json'),{kind:'jenkins-fixed-preparation',project:b.project,scope:b.scope,
      sha:source.sha,sourceDigest:source.sourceDigest,job:env.JOB_NAME,buildNumber:env.BUILD_NUMBER,registryHash:context.registryHash});
    return {status:code ? 'blocked' : 'dependencies-prepared',exitCode:code,approved:false};
  }
  if (action === 'admit') {
    const preparedFile=controlledPath(safePath(root,'quality-reports/ci-integration/preparation.json')),preparedBytes=readFileSync(preparedFile),prepared=JSON.parse(preparedBytes);
    assert(prepared.kind === 'jenkins-fixed-preparation' && prepared.project === b.project && prepared.scope === b.scope && prepared.sha === source.sha && prepared.sourceDigest === source.sourceDigest && prepared.job === env.JOB_NAME && prepared.buildNumber === env.BUILD_NUMBER && prepared.registryHash === context.registryHash,'本轮固定依赖尚未准备成功，不能漏阶段后继续构建');
    const review = await verifyReview({configFile:b.review.trustFile,project:b.project,sha:source.sha,publicationDir:b.review.publicationDir,outDir:safePath(root,'quality-reports/release-review-live'),env,now:new Date(currentTime())});
    assert(review.status === 'verified' && review.project === b.project && review.sha === source.sha && review.preBuildFindingsResolved === true && review.liveVerified === true, '正式Review、问题清零或当前CI复验未全部通过');
    assert(review.sourceDigest===source.sourceDigest,'当前检出源码摘要与正式Review原始检查不一致，不能只凭同SHA构建');
    unchanged();
    const receipt = {schemaVersion:1,kind:'jenkins-build-admission',executionId:randomUUID(),createdAt:new Date(currentTime()).toISOString(),
      project:b.project,scope:b.scope,sha:source.sha,sourceDigest:source.sourceDigest,job:env.JOB_NAME,buildNumber:env.BUILD_NUMBER,buildUrl:env.BUILD_URL,
      registryHash:context.registryHash,bindingHash:context.bindingHash,preparationHash:digest(preparedBytes),review:compactReview(review)};
    writeExclusiveJson(receiptPath(root),receipt);
    return {status:'admitted',project:b.project,scope:b.scope,sha:source.sha,admissionHash:digest(readFileSync(receiptPath(root))),approvedFor:'this-job-and-build-only'};
  }
  const validateAdmission = () => {
    assert(/^[a-f0-9]{64}$/.test(admissionHash || ''), '缺少受控Jenkins阶段捕获的准入摘要，不能直接构建');
    const bytes = readFileSync(controlledPath(receiptPath(root))); assert(digest(bytes) === admissionHash, '准入记录被替换，不能构建');
    const admission = JSON.parse(bytes), age = currentTime() - Date.parse(admission.createdAt);
    assert(admission.kind === 'jenkins-build-admission' && admission.schemaVersion === 1 && Number.isFinite(age) && age >= 0 && age <= 5 * 60 * 1000, '准入记录不在本轮五分钟执行窗口内，重新复验');
    assert(admission.project === b.project && admission.scope === b.scope && admission.sha === source.sha && admission.sourceDigest === source.sourceDigest && admission.job === env.JOB_NAME && admission.buildNumber === env.BUILD_NUMBER && admission.buildUrl === env.BUILD_URL && admission.registryHash === context.registryHash && admission.bindingHash === context.bindingHash, '准入记录来自其他版本、分支范围或运行');
    assert(admission.review?.status === 'verified' && admission.review.sourceDigest===admission.sourceDigest && admission.review.preBuildFindingsResolved === true && admission.review.liveVerified === true, '准入证据未通过严格策略');
    assert(digest(readFileSync(controlledPath(safePath(root,'quality-reports/ci-integration/preparation.json')))) === admission.preparationHash,'本轮固定准备记录已变化');
    return admission;
  };
  const admission=validateAdmission();
  unchanged(); validateAdmission();
  assert(snapshotSource(root).digest === source.sourceDigest, '构建前源码已变化');
  writeExclusiveJson(safePath(root,'quality-reports/ci-integration/build-started.json'),{kind:'jenkins-approved-build-start',admissionHash,job:env.JOB_NAME,buildNumber:env.BUILD_NUMBER,sha:source.sha});
  const status = execute([path.join(GATE_ROOT,'templates/ci/run-approved-build.mjs'),b.build.scriptFile,b.build.scriptHash]);
  if(!status){
    unchanged();
    const archive=archiveBuildArtifacts({root,artifactGlob:b.build.artifactGlob});
    unchanged();
    writeExclusiveJson(safePath(root,BUILD_RESULT_PATH),{schemaVersion:1,kind:'jenkins-validated-build',project:b.project,scope:b.scope,
      commitSha:source.sha,sourceDigest:source.sourceDigest,job:env.JOB_NAME,buildNumber:env.BUILD_NUMBER,buildUrl:env.BUILD_URL,
      createdAt:new Date(currentTime()).toISOString(),admissionHash,review:admission.review,
      ...(env.WL_GATE_DISPATCH_ID?{dispatchId:env.WL_GATE_DISPATCH_ID}:{}),
      artifacts:[{path:archive.path,sha256:archive.sha256,bytes:archive.bytes}],entries:archive.entries,approvedForDeployment:false});
  }
  return {status:status ? 'build-failed' : 'built-awaiting-artifact-archive',project:b.project,scope:b.scope,sha:source.sha,artifactGlob:b.build.artifactGlob,exitCode:status,approvedForDeployment:false};
}

export async function runJenkinsCli(argv) {
  if(argv[0]==='fleet'){const {runFleetCli}=await import('./jenkins-fleet.js');return runFleetCli(argv.slice(1));}
  const [action,...args] = argv, options = {};
  const allowed = action === 'plan' || action === 'bind' ? ['--root','--seed','--registry','--plan-hash','--confirm'] : ['--registry','--admission-hash'];
  for (let i=0;i<args.length;i++) {
    const key=args[i]; assert(allowed.includes(key) && !Object.hasOwn(options,key), `未知或重复Jenkins参数：${key}`);
    if (key === '--confirm') options[key]=true;
    else { const value=args[++i]; assert(value && !value.startsWith('--'),`${key}缺少值`); options[key]=value; }
  }
  let result;
  if (action === 'plan' || action === 'bind') {
    const {planJenkinsBinding,applyJenkinsBinding}=await import('./jenkins-integration.js');
    assert(options['--seed'] && options['--registry'], '需要工程维护者提供--seed接入说明和--registry受控登记位置');
    assert(action !== 'plan' || !options['--confirm'] && !options['--plan-hash'],'plan只预览，不接受确认参数');
    const input={root:options['--root'],seedFile:options['--seed'],registryFile:options['--registry'],confirm:options['--confirm'],planHash:options['--plan-hash']};
    result=action === 'plan' ? planJenkinsBinding(input) : await applyJenkinsBinding(input);
  } else if(action==='verify-jobs') {
    assert(!options['--admission-hash'],'verify-jobs不接受准入摘要');
    const {verifyJenkinsJobs}=await import('./jenkins-integration.js');result=await verifyJenkinsJobs({registryFile:options['--registry']});
  } else result=await runJenkinsAction({action,registryFile:options['--registry'],admissionHash:options['--admission-hash']});
  process.stdout.write(JSON.stringify(result,null,2)+'\n'); return result.exitCode || 0;
}
