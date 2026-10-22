import path from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { controlledPath, readControlledJson, lockedJson } from './control-store.js';
import { actualSha, git, safePath, snapshotSource } from './source-state.js';
import { loadConfig } from './config.js';
import { loadReleaseReviewTrust } from './release-review.js';
import { validateReviewPolicy } from './review.js';
import { stableStringify } from './util.js';
import { parseXml } from './xml.js';
import {validateNativeEntry,nativePipelineEntry} from './jenkins-entry-contract.js';
import { embedJenkinsBootstrap } from './jenkins-bootstrap.js';

export const GATE_ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
export const GATE_VERSION = JSON.parse(readFileSync(path.join(GATE_ROOT, 'package.json'))).version;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const inside = (root, file) => { const r = path.relative(root, file); return !r || r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const JOB = /^[\p{L}\p{N}_][\p{L}\p{N}_. -]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_. -]*)*$/u;
const credential = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const known = (value, keys, where) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${where}必须是对象`);
  for (const key of Object.keys(value)) assert(keys.includes(key), `${where}未知配置 ${key}，不静默忽略拼写错误`);
};
const absolute = (value, where) => { assert(typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f'"`$\\]/.test(value), `${where}需要受控绝对路径`); return controlledPath(value); };
const regular = file => { file = controlledPath(file); const stat=lstatSync(file); assert(stat.isFile() && stat.size <= 4*1024*1024, `需要不超过4MiB的普通配置／脚本：${file}`); return file; };
const origin = value => { const u = new URL(value); assert(u.protocol === 'https:' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash, 'Jenkins入口必须是无凭据的HTTPS源地址'); return u.origin + '/'; };
const repository = value => {
  assert(typeof value === 'string' && !/[\s\u0000-\u001f]/.test(value), '缺少明确的SCM仓库地址');
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+\.git$/.test(value)) return value;
  const u = new URL(value);
  assert(['https:', 'ssh:'].includes(u.protocol) && !u.password && !u.search && !u.hash && (u.protocol !== 'https:' || !u.username) && u.pathname !== '/', '仓库须为批准HTTPS/SSH Git地址，不携带令牌');
  return value;
};
const relative = value => typeof value === 'string' && value && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every(p => p && p !== '.' && p !== '..');

export function gateRuntimeHash() {
  const files = {};
  const visit = name => {
    const file = controlledPath(path.join(GATE_ROOT,name)), stat = lstatSync(file);
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(`${name}/${child}`);
    else { assert(stat.isFile(), 'Gate运行时含非普通文件'); files[name] = digest(readFileSync(file)); }
  };
  for (const name of ['package.json','npm-shrinkwrap.json','bin','lib','templates','schemas','assets','scripts']) visit(name);
  return digest(stableStringify(files));
}

