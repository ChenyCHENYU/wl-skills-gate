import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { signRecord, verifyRecord, validateTime, ENVIRONMENTS } from "./evidence.js";
import { safePath, artifactDigest } from "./source-state.js";
import { stableStringify } from "./util.js";
import { acquireControlledLock } from "./control-store.js";
import { controlledPath, releaseDigest, releaseJson, verifyReleaseSet, verifyReleaseCompatibility, writeReleaseJson } from "./release-set.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, HASH = /^[a-f0-9]{64}$/;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const digestJson = (value) => releaseDigest(stableStringify(value));
const actions = ["deploy", "smoke", "recover"];
function fileDigest(file) { return releaseDigest(readFileSync(controlledPath(file))); }
function approvedLink(value, config) {
  const u = new URL(value); assert(u.protocol === "https:" && config.allowedLinkOrigins.includes(u.origin) && !u.username && !u.password && !u.hash && ![...u.searchParams.keys()].some((k) => /token|secret|password|key/i.test(k)) && value.length <= 512, "部署证据链接越出批准来源或携带凭据"); return value;
}
export function loadDeploymentConfig(configFile) {
  const c = releaseJson(controlledPath(configFile));
  assert(c.schemaVersion === 1 && c.kind === "deployment-config" && ID.test(c.issuer || "") && ID.test(c.lane || "") && ENVIRONMENTS.includes(c.environment), "部署执行配置身份/环境无效");
  assert(ID.test(c.authorizationIssuer || "") && ID.test(c.releaseIssuer || "") && Array.isArray(c.projects) && c.projects.length && c.projects.every((p) => ID.test(p)) && new Set(c.projects).size === c.projects.length, "部署执行配置来源/项目集合无效");
  assert(Array.isArray(c.operators) && c.operators.length && c.operators.every((v) => ID.test(v)) && Array.isArray(c.verifiers) && c.verifiers.length && c.verifiers.every((v) => ID.test(v)) && !c.operators.some((v) => c.verifiers.includes(v)), "部署操作人与验证人必须分别登记且相互独立");
  assert(Array.isArray(c.requiredSmokeChecks) && c.requiredSmokeChecks.length && c.requiredSmokeChecks.every((v) => ID.test(v)) && new Set(c.requiredSmokeChecks).size === c.requiredSmokeChecks.length, "必须登记实际冒烟检查集合");
  c.releaseMaxAgeMinutes ??= 1440; c.recoveryMaxAgeMinutes ??= 1440;
  assert([c.releaseMaxAgeMinutes, c.recoveryMaxAgeMinutes].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 129600), "正常发布/恢复证明有效期必须明确且不超过90天");
  assert(Array.isArray(c.allowedLinkOrigins) && c.allowedLinkOrigins.length && c.allowedLinkOrigins.every((value) => { const u = new URL(value); return u.protocol === "https:" && u.origin === value; }), "缺少部署证据批准HTTPS来源");
  for (const key of ["commandsRoot", "artifactRoot", "stateFile", "releasePublicKeyFile", "authorizationPublicKeyFile", "reviewConfigFile"]) assert(typeof c[key] === "string" && path.isAbsolute(c[key]) && controlledPath(c[key]), `部署配置 ${key} 必须为受控绝对路径`);
  for (const action of actions) {
    const command = c.commands?.[action];
    assert(command && typeof command.program === "string" && path.isAbsolute(command.program) && HASH.test(command.programHash || "") && HASH.test(command.scriptHash || "") && typeof command.script === "string" && Array.isArray(command.args) && command.args.every((a) => typeof a === "string" && !/[\0\r\n]/.test(a)) && Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0 && command.timeoutMs <= 1800000, `缺少固定 ${action} 可执行程序/脚本摘要与预算`);
    assert(Array.isArray(command.configFiles) && command.configFiles.every((f) => typeof f.path === "string" && HASH.test(f.sha256 || "")) && new Set(command.configFiles.map((f) => f.path)).size === command.configFiles.length, "执行脚本关联配置必须固定摘要且不重复");
    controlledPath(safePath(c.commandsRoot, command.script));
    assert(command.environment && typeof command.environment === "object" && !Array.isArray(command.environment) && Object.entries(command.environment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === "string" && !/[\0]/.test(value)), "执行环境变量必须来自受控配置");
    assert(Array.isArray(command.secretEnv) && command.secretEnv.every((key) => /^[A-Z][A-Z0-9_]*$/.test(key)), "受控凭据变量名无效");
  }
  if (c.ci !== undefined) {
    const ci = c.ci, origin = new URL(ci.baseUrl);
    assert(ci.system === "jenkins" && origin.protocol === "https:" && origin.origin === ci.baseUrl && typeof ci.jobPath === "string" && ci.jobPath.split("/").every((part) => part && part !== "." && part !== ".." && !/[\u0000-\u001f\\?#%]/.test(part)) && ID.test(ci.jobId || ""), "部署CI必须固定Jenkins HTTPS来源/实际jobPath/通道jobId");
    assert(c.allowedLinkOrigins.includes(ci.baseUrl), "部署CI来源未在部署证据允许来源登记");
  }
  return c;
}

export function verifyDeploymentCiContext(config, context) {
  const ci = config.ci;
  assert(ci && context && context.system === ci.system && context.baseUrl === ci.baseUrl && context.jobPath === ci.jobPath && context.jobId === ci.jobId && Number.isSafeInteger(context.buildNumber) && context.buildNumber > 0 && context.buildNumber <= Math.floor((Number.MAX_SAFE_INTEGER - 9999) / 10000), "部署执行缺少固定CI签名上下文或运行序号越界");
  const jobPath = ci.jobPath.split("/").map((part) => `job/${encodeURIComponent(part)}`).join("/");
  assert(context.buildUrl === `${ci.baseUrl}/${jobPath}/${context.buildNumber}/`, "部署执行CI URL与固定job/真实构建编号不匹配");
  return context;
}
export function resolveDeploymentCiContext({ configFile, env = process.env }) {
  const config = loadDeploymentConfig(configFile); if (!config.ci) return null;
  assert(env.JOB_NAME === config.ci.jobPath && /^[1-9]\d*$/.test(env.BUILD_NUMBER || ""), "实际Jenkins JOB_NAME/BUILD_NUMBER与固定部署作业不匹配");
  return verifyDeploymentCiContext(config, { ...config.ci, buildNumber: Number(env.BUILD_NUMBER), buildUrl: env.BUILD_URL });
}
function currentState(stateFile, c) {
  assert(path.resolve(stateFile) === path.resolve(c.stateFile), "部署状态文件不是中央固定台账，禁止更换空账重放授权");
  const initial = { schemaVersion: 1, kind: "deployment-state", issuer: c.issuer, environment: c.environment, lane: c.lane, revision: 0, activeReleaseSetHash: null, previousReleaseSetHash: null, deploymentId: null, verification: null, consumedAuthorizations: [] };
  const value = existsSync(controlledPath(stateFile)) ? releaseJson(stateFile) : initial;
  assert(value.schemaVersion === 1 && value.kind === "deployment-state" && value.issuer === c.issuer && value.environment === c.environment && value.lane === c.lane && Number.isSafeInteger(value.revision) && value.revision >= 0 && ["activeReleaseSetHash", "previousReleaseSetHash"].every((k) => value[k] === null || HASH.test(value[k] || "")) && Array.isArray(value.consumedAuthorizations) && value.consumedAuthorizations.every((v) => ID.test(v)) && new Set(value.consumedAuthorizations).size === value.consumedAuthorizations.length, "当前部署状态损坏/来源不匹配，禁止重置");
  for (const attempt of [value.lastFailedAttempt, value.inFlightAttempt].filter(Boolean)) assert(ID.test(attempt.executionId || "") && actions.includes(attempt.action) && HASH.test(attempt.releaseSetHash || "") && (attempt.knownActiveReleaseSetHash === null || HASH.test(attempt.knownActiveReleaseSetHash || "")) && attempt.knownActiveReleaseSetHash === value.activeReleaseSetHash, "当前未决/失败部署记录损坏，禁止当作已确定目标");
  if (value.activeReleaseSetHash) assert(value.activeReleaseConstraints && value.activeCompatibility, "既有活动版本缺API/schema/回退原始证据，须受控核验迁移，禁止默认兼容");
  if (value.activeReleaseConstraints) {
    const prior = value.activeReleaseConstraints;
    assert(value.activeCompatibility && HASH.test(prior.compatibilityHash || "") && prior.compatibilityHash === digestJson(value.activeCompatibility) && HASH.test(prior.apiContractHash || "") && ID.test(prior.schemaVersion || "") && typeof prior.backwardCompatible === "boolean" && ["compatible", "requires-approved-recovery"].includes(prior.rollbackMode), "活动版本API/schema/回退约束损坏");
    verifyReleaseCompatibility(value.activeCompatibility, Object.entries(value.activeCompatibility.componentShas || {}).map(([project, sha]) => ({ project, sha })));
  }
  return value;
}
function verifyCommand(c, action) {
  const command = c.commands[action], scriptFile = controlledPath(safePath(c.commandsRoot, command.script));
  assert(lstatSync(command.program).isFile() && fileDigest(command.program) === command.programHash && lstatSync(scriptFile).isFile() && fileDigest(scriptFile) === command.scriptHash, "批准执行程序/脚本变化，重新审阅配置");
  for (const file of command.configFiles) assert(fileDigest(safePath(c.commandsRoot, file.path)) === file.sha256, "批准执行脚本配置变化");
  return { ...command, scriptFile };
}
function actualArtifacts(c, releaseSet) {
  for (const component of releaseSet.components) {
    const componentRoot = controlledPath(safePath(c.artifactRoot, component.project));
    for (const entry of [...component.manifest.artifacts, ...component.manifest.configFiles]) assert(artifactDigest(controlledPath(safePath(componentRoot, entry.path))) === entry.sha256, `待部署制品/配置变化: ${component.project}/${entry.path}`);
  }
}
function actualCommandEvidence(result, root) {
  assert(typeof result.observationFile === "string" && HASH.test(result.observationHash || "") && fileDigest(safePath(root, result.observationFile)) === result.observationHash, "actual-target-observation-missing");
  for (const check of result.checks || []) assert(typeof check.evidenceFile === "string" && HASH.test(check.evidenceHash || "") && fileDigest(safePath(root, check.evidenceFile)) === check.evidenceHash, "required-actual-smoke-evidence-missing");
}
export function planDeployment({ configFile, releaseSetFile, expectReleaseSetHash, stateFile, action, outFile, now = new Date() }) {
  const c = loadDeploymentConfig(configFile); assert(actions.includes(action), "部署动作必须为deploy/smoke/recover");
  const verified = verifyReleaseSet({ releaseSetFile, reviewConfigFile: c.reviewConfigFile, allowHistoricalReview: action !== "deploy", publicKeyFile: c.releasePublicKeyFile, expectIssuer: c.releaseIssuer, expectReleaseSetHash, env: c.environment, now, maxAgeMinutes: action === "deploy" ? c.releaseMaxAgeMinutes : c.recoveryMaxAgeMinutes });
  assert(stableStringify(verified.releaseSet.components.map((x) => x.project).sort()) === stableStringify([...c.projects].sort()), "前后端组合项目集合不完整或多出未批准组件");
  const state = currentState(stateFile, c); verifyCommand(c, action); actualArtifacts(c, verified.releaseSet);
  const contract = verifyReleaseCompatibility(verified.releaseSet.compatibility, verified.releaseSet.components), db = verified.releaseSet.compatibility.declaration.database;
  let expectedSchemaVersion = contract.schemaVersion;
  const prior = state.activeReleaseConstraints;
  let databaseExecution = { mode: db.mode, fromSchema: db.mode === "none" ? db.schemaVersion : db.fromSchema, toSchema: expectedSchemaVersion };
  if (action === "smoke" && prior) { expectedSchemaVersion = prior.schemaVersion; databaseExecution = { mode: "preserve-current-schema", fromSchema: prior.schemaVersion, toSchema: prior.schemaVersion }; }
  if (action === "deploy" && prior) assert(prior.schemaVersion === databaseExecution.fromSchema, "当前实际已知schema与本次无变更/迁移起点不匹配，禁止隐式降级或漏迁移");
  if (action === "recover" && prior && prior.schemaVersion !== expectedSchemaVersion) {
    if (prior.backwardCompatible === true) { expectedSchemaVersion = prior.schemaVersion; databaseExecution = { mode: "preserve-compatible-schema", fromSchema: prior.schemaVersion, toSchema: prior.schemaVersion, compatibilityHash: prior.compatibilityHash }; }
    else {
      assert(state.activeCompatibility?.declaration.rollback.mode === "requires-approved-recovery" && state.activeCompatibility.declaration.rollback.recoveryEvidence, "当前schema不兼容回退且缺少已批准恢复原始文件，禁止恢复");
      databaseExecution = { mode: "approved-recovery", fromSchema: prior.schemaVersion, toSchema: expectedSchemaVersion, compatibilityHash: prior.compatibilityHash, recoveryEvidence: state.activeCompatibility.declaration.rollback.recoveryEvidence };
    }
  }
  if (action === "smoke") assert(state.activeReleaseSetHash === expectReleaseSetHash && ID.test(state.deploymentId || ""), "只能验证当前已部署组合");
  const unresolved = state.inFlightAttempt || state.lastFailedAttempt;
  if (action === "recover") assert(state.previousReleaseSetHash === expectReleaseSetHash && state.activeReleaseSetHash !== expectReleaseSetHash || unresolved?.action === "deploy" && state.activeReleaseSetHash === expectReleaseSetHash && unresolved.releaseSetHash !== expectReleaseSetHash, "恢复只能指向当前记录的上一组合或失败部署前的已知活动组合，禁止任意回退");
  const plan = { schemaVersion: 1, kind: "deployment-plan", action, configHash: digestJson(c), releaseSetHash: expectReleaseSetHash, releaseSetId: verified.releaseSet.releaseSetId, environment: c.environment, lane: c.lane, stateHash: digestJson(state), createdAt: now.toISOString(), compatibility: verified.releaseSet.compatibility.declaration, compatibilityHash: contract.compatibilityHash, apiContractHash: contract.apiContractHash, deploymentOrder: contract.deploymentOrder, expectedSchemaVersion, databaseExecution, previousReleaseConstraints: prior || null, components: verified.releaseSet.components.map(({ project, sha, artifactHash, manifestHash }) => ({ project, sha, artifactHash, manifestHash })) };
  const planHash = digestJson(plan); if (outFile) writeReleaseJson(outFile, { ...plan, planHash });
  return { ...plan, planHash, executed: false };
}

// This executor runs only immutable, centrally approved programs, never shell
// text from a project, webhook or authorization. Default invocation is preview.
export function runDeployment({ configFile, releaseSetFile, expectReleaseSetHash, stateFile, planFile, authorizationFile, privateKeyFile, outDir, send = false, env = process.env, now = new Date(), spawnImpl = spawnSync }) {
  const c = loadDeploymentConfig(configFile), plan = releaseJson(controlledPath(planFile));
  const ciContext = c.ci ? resolveDeploymentCiContext({ configFile, env }) : null;
  const { planHash, ...body } = plan;
  assert(HASH.test(planHash || "") && planHash === digestJson(body), "部署计划摘要不一致"); validateTime(plan.createdAt, { now, maxAgeMinutes: 60 });
  const fresh = planDeployment({ configFile, releaseSetFile, expectReleaseSetHash, stateFile, action: plan.action, now: new Date(plan.createdAt) });
  assert(fresh.planHash === planHash, "当前配置/制品/部署状态已变化，旧授权拒绝");
  if (!send) return { status: "preview", planHash, executed: false };
  const authorization = releaseJson(controlledPath(authorizationFile)); verifyRecord(authorization, c.authorizationPublicKeyFile);
  assert(authorization.schemaVersion === 1 && authorization.kind === "deployment-authorization" && ID.test(authorization.authorizationId || "") && authorization.issuer === c.authorizationIssuer && authorization.scope === "deployment-execute" && authorization.decision === "approved" && authorization.action === plan.action && authorization.planHash === planHash && authorization.releaseSetHash === expectReleaseSetHash && authorization.environment === c.environment && authorization.stateHash === plan.stateHash && typeof authorization.reason === "string" && authorization.reason.trim(), "部署执行缺少对应动作/计划/环境/当前状态的明确授权");
  validateTime(authorization.createdAt, { now, maxAgeMinutes: 60 });
  const expires = Date.parse(authorization.expiresAt); assert(Number.isFinite(expires) && expires > now.getTime() && expires <= Date.parse(authorization.createdAt) + 3600000, "部署动作授权已过期或有效期过长");
  const permitted = plan.action === "smoke" ? c.verifiers : c.operators;
  assert(permitted.includes(authorization.actorId), "当前人员没有该部署/独立验证动作权限");
  const verified = verifyReleaseSet({ releaseSetFile, reviewConfigFile: c.reviewConfigFile, allowHistoricalReview: plan.action !== "deploy", publicKeyFile: c.releasePublicKeyFile, expectIssuer: c.releaseIssuer, expectReleaseSetHash, env: c.environment, now, maxAgeMinutes: plan.action === "deploy" ? c.releaseMaxAgeMinutes : c.recoveryMaxAgeMinutes });
  signRecord({ kind: "executor-key-preflight" }, controlledPath(privateKeyFile));
  assert(!verified.releaseSet.components.some((x) => x.authorId === authorization.actorId), "部署/验证授权人不能是组合组件作者");
  const statePath = controlledPath(stateFile), output = controlledPath(outDir);
  assert(!existsSync(output), "部署输出目录已存在，不覆盖旧执行记录"); mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  let release; try { release = acquireControlledLock(`${statePath}.lock`, statePath); } catch (error) { throw new Error(`当前环境部署锁禁止并发操作：${error.message}`); }
  let outputOwned = false;
  try {
    const current = currentState(statePath, c);
    assert(digestJson(current) === plan.stateHash && !current.consumedAuthorizations.includes(authorization.authorizationId), "部署状态已变更或授权已使用，禁止重放");
    if (plan.action === "smoke") assert(current.deployedBy !== authorization.actorId, "部署操作人与实际验证人必须独立");
    const command = verifyCommand(c, plan.action); actualArtifacts(c, verified.releaseSet);
    const commandEnv = { ...command.environment };
    for (const key of command.secretEnv) { assert(typeof env[key] === "string" && env[key], "缺少本动作批准凭据变量"); commandEnv[key] = env[key]; }
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); mkdirSync(output, { mode: 0o700 }); outputOwned = true;
    const executionId = `execution-${randomUUID()}`, contextFile = path.join(output, "context.json"), resultFile = path.join(output, "command-result.json");
    writeReleaseJson(contextFile, { schemaVersion: 1, kind: "deployment-context", executionId, action: plan.action, planHash, releaseSet: verified.releaseSet, releaseSetHash: expectReleaseSetHash, artifactRoot: c.artifactRoot, environment: c.environment, lane: c.lane, compatibilityHash: plan.compatibilityHash, apiContractHash: plan.apiContractHash, deploymentOrder: plan.deploymentOrder, expectedSchemaVersion: plan.expectedSchemaVersion, databaseExecution: plan.databaseExecution, previousReleaseConstraints: plan.previousReleaseConstraints, recoveryCompatibility: plan.action === "recover" ? current.activeCompatibility || null : null, currentDeploymentId: current.deploymentId, reconciliationRequired: !!(current.lastFailedAttempt || current.inFlightAttempt), allowedCurrentReleaseSetHashes: [...new Set([current.activeReleaseSetHash, current.lastFailedAttempt?.releaseSetHash, current.inFlightAttempt?.releaseSetHash].filter(Boolean))], requiredSmokeChecks: c.requiredSmokeChecks, resultFile });
    // Reserve the authorization before any side effect. A crash or failed command
    // needs a new explicit authorization; it can never replay the previous one.
    const reserved = { ...current, inFlightAttempt: { executionId, action: plan.action, releaseSetHash: expectReleaseSetHash, knownActiveReleaseSetHash: current.activeReleaseSetHash }, consumedAuthorizations: [...current.consumedAuthorizations, authorization.authorizationId], revision: current.revision + 1 };
    const save = (value) => { const temporary = `${statePath}.${randomUUID()}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, statePath); };
    save(reserved);
    let result, commandResult = null, errorCode = null;
    try {
      result = spawnImpl(command.program, [command.scriptFile, ...command.args, "--wl-context", contextFile], { cwd: c.commandsRoot, env: commandEnv, encoding: "utf8", timeout: command.timeoutMs, maxBuffer: 1024 * 1024, shell: false });
      assert(result.status === 0 && !result.error && !result.signal, "approved-command-failed");
      commandResult = releaseJson(controlledPath(resultFile));
      assert(commandResult.schemaVersion === 1 && commandResult.kind === "deployment-command-result" && commandResult.action === plan.action && commandResult.executionId === executionId && commandResult.environment === c.environment && commandResult.releaseSetHash === expectReleaseSetHash && commandResult.actualReleaseSetHash === expectReleaseSetHash && commandResult.result === "passed" && ID.test(commandResult.deploymentId || ""), "approved-command-result-mismatch");
      approvedLink(commandResult.recordUrl, c);
      actualCommandEvidence(commandResult, output);
      assert(commandResult.compatibilityHash === plan.compatibilityHash && commandResult.apiContractHash === plan.apiContractHash && commandResult.databaseSchemaVersion === plan.expectedSchemaVersion && stableStringify(commandResult.appliedDeploymentOrder) === stableStringify(plan.deploymentOrder), "actual-api-schema-deployment-order-mismatch");
      if (plan.action === "smoke") {
        assert(commandResult.deploymentId === current.deploymentId && Array.isArray(commandResult.checks) && new Set(commandResult.checks.map((x) => x.id)).size === c.requiredSmokeChecks.length && commandResult.checks.length === c.requiredSmokeChecks.length && c.requiredSmokeChecks.every((id) => commandResult.checks.some((x) => x.id === id && x.status === "passed" && HASH.test(x.evidenceHash || ""))), "required-actual-smoke-evidence-missing");
      }
    } catch (error) { errorCode = /^approved-|^actual-|^required-/.test(error.message) ? error.message : "approved-command-result-invalid"; }
    const status = errorCode ? "failed" : "success";
    const next = structuredClone(reserved);
    next.inFlightAttempt = null;
    if (status === "success") {
      if (plan.action === "smoke") next.verification = { actorId: authorization.actorId, executionId, resultHash: fileDigest(resultFile), releaseSetHash: expectReleaseSetHash, recordUrl: commandResult.recordUrl };
      else { next.previousReleaseSetHash = current.activeReleaseSetHash; next.activeReleaseSetHash = expectReleaseSetHash; next.deploymentId = commandResult.deploymentId; next.deployedBy = authorization.actorId; next.verification = null; next.activeCompatibility = verified.releaseSet.compatibility; next.activeReleaseConstraints = { compatibilityHash: plan.compatibilityHash, apiContractHash: plan.apiContractHash, schemaVersion: plan.expectedSchemaVersion, backwardCompatible: verified.releaseSet.compatibility.declaration.database.mode === "none" || verified.releaseSet.compatibility.declaration.database.backwardCompatible, rollbackMode: verified.releaseSet.compatibility.declaration.rollback.mode }; }
      next.lastFailedAttempt = null;
    } else next.lastFailedAttempt = { executionId, action: plan.action, releaseSetHash: expectReleaseSetHash, knownActiveReleaseSetHash: current.activeReleaseSetHash, failedAt: now.toISOString() };
    save(next);
    const execution = signRecord({ schemaVersion: 1, kind: "deployment-execution", executionId, ...(ciContext ? { ciContext } : {}), issuer: c.issuer, configHash: digestJson(c), action: plan.action, status, environment: c.environment, lane: c.lane, planHash, releaseSetHash: expectReleaseSetHash, releaseSetId: verified.releaseSet.releaseSetId, authorizationId: authorization.authorizationId, authorizationHash: digestJson(authorization), compatibilityHash: plan.compatibilityHash, apiContractHash: plan.apiContractHash, databaseSchemaVersion: plan.expectedSchemaVersion, appliedDeploymentOrder: plan.deploymentOrder, actorId: authorization.actorId, deploymentId: status === "success" ? commandResult.deploymentId : current.deploymentId || executionId, stateBeforeHash: plan.stateHash, stateAfterHash: digestJson(next), activeReleaseUnchanged: status !== "success", createdAt: now.toISOString(), completedAt: new Date().toISOString(), commandResultHash: status === "success" ? fileDigest(resultFile) : null, recordUrl: status === "success" ? commandResult.recordUrl : null, observationHash: status === "success" ? commandResult.observationHash : null, checks: plan.action === "smoke" && status === "success" ? commandResult.checks : [], errorCode, exitStatus: result?.status ?? null, signal: result?.signal || null, stdoutHash: releaseDigest(String(result?.stdout || "")), stderrHash: releaseDigest(String(result?.stderr || "")) }, privateKeyFile);
    const executionFile = writeReleaseJson(path.join(output, "execution.json"), execution);
    return { status, action: plan.action, executed: true, executionFile, executionHash: digestJson(execution), activeReleaseUnchanged: status !== "success", exitCode: status === "success" ? 0 : 2 };
  } catch (error) {
    // Keep any output after we own it: a crash record is evidence, not garbage.
    if (outputOwned) { try { writeReleaseJson(path.join(output, "executor-error.json"), { schemaVersion: 1, kind: "deployment-executor-error", error: "executor-incomplete", planHash }); } catch {} }
    throw error;
  } finally { release(); }
}

export function createDeploymentLifecycle({ configFile, executionFile, executorPublicKeyFile, releaseSetFile, expectReleaseSetHash, project, sequence, pipelineId, jobId, pipelineUrl, reportUrl, outDir, now = Date.now() }) {
  const c = loadDeploymentConfig(configFile), execution = releaseJson(controlledPath(executionFile)); verifyRecord(execution, controlledPath(executorPublicKeyFile));
  assert(execution.schemaVersion === 1 && execution.kind === "deployment-execution" && execution.issuer === c.issuer && execution.configHash === digestJson(c) && execution.releaseSetHash === expectReleaseSetHash && execution.environment === c.environment && execution.lane === c.lane && actions.includes(execution.action) && ["success", "failed"].includes(execution.status), "部署原始执行证据身份/固定配置/组合摘要无效");
  validateTime(execution.createdAt, { now: new Date(now) });
  assert(ID.test(execution.executionId || "") && ID.test(execution.authorizationId || "") && ID.test(execution.actorId || "") && ID.test(execution.deploymentId || "") && HASH.test(execution.planHash || "") && HASH.test(execution.authorizationHash || ""), "部署原始执行证据授权/对象关联无效");
  const permitted = execution.action === "smoke" ? c.verifiers : c.operators; assert(permitted.includes(execution.actorId), "部署执行事实人员未登记");
  const verified = verifyReleaseSet({ releaseSetFile, reviewConfigFile: c.reviewConfigFile, allowHistoricalReview: execution.action !== "deploy", publicKeyFile: c.releasePublicKeyFile, expectIssuer: c.releaseIssuer, expectReleaseSetHash, env: c.environment, now: new Date(now), maxAgeMinutes: execution.action === "deploy" ? c.releaseMaxAgeMinutes : c.recoveryMaxAgeMinutes });
  const compatibility = verifyReleaseCompatibility(verified.releaseSet.compatibility, verified.releaseSet.components);
  assert(execution.compatibilityHash === compatibility.compatibilityHash && execution.apiContractHash === compatibility.apiContractHash && ID.test(execution.databaseSchemaVersion || "") && stableStringify(execution.appliedDeploymentOrder) === stableStringify(compatibility.deploymentOrder), "部署执行API/数据库/顺序事实与批准组合不符");
  const component = verified.releaseSet.components.find((x) => x.project === project); assert(component && !verified.releaseSet.components.some((x) => x.authorId === execution.actorId), "部署事实缺少当前项目组件或作者冒充验证人");
  assert(Number.isSafeInteger(sequence) && sequence > 0 && ID.test(pipelineId || "") && ID.test(jobId || ""), "部署事实必须显式绑定中央序号与实际执行作业"); approvedLink(pipelineUrl, c); approvedLink(reportUrl, c);
  const executionHash = digestJson(execution), sourceHash = fileDigest(executionFile), status = execution.status === "failed" ? "failed" : execution.action === "smoke" ? "verified" : "success";
  if (execution.status === "success") {
    const resultFile = path.join(path.dirname(executionFile), "command-result.json"), result = releaseJson(controlledPath(resultFile));
    assert(fileDigest(resultFile) === execution.commandResultHash && result.executionId === execution.executionId && result.action === execution.action && result.deploymentId === execution.deploymentId && result.releaseSetHash === expectReleaseSetHash && result.actualReleaseSetHash === expectReleaseSetHash && result.result === "passed" && result.observationHash === execution.observationHash && result.recordUrl === execution.recordUrl && result.compatibilityHash === execution.compatibilityHash && result.apiContractHash === execution.apiContractHash && result.databaseSchemaVersion === execution.databaseSchemaVersion && stableStringify(result.appliedDeploymentOrder) === stableStringify(execution.appliedDeploymentOrder) && stableStringify(result.checks || []) === stableStringify(execution.checks || []), "部署原始命令结果缺失/变化或摘要不一致");
    actualCommandEvidence(result, path.dirname(executionFile));
  }
  const event = { schemaVersion: 1, kind: "lifecycle-event", eventId: `deploy:${releaseDigest(`${executionHash}:${project}:${sequence}`).slice(0, 48)}`, project, scope: component.scope, category: "deploy", lane: c.lane, environment: c.environment, status, sha: component.sha, authorId: component.authorId, actorId: execution.actorId, sequence, pipelineId, jobId, occurredAt: execution.createdAt, reportUrl, pipelineUrl, source: { system: "deployment", recordId: execution.executionId, recordHash: sourceHash, observedAt: new Date(now).toISOString(), url: reportUrl }, deploymentId: execution.deploymentId, authorizationId: execution.authorizationId, releaseSetHash: expectReleaseSetHash, executionHash, artifactHash: component.artifactHash, manifestHash: component.manifestHash, compatibilityHash: execution.compatibilityHash, apiContractHash: execution.apiContractHash, databaseSchemaVersion: execution.databaseSchemaVersion, appliedDeploymentOrder: execution.appliedDeploymentOrder, operation: execution.action };
  if (status === "verified") {
    assert(HASH.test(execution.commandResultHash || "") && HASH.test(execution.observationHash || "") && Array.isArray(execution.checks) && execution.checks.length === c.requiredSmokeChecks.length && c.requiredSmokeChecks.every((id) => execution.checks.some((x) => x.id === id && x.status === "passed" && HASH.test(x.evidenceHash || ""))), "部署验证事实缺少实际冒烟结果");
    event.verificationHash = execution.commandResultHash; event.verificationUrl = approvedLink(execution.recordUrl, c);
  }
  const output = controlledPath(outDir); assert(!existsSync(output), "部署事实目录已存在，不覆盖旧事实"); mkdirSync(output, { recursive: true, mode: 0o700 });
  const eventFile = writeReleaseJson(path.join(output, "lifecycle-event.json"), event);
  return { status, category: "deploy", signed: false, eventFile, sourceFile: path.resolve(executionFile), sourceHash };
}

export function createDeploymentLifecycles(options) {
  const config = loadDeploymentConfig(options.configFile), output = controlledPath(options.outDir);
  assert(!existsSync(output), "组合部署事实目录已存在");
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  const facts = config.projects.map((project) => ({ project, ...createDeploymentLifecycle({ ...options, project, outDir: path.join(output, project) }) }));
  const manifestFile = writeReleaseJson(path.join(output, "facts-manifest.json"), { schemaVersion: 1, kind: "deployment-facts", executionHash: fileDigest(options.executionFile), releaseSetHash: options.expectReleaseSetHash, facts: facts.map(({ project, eventFile, sourceHash }) => ({ project, eventFile: path.relative(output, eventFile).split(path.sep).join("/"), sourceHash })) });
  return { facts, manifestFile, signed: false };
}