function validateBinding(b) {
  known(b, ['id','project','scope','branch','validationBranch','repository','scmCredentialId','jobs','policyFile','evidencePlanFile','pins','review','build','reports','credentials','runtimeHash','approvedSource'], '接入项');
  assert([b.id,b.project,b.scope].every(v => ID.test(v || '')), '接入编号、项目或scope无效');
  assert(typeof b.branch === 'string' && b.branch && !b.branch.startsWith('-'), '缺少固定目标分支');
  git(['check-ref-format', '--branch', b.branch], GATE_ROOT);
  assert(typeof b.validationBranch === 'boolean' && (['dev','sit','uat','pre','prd','main'].includes(b.branch) || b.validationBranch), '六目标以外的验证分支必须明确批准validationBranch');
  repository(b.repository); assert(credential(b.scmCredentialId), '缺少只读SCM凭据ID');
  known(b.jobs, ['check','build'], '任务映射');
  assert(typeof b.jobs.check === 'string' && JOB.test(b.jobs.check) && b.jobs.check.length <= 250 && (!b.jobs.build || typeof b.jobs.build === 'string' && JOB.test(b.jobs.build) && b.jobs.build.length <= 250 && b.jobs.check !== b.jobs.build), '检查/构建须是明确且不同的Job');
  assert(relative(b.policyFile) && b.policyFile.startsWith('quality/'), 'policyFile必须是quality内的批准相对路径');
  assert(relative(b.evidencePlanFile) && b.evidencePlanFile.startsWith('quality/'), 'evidencePlanFile必须是quality内的批准相对路径');
  known(b.pins, ['workspaceHash','lockHash','policyHash','rulesHash','baselineHash','waiversHash','reviewPolicyHash','evidencePlanHash'], '批准摘要');
  assert(Object.keys(b.pins).length === 8 && Object.values(b.pins).every(v => HASH.test(v || '')), '批准摘要不完整；通过接入助手生成，不手填');
  if (b.jobs.build) {
    known(b.review, ['trustFile','publicationDir','trustHash'], 'Review配置');
    absolute(b.review.trustFile, 'Review信任'); absolute(b.review.publicationDir, 'Review交付目录'); assert(HASH.test(b.review.trustHash || ''), '缺少固定Review信任摘要');
    known(b.build, ['scriptFile','scriptHash','artifactGlob'], '构建配置');
    absolute(b.build.scriptFile, '构建脚本'); assert(HASH.test(b.build.scriptHash || ''), '缺少批准构建脚本摘要');
    assert(typeof b.build.artifactGlob === 'string' && b.build.artifactGlob.length <= 1024 && b.build.artifactGlob.split(',').every(p => relative(p.trim()) && !/^[!-]/.test(p.trim()) && !/[\r\n]/.test(p)), '制品范围须为明确的项目内相对glob，不能越界');
  } else assert(!b.review && !b.build, '纯检查接入不配置构建/Review信任，不将检查成功变成构建授权');
  known(b.reports, ['archiveRoot','readerCredentialId'], '报告配置'); absolute(b.reports.archiveRoot, '报告持久卷'); assert(credential(b.reports.readerCredentialId), '缺少报告只读凭据ID');
  known(b.credentials, ['gitlabRead','jenkinsRead'], '来源凭据'); assert(Object.values(b.credentials).length === 2 && Object.values(b.credentials).every(credential), '缺少当前CI重查凭据ID');
  assert(HASH.test(b.runtimeHash || '') && b.approvedSource && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(b.approvedSource.sha || '') && HASH.test(b.approvedSource.digest || ''), '接入项缺少包运行时与已审阅源码记录');
}

export function validateJenkinsRegistry(c) {
  known(c, ['schemaVersion','kind','gateVersion','gateRoot','jenkinsOrigin','agentLabel','bindings','nativeEntry'], 'Jenkins登记');
  assert(c.schemaVersion === 1 && c.kind === 'wl-gate-jenkins-bindings' && c.gateVersion === GATE_VERSION, '登记类型或Gate版本不匹配');
  if(c.nativeEntry)validateNativeEntry(c.nativeEntry);
  absolute(c.gateRoot, 'Gate安装目录'); origin(c.jenkinsOrigin);
  assert(typeof c.agentLabel === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(c.agentLabel), '需要明确的受控Agent标签');
  assert(Array.isArray(c.bindings) && c.bindings.length > 0 && c.bindings.length <= 1000, '必须登记1至1000个精确接入范围');
  const ids = new Set(), jobs = new Set();
  for (const b of c.bindings) {
    validateBinding(b); assert(!ids.has(b.id), '接入ID重复'); ids.add(b.id);
    for (const job of Object.values(b.jobs)) { assert(!jobs.has(job), '同一Jenkins任务不能匹配多个项目/范围'); jobs.add(job); }
  }
  return c;
}

export function inspectJenkinsBinding({ registryFile, root = process.cwd(), env = process.env }) {
  root = realpathSync(root); registryFile = absolute(registryFile, '接入登记');
  assert(!inside(root, registryFile) && !inside(root, GATE_ROOT), 'Gate和受控接入登记不得位于业务候选工作区内');
  const raw = readFileSync(regular(registryFile)), c = validateJenkinsRegistry(JSON.parse(raw));
  assert(realpathSync(c.gateRoot) === GATE_ROOT, '实际Gate安装目录与受控登记不一致');
  assert(origin(env.JENKINS_URL) === origin(c.jenkinsOrigin), 'JENKINS_URL与批准入口不一致');
  assert(/^[1-9][0-9]*$/.test(env.BUILD_NUMBER || ''), '需要真实Jenkins运行编号');
  const b = c.bindings.find(value => Object.values(value.jobs).includes(env.JOB_NAME));
  assert(b, '当前Job未精确登记，不推断项目/分支或使用默认放行');
  const mode = env.JOB_NAME === b.jobs.check ? 'check' : 'build';
  const encodedJob = env.JOB_NAME.split('/').map(p => `job/${encodeURIComponent(p)}`).join('/') + '/';
  assert(env.BUILD_URL === new URL(`${encodedJob}${env.BUILD_NUMBER}/`, c.jenkinsOrigin).href, 'BUILD_URL与本次固定Job/运行编号不一致');
  assert(!c.nativeEntry || c.nativeEntry.runtimeHash === gateRuntimeHash(), '公共入口与实际Gate运行时不一致');
  assert(b.runtimeHash === gateRuntimeHash(), 'Gate运行时字节已变化，重新审阅固定包并生成接入登记');
  for (const f of [b.review?.trustFile,b.review?.publicationDir,b.build?.scriptFile,b.reports.archiveRoot].filter(Boolean)) assert(!inside(root, controlledPath(f)), '受控信任、构建脚本或持久归档位于业务候选工作区内');
  assert(lstatSync(controlledPath(b.reports.archiveRoot)).isDirectory(), '持久报告卷尚未准备');
  if (b.jobs.build) {
  assert(digest(readFileSync(regular(b.review.trustFile))) === b.review.trustHash && digest(readFileSync(regular(b.build.scriptFile))) === b.build.scriptHash, 'Review信任或批准构建脚本发生漂移');
  assert(lstatSync(controlledPath(b.review.publicationDir)).isDirectory() && lstatSync(controlledPath(b.reports.archiveRoot)).isDirectory(), 'Review交付目录或持久报告卷尚未准备');
  const trust = loadReleaseReviewTrust(b.review.trustFile, b.project);
  assert(trust.requireResolvedFindings === true && trust.requireTechnicalManagerReview === true && trust.scope === b.scope && trust.profile === 'standard', '当前范围须启用严格清零、技术经理确认和standard正式Review，不得跨scope复用');
  for (const key of ['policyHash','rulesHash','baselineHash','waiversHash','reviewPolicyHash']) assert(trust[key] === b.pins[key], `Review与检查批准摘要不一致：${key}`);
  assert(trust.collectorConfigFile && trust.controlCatalogFile && trust.evidenceRoots?.length, '当前正式Review缺少真实来源/目录/证据根，不能降级');
  }
  return { registryFile, registryHash: digest(raw), bindingHash: digest(stableStringify(b)), binding: b, config: c, mode, cli: path.join(GATE_ROOT, 'bin/wl-skills-gate.js') };
}

export function assertBoundCheckout(context, root = process.cwd(), env = process.env) {
  root = realpathSync(root); const b = context.binding;
  assert(realpathSync(git(['rev-parse','--show-toplevel'], root)) === root, '必须在真实业务Git根执行');
  const source = snapshotSource(root), sha = actualSha(root);
  assert(!source.dirty && sha === git(['rev-parse', `refs/remotes/origin/${b.branch}`], root), '源码未提交、分支错误或本轮checkout已变化');
  assert(git(['remote','get-url','origin'], root) === b.repository, '实际检出仓库与受控登记不一致');
  if (context.mode === 'check') {
    assert(!env.WL_GATE_DISPATCH_ID || env.WL_REVIEW_SHA === sha, '运维承接候选与本轮检出SHA不一致；分支已前进，重新巡检，不检查旧版本冒充当前版本');
    assert(!env.gitlabActionType || env.gitlabAfter, '自动Push事件缺少实际目标SHA');
    assert(!env.gitlabAfter || env.gitlabAfter === sha, '排队期间分支已变化；旧事件不能冒充当前版本');
  } else assert(env.WL_REVIEW_SHA === sha, '受控续建获批SHA与当前目标分支不一致');
  const manifestFile = safePath(root, 'quality/workspace.json'), manifest = JSON.parse(readFileSync(manifestFile));
  assert(['frontend','backend'].includes(manifest.projectKind) && manifest.gateVersion === GATE_VERSION, '项目工作副本清单或Gate版本不符');
  const config = loadConfig(root, { policyFile: safePath(root, b.policyFile) });
  assert(config.policy.project === b.project, '实际项目与接入范围不一致');
  const evidencePlan=JSON.parse(readFileSync(safePath(root,b.evidencePlanFile)));
  assert(evidencePlan.schemaVersion===1 && evidencePlan.project===b.project && Array.isArray(evidencePlan.evidence), '九维证据计划项目或结构不符');
  const reviewPolicy = validateReviewPolicy(JSON.parse(readFileSync(safePath(root,'quality/review-policy.json'))), b.project);
  const pins = { workspaceHash: digest(readFileSync(manifestFile)), lockHash: digest(readFileSync(safePath(root, manifest.projectKind === 'backend' ? 'quality-tools/package-lock.json' : 'pnpm-lock.yaml'))),
    policyHash: config.policyHash, rulesHash: config.ruleSetHash, baselineHash: config.baselineHash, waiversHash: config.waiversHash,
    reviewPolicyHash: digest(stableStringify(reviewPolicy)), evidencePlanHash: digest(readFileSync(safePath(root,b.evidencePlanFile))) };
  for (const [key, value] of Object.entries(pins)) assert(value === b.pins[key], `项目批准配置漂移：${key}；交维护者审阅更新，不在CI自动批准`);
  return { root, sha, sourceDigest: source.digest, pins };
}

export function renderJenkinsEntry(c, registryFile) {
  if(c.nativeEntry)return nativePipelineEntry(c.nativeEntry);
  const text = readFileSync(path.join(GATE_ROOT, 'templates/ci/Jenkinsfile.gate'), 'utf8');
  return embedJenkinsBootstrap(text).replaceAll('__WL_AGENT__', c.agentLabel).replaceAll('__WL_GATE_ROOT__', c.gateRoot).replaceAll('__WL_REGISTRY__', registryFile);
}

export function planJenkinsBinding({ root = '.', seedFile, registryFile }) {
  root = realpathSync(root); seedFile = absolute(seedFile, '接入说明'); registryFile = absolute(registryFile, '接入登记');
  assert(!inside(root, seedFile) && !inside(root, registryFile), '接入说明与批准登记须在业务工作区外');
  const seed = readControlledJson(seedFile);
  seed.gateRoot ||= GATE_ROOT;
  assert(!/REPLACE[_A-Z]|<填写/.test(JSON.stringify(seed)), '接入说明仍有占位值，先由工程维护者补齐');
  known(seed, ['schemaVersion','kind','gateRoot','jenkinsOrigin','agentLabel','binding'], '接入说明');
  assert(seed.schemaVersion === 1 && seed.kind === 'wl-gate-jenkins-seed', '需要Gate接入说明');
  const b = structuredClone(seed.binding);
  known(b, ['id','project','scope','branch','validationBranch','repository','scmCredentialId','jobs','policyFile','evidencePlanFile','review','build','reports','credentials'], '接入说明项目');
  const source = snapshotSource(root); assert(!source.dirty && source.sha !== 'unknown', '先审阅提交项目接入文件，再生成CI登记');
  b.policyFile ||= path.relative(root, loadConfig(root).policyFile).split(path.sep).join('/');
  b.evidencePlanFile ||= 'quality/review-evidence.plan.json';
  b.validationBranch ??= false;
  if (b.jobs?.build) {
    known(b.review, ['trustFile','publicationDir'], '接入说明Review');
    known(b.build, ['scriptFile','artifactGlob'], '接入说明构建');
  }
  known(b.reports, ['archiveRoot','readerCredentialId'], '接入说明报告');
  b.reports.readerCredentialId ||= 'wl-quality-report-reader';
  b.credentials ||= { gitlabRead:'wl-ci-review-readonly-token', jenkinsRead:'wl-jenkins-ci-readonly' };
  const policy = loadConfig(root, { policyFile: safePath(root,b.policyFile) });
  const manifest = JSON.parse(readFileSync(safePath(root,'quality/workspace.json')));
  b.pins = { workspaceHash:digest(readFileSync(safePath(root,'quality/workspace.json'))), lockHash:digest(readFileSync(safePath(root,manifest.projectKind === 'backend' ? 'quality-tools/package-lock.json' : 'pnpm-lock.yaml'))), policyHash:policy.policyHash, rulesHash:policy.ruleSetHash, baselineHash:policy.baselineHash, waiversHash:policy.waiversHash,
    reviewPolicyHash:digest(stableStringify(validateReviewPolicy(JSON.parse(readFileSync(safePath(root,'quality/review-policy.json'))),b.project))), evidencePlanHash:digest(readFileSync(safePath(root,b.evidencePlanFile))) };
  if (b.jobs?.build) {
    b.review.trustHash = digest(readFileSync(regular(absolute(b.review.trustFile,'Review信任'))));
    b.build.scriptHash = digest(readFileSync(regular(absolute(b.build.scriptFile,'构建脚本'))));
  }
  b.runtimeHash = gateRuntimeHash(); b.approvedSource = { sha:source.sha, digest:source.digest };
  const before = existsSync(registryFile) ? readFileSync(regular(registryFile)) : null;
  const c = before ? validateJenkinsRegistry(JSON.parse(before)) : { schemaVersion:1, kind:'wl-gate-jenkins-bindings', gateVersion:GATE_VERSION, gateRoot:seed.gateRoot, jenkinsOrigin:origin(seed.jenkinsOrigin), agentLabel:seed.agentLabel || 'wl-quality-isolated', bindings:[] };
  assert(c.gateRoot === seed.gateRoot && c.jenkinsOrigin === origin(seed.jenkinsOrigin) && c.agentLabel === (seed.agentLabel || 'wl-quality-isolated'), '同份登记不能静默变更共享安装、Jenkins入口或节点');
  c.bindings = [...c.bindings.filter(value => value.id !== b.id), b];
  const clusterFile=path.join(path.dirname(registryFile),'jenkins-cluster.json');
  if(existsSync(clusterFile)){
    const cluster=readControlledJson(clusterFile);
    assert(cluster.kind==='wl-quality-jenkins-cluster'&&origin(cluster.jenkinsOrigin)===origin(c.jenkinsOrigin),'集群配置身份不匹配');
    validateNativeEntry(cluster.nativeEntry);c.nativeEntry=structuredClone(cluster.nativeEntry);
  }
  validateJenkinsRegistry(c);
  // Reuse the exact runtime project checks at plan time without pretending to be Jenkins.
  const context = { binding:b, mode:'check' }; assertBoundCheckout(context,root,{});
  if (b.jobs.build) {
  const trust = loadReleaseReviewTrust(b.review.trustFile,b.project);
  assert(trust.scope === b.scope && trust.requireResolvedFindings && trust.requireTechnicalManagerReview && trust.profile === 'standard', '先交付当前scope的严格Review信任配置');
  for (const key of ['policyHash','rulesHash','baselineHash','waiversHash','reviewPolicyHash']) assert(trust[key] === b.pins[key], `中央信任尚未登记当前批准${key}`);
  }
  const plan = { schemaVersion:1, kind:'jenkins-binding-plan', status:'preview', root, seedFile, seedHash:digest(readFileSync(seedFile)), registryFile, beforeHash:before && digest(before), config:c,
    summary:{ id:b.id, project:b.project, branch:b.branch, scope:b.scope, policyFile:b.policyFile, evidencePlanFile:b.evidencePlanFile, requiredChecks:policy.policy.checks.filter(v=>v.profiles.includes('standard') && v.required !== false).map(v=>v.id), jobs:b.jobs, automaticRemoteChanges:false },
    pipelineScript:renderJenkinsEntry(c,registryFile), remoteValidated:false };
  plan.planHash = digest(stableStringify(plan)); return plan;
}

export async function applyJenkinsBinding(options) {
  assert(options.confirm === true && HASH.test(options.planHash || ''), '生成接入登记须确认已展示的计划摘要');
  const plan = planJenkinsBinding(options); assert(plan.planHash === options.planHash, '接入说明、源码、包或登记已变化，重新预览确认');
  return lockedJson(plan.registryFile, {}, state => {
    const current = existsSync(plan.registryFile) ? digest(readFileSync(plan.registryFile)) : null;
    assert(current === plan.beforeHash, '取得锁后接入登记已变化，拒绝覆盖');
    const fresh = planJenkinsBinding(options); assert(fresh.planHash === plan.planHash, '取得锁后计划变化，拒绝写入');
    for (const key of Object.keys(state)) delete state[key]; Object.assign(state,plan.config);
    return { status:'jenkins-binding-written', registryFile:plan.registryFile, pipelineScript:plan.pipelineScript, summary:plan.summary, remoteValidated:false,
      nextAction:'两个受控Job使用同一段生成入口；按登记配置检查Job的目标分支Push。先验收正反场景，不自动修改Jenkins/GitLab权限。' };
  });
}

// A separate service-side read proves the operator really installed the fixed
// entry and trigger. A green job alone is never an admission proof.
export async function verifyJenkinsJobs({registryFile,env=process.env,fetchImpl=fetch}) {
  registryFile=absolute(registryFile,'接入登记');
  const original=readFileSync(regular(registryFile)),c=validateJenkinsRegistry(JSON.parse(original));
  const user=env.WL_JENKINS_READ_USER,token=env.WL_JENKINS_READ_TOKEN;
  assert(typeof user==='string' && user && !/[:\r\n]/.test(user) && typeof token==='string' && token && !/[\r\n]/.test(token),'远端预检需要受限Jenkins只读凭据，不取提交人的个人Token');
  const expected=renderJenkinsEntry(c,registryFile).replace(/\r\n/g,'\n').trim(),jobs=[];
  const get=async(job)=>{
    const route=job.split('/').map(p=>'job/'+encodeURIComponent(p)).join('/')+'/config.xml';
    const response=await fetchImpl(new URL(route,c.jenkinsOrigin).href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Basic '+Buffer.from(user+':'+token).toString('base64')}});
    assert(response.status===200,'无法读取受控Job配置；需要范围内config.xml读取权限，不按普通绿色状态放行');
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;assert(size<=2*1024*1024,'Job配置超出预算');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  };
  const one=(parent,name)=>{const nodes=parent.children.filter(v=>v.name===name);assert(nodes.length===1,`Jenkins配置缺失或重复${name}`);return nodes[0];};
  const descendants=(node,predicate)=>[...(predicate(node)?[node]:[]),...node.children.flatMap(child=>descendants(child,predicate))];
  for(const b of c.bindings) for(const [mode,job] of Object.entries(b.jobs)) {
    const bytes=await get(job),tree=parseXml(bytes.toString('utf8'));
    assert(tree.name==='flow-definition','仅支持已核对的普通Pipeline任务');
    const definition=one(tree,'definition');assert(definition.attrs.class==='org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition','任务必须采用受控Pipeline script，不能从业务分支取Jenkinsfile');
    assert(one(definition,'script').text.replace(/\r\n/g,'\n').trim()===expected,'远端任务漏接、改写或绕过了Gate薄入口');
    assert(one(tree,'disabled').text==='false','验证任务仍被禁用');
    const triggerContainers=descendants(tree,node=>node.name==='triggers'),triggers=triggerContainers.flatMap(node=>node.children);
    if(mode==='build') assert(triggers.length===0,'构建任务不得另接Push/定时/上游成功即构建触发');
    else {
      assert(triggers.length===1 && triggers[0].name==='com.dabsquared.gitlabjenkins.GitLabPushTrigger','检查任务必须只有一个批准的GitLab Push入口');
      const trigger=triggers[0];assert(one(trigger,'triggerOnPush').text==='true' && one(trigger,'branchFilterType').text==='NameBasedFilter' && one(trigger,'includeBranchesSpec').text===b.branch && one(trigger,'excludeBranchesSpec').text==='', 'GitLab检查触发须精确过滤登记目标分支');
      assert(trigger.children.filter(node=>node.name.startsWith('triggerOn') && node.name!=='triggerOnPush').every(node=>node.text!=='true'),'检查任务开启了重叠事件触发');
      assert(one(trigger,'secretToken').text.trim(),'检查任务缺少Webhook鉴权Secret');
    }
    assert(digest(await get(job))===digest(bytes),'预检期间远端Job配置变化，重新核对');
    jobs.push({id:b.id,project:b.project,scope:b.scope,branch:b.branch,mode,job,jobConfigHash:digest(bytes),pipelineEntryVerified:true});
  }
  assert(digest(readFileSync(registryFile))===digest(original),'预检期间接入登记变化');
  return {status:'job-wiring-verified',jobs,registryHash:digest(original),runtimeExecuted:false,remotePermissionsAndBusinessClosureValidated:false};
}
