import path from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, lstatSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify, createHmac, randomUUID } from "node:crypto";
import { sha256, stableStringify } from "./util.js";
import { validateReportFile } from "./validate-report.js";
import { validatePassingSummary } from "./evidence.js";
import { issueNotification, lifecycleNotification } from "./governance-notifications.js";
import { acquireControlledLock } from "./control-store.js";
import {scopeNotification,scopeChannel,checkSnapshot,checkSnapshotHash,centralCheckNotification} from './central-check-notification.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LEVEL = { info: 0, warning: 1, error: 2, blocker: 3 };
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const id = (value) => typeof value === "string" && ID.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const time = (value) => { const n = Date.parse(value); assert(typeof value === "string" && Number.isFinite(n), "时间无效"); return n; };
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

export function loadGovernanceConfig(file) {
  const c = read(file);
  assert(c.schemaVersion === 1 && id(c.issuer), "governance config schemaVersion/issuer 无效");
  assert(typeof c.publicKeyFile === "string" && c.publicKeyFile, "缺少平台事件固定公钥 publicKeyFile");
  c.publicKeyFile = path.resolve(path.dirname(file), c.publicKeyFile);
  assert(Array.isArray(c.allowedLinkOrigins) && c.allowedLinkOrigins.length > 0, "缺少认证链接允许来源");
  for (const origin of c.allowedLinkOrigins) { const u = new URL(origin); assert(u.protocol === "https:" && u.origin === origin, "链接来源须为 HTTPS origin"); }
  assert(c.projects && Object.keys(c.projects).length > 0 && c.channels && typeof c.channels === "object", "缺少项目/渠道映射");
  assert(Array.isArray(c.operators) && c.operators.length > 0 && c.operators.every(id), "必须登记渠道运维操作人");
  if(c.people !== undefined) {
    assert(c.people && typeof c.people === "object" && !Array.isArray(c.people),"实名映射people无效");
    for(const [actor,p] of Object.entries(c.people)) {
      assert(id(actor) && typeof p.name === "string" && p.name.trim() && p.name.length<=80 && !/[\u0000-\u001f]/.test(p.name),"实名映射缺人员标识/姓名");
      assert(Array.isArray(p.roles) && p.roles.every(role=>typeof role==="string" && role),"实名映射roles无效");
      if(p.feishu !== undefined) assert(["open_id","user_id"].includes(p.feishu.idType) && /^[A-Za-z0-9_-]{1,128}$/.test(p.feishu.id || "") && p.feishu.id!=="all" && (p.feishu.idType!=="open_id" || p.feishu.id.startsWith("ou_")),"飞书实名ID无效；禁止all/email/union_id冒充个人@");
    }
  }
  for (const [name, p] of Object.entries(c.projects)) {
    assert(id(name) && id(p.owner) && id(p.backup) && p.owner !== p.backup && id(p.escalationOwner), "项目主备/升级责任无效");
    assert(Array.isArray(p.reviewers) && p.reviewers.length > 0 && p.reviewers.every(id) && !p.reviewers.includes(p.owner) && !p.reviewers.includes(p.backup), "关闭复核人须独立于主备");
    if (p.members !== undefined) assert(Array.isArray(p.members) && p.members.every(id) && new Set(p.members).size === p.members.length, "项目成员身份列表无效");
    assert(id(p.channel) && Object.hasOwn(c.channels, p.channel), "项目消息渠道未登记");
    if(p.technicalManager !== undefined) assert(id(p.technicalManager),"技术经理人员标识无效");
    if(p.managerSubmissionNotify !== undefined) {
      assert(id(p.managerSubmissionNotify) && c.people?.[p.managerSubmissionNotify],"技术经理本人提交的同步人须登记实名");
      assert(p.managerSubmissionNotify!==p.technicalManager && (!c.people[p.managerSubmissionNotify].feishu?.id || c.people[p.managerSubmissionNotify].feishu.id!==c.people[p.technicalManager]?.feishu?.id),"同步人不能与技术经理为同一飞书人员");
    }
    if(p.requireTechnicalManagerReview !== undefined) assert(typeof p.requireTechnicalManagerReview==="boolean","技术经理确认策略须为布尔值");
    if(p.requireTechnicalManagerReview === true) assert(id(p.technicalManager) && c.people?.[p.technicalManager]?.roles.includes("technical-manager"),"技术经理确认须绑定实名角色");
    if(p.requireRiskMentions === true) {
      assert(c.channels[p.channel].type==="feishu" && id(p.technicalManager) && c.people?.[p.technicalManager]?.roles.includes("technical-manager"),"强制@必须配置真实飞书渠道与技术经理角色");
      for(const actor of new Set([p.technicalManager,p.owner,p.backup,...(p.members || []),...(p.managerSubmissionNotify ? [p.managerSubmissionNotify] : [])])) assert(c.people?.[actor]?.feishu,"强制@缺少人员姓名/飞书ID映射");
    }
    const u = new URL(p.issueBaseUrl); assert(p.issueBaseUrl.length <= 512 && c.allowedLinkOrigins.includes(u.origin) && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash, "问题认证入口不合法");
    assert(p.scopes && Object.keys(p.scopes).length > 0, "项目没有批准的检查范围");
    for (const [scope, s] of Object.entries(p.scopes)) {
      assert(id(scope) && Array.isArray(s.requiredChecks) && s.requiredChecks.length && s.requiredChecks.every(id) && new Set(s.requiredChecks).size === s.requiredChecks.length, "必需检查集无效");
      for (const key of ["policyHash", "rulesHash", "baselineHash", "waiversHash"]) assert(HASH.test(s[key] || ""), `批准摘要缺失: ${key}`);
      if(s.notification!==undefined){
        const n=s.notification;
        assert(n && Object.keys(n).every(k=>['channel','surface','branch','validationBranch','requireResolvedFindings','technicalManager'].includes(k)) && ['project-summary','ci-summary'].includes(n.surface) && c.channels[n.channel]?.type==='feishu','检查卡片须登记固定飞书渠道与展示类型');
        assert(typeof n.branch==='string' && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(n.branch) && !n.branch.includes('..') && (['dev','sit','uat','pre','prd','main'].includes(n.branch) || n.validationBranch===true),'通知分支须为六目标之一或明确批准的验证分支');
        assert(n.requireResolvedFindings===true,'本接入严格要求全部问题清零，不能降低卡片结论');
        if(n.validationBranch!==undefined)assert(typeof n.validationBranch==='boolean','验证分支批准须为布尔值');
        if(n.technicalManager!==undefined)assert(id(n.technicalManager) && c.people?.[n.technicalManager]?.roles.includes('technical-manager') && (!p.requireRiskMentions || c.people[n.technicalManager].feishu),'范围技术经理缺实名角色或飞书映射');
      }
      if (s.closurePolicy !== undefined) {
        const cp = s.closurePolicy;
        assert(cp && cp.requireDeployment === true && id(cp.deploymentLane) && Array.isArray(cp.requiredEnvironments) && cp.requiredEnvironments.length > 0 && new Set(cp.requiredEnvironments).size === cp.requiredEnvironments.length && cp.requiredEnvironments.every((e) => ["dev", "sit", "uat", "pre", "prd"].includes(e)), "关闭策略必须明确必要环境、固定部署通道并绑定实际部署验证");
      }
    }
  }
  for (const channel of Object.values(c.channels)) {
    assert(["feishu", "wecom"].includes(channel.type) && /^[A-Z][A-Z0-9_]+$/.test(channel.webhookEnv || ""), "渠道类型/webhook 环境变量无效");
    if (channel.type === "feishu") assert(/^[A-Z][A-Z0-9_]+$/.test(channel.signingSecretEnv || ""), "飞书必须登记签名密钥环境变量");
  }
  c.sla = { ackMinutes: 30, resolveMinutes: 1440, escalationMinutes: 60, ...c.sla };
  c.delivery = { maxAttempts: 3, retrySeconds: 60, timeoutMs: 10000, ...c.delivery };
  for (const value of Object.values(c.sla)) assert(Number.isInteger(value) && value > 0, "SLA 必须为正整数");
  for (const value of Object.values(c.delivery)) assert(Number.isInteger(value) && value > 0, "投递预算必须为正整数");
  assert(c.delivery.timeoutMs <= 60000 && c.delivery.maxAttempts <= 20, "投递超时/重试预算过大");
  return c;
}

export function signPlatformReceipt(payload, { privateKeyFile, issuer, createdAt = new Date().toISOString() }) {
  assert(payload?.schemaVersion === 1 && ["quality-event", "issue-action", "pipeline-expectations", "lifecycle-event", "governance-migration"].includes(payload.kind) && id(payload.eventId), "平台 receipt payload 无效");
  assert(stableStringify(payload) === stableStringify(JSON.parse(JSON.stringify(payload))), "平台 receipt 仅接受可无损保存的JSON字段");
  assert(id(issuer), "平台 issuer 无效"); time(createdAt);
  const body = { schemaVersion: 1, kind: "signed-platform-receipt", issuer, createdAt, payload };
  const key = createPrivateKey(readFileSync(privateKeyFile)); assert(key.asymmetricKeyType === "ed25519", "平台 receipt 必须使用 Ed25519");
  return { ...body, signature: sign(null, Buffer.from(stableStringify(body)), key).toString("base64") };
}

function receipt(file, config, now, expectedKind) {
  const input = read(file); const { signature, ...body } = input;
  assert(input.schemaVersion === 1 && input.kind === "signed-platform-receipt" && input.issuer === config.issuer && typeof signature === "string", "平台 receipt 身份/结构无效");
  assert(/^[A-Za-z0-9+/]{86}==$/.test(signature), "平台签名编码无效");
  const key = createPublicKey(readFileSync(config.publicKeyFile)); assert(key.asymmetricKeyType === "ed25519", "平台公钥不是 Ed25519");
  assert(verify(null, Buffer.from(stableStringify(body)), key, Buffer.from(signature, "base64")), "平台 receipt 签名无效");
  const age = now - time(input.createdAt); assert(age >= -60000 && age <= 86400000, "平台 receipt 过期或来自未来");
  assert(input.payload?.schemaVersion === 1 && input.payload.kind === expectedKind && id(input.payload.eventId), "平台事件类型/编号无效");
  return input.payload;
}

function statePath(file) {
  file = path.resolve(file);
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) { current = path.join(current, part); try { assert(!lstatSync(current).isSymbolicLink(), "台账路径不能含符号链接"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return file;
}

function identity(config) {
  const { publicKeyFile, ...settings } = config;
  const key = createPublicKey(readFileSync(publicKeyFile));
  assert(key.asymmetricKeyType === "ed25519", "平台公钥不是 Ed25519");
  return sha256(stableStringify({ settings, publicKey: key.export({ type: "spki", format: "der" }).toString("base64") }));
}

function loadState(file, config) {
  const binding = identity(config);
  const s = existsSync(file) ? read(file) : { schemaVersion: 1, identity: binding, revision: 0, events: {}, scopes: {}, issues: {}, outbox: {}, lifecycles: {}, audit: [] };
  assert(s.identity === binding, "台账配置/公钥身份不一致；禁止隐式更换授权或渠道，先执行受审计的台账迁移");
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  assert(s.schemaVersion === 1 && Number.isInteger(s.revision) && s.revision >= 0 && [s.events, s.scopes, s.issues, s.outbox].every(record) && Array.isArray(s.audit), "台账损坏，拒绝当作空账");
  // Additive migration for existing schema-1 ledgers; a malformed map is never reset.
  if (!Object.hasOwn(s, "lifecycles")) s.lifecycles = {};
  assert(record(s.lifecycles), "台账运行事实损坏");
  for (const [key, fact] of Object.entries(s.lifecycles)) {
    validateLifecycle(fact, config);
    assert(key === lifecycleKey(fact) && Object.hasOwn(s.events, fact.eventId) && s.events[fact.eventId].digest === sha256(stableStringify(fact)), "台账运行事实身份损坏");
  }
  for (const [key, issue] of Object.entries(s.issues)) {
    assert(HASH.test(key) && record(issue) && issue.id === key && id(issue.project) && id(issue.scope) && HASH.test(issue.fingerprint || "") && key === sha256(`${issue.project}:${issue.scope}:${issue.fingerprint}`) && Object.hasOwn(LEVEL, issue.severity) && Number.isSafeInteger(issue.revision) && issue.revision > 0 && ["open", "claimed", "awaitingVerification", "closed"].includes(issue.status) && Array.isArray(issue.escalations), "台账问题记录损坏");
    target(config, issue.project, issue.scope); time(issue.ackDueAt); time(issue.resolveDueAt);
    assert(record(issue.latestEvidence) && SHA.test(issue.latestEvidence.sha || "") && id(issue.owner) && id(issue.backup), "台账问题证据/责任损坏");
    const p = config.projects[issue.project]; assert(issue.owner === p.owner && issue.backup === p.backup && issue.escalationOwner === p.escalationOwner, "台账责任映射损坏");
    link(issue.latestEvidence.reportUrl, config); link(issue.latestEvidence.pipelineUrl, config);
    if (issue.status === "awaitingVerification") { assert(record(issue.pendingEvidence) && SHA.test(issue.pendingEvidence.sha || "") && HASH.test(issue.pendingEvidence.reportHash || ""), "台账待复验证据损坏"); link(issue.pendingEvidence.reportUrl, config); link(issue.pendingEvidence.pipelineUrl, config); }
  }
  for (const [key, item] of Object.entries(s.outbox)) {
    if (item?.deliveryVerification) {
      const v = item.deliveryVerification;
      assert(record(v) && config.operators.includes(v.actorId) && ["accepted-by-provider", "not-received"].includes(v.outcome) && typeof v.reason === "string" && v.reason.trim(), "台账投递核实记录损坏");
      link(v.verificationUrl, config); time(v.at);
    }
    if(item?.subjectType==='check'){
      const snapshot=item.snapshot,e=s.events[snapshot?.eventId],n=snapshot && scopeNotification(config,snapshot.project,snapshot.scope);
      assert(n && snapshot.kind==='quality-check-notification' && snapshot.schemaVersion===1 && key===sha256(`check:${snapshot.eventId}`) && item.id===key && e?.kind==='quality-event' && e.notificationHash===checkSnapshotHash(snapshot),'台账检查消息快照/原始事件损坏');
      assert(e.project===snapshot.project && e.scope===snapshot.scope && e.sha===snapshot.sha && e.reportHash===snapshot.reportHash && e.authorId===snapshot.authorId && snapshot.summary.run.stage==='ci','台账检查消息身份与原件不一致');
      assert(item.channel===scopeChannel(config,snapshot.project,snapshot.scope) && Number.isSafeInteger(item.attempts) && item.attempts>=0 && ['pending','retry','attempting','delivered','dead-letter','superseded'].includes(item.status),'台账检查消息状态或路由损坏');
      link(snapshot.reportUrl,config);link(snapshot.pipelineUrl,config);time(item.nextAttemptAt);
      if(item.status==='attempting'){assert(typeof item.attemptId==='string' && item.attemptId,'检查消息投递身份缺失');time(item.leaseUntil);}
      continue;
    }
    if (item?.subjectType === "lifecycle") {
      assert(HASH.test(key) && record(item) && item.id === key && HASH.test(item.streamId || "") && Object.hasOwn(s.lifecycles, item.streamId) && record(item.snapshot), "台账运行消息身份损坏");
      const fact = item.snapshot; validateLifecycle(fact, config);
      assert(item.streamId === lifecycleKey(fact) && key === sha256(`lifecycle:${fact.eventId}`) && Object.hasOwn(s.events, fact.eventId) && s.events[fact.eventId].digest === sha256(stableStringify(fact)) && fact.sequence <= s.lifecycles[item.streamId].sequence, "台账运行消息快照损坏");
      assert(item.channel === scopeChannel(config,fact.project,fact.scope) && Number.isSafeInteger(item.attempts) && item.attempts >= 0 && ["pending", "retry", "attempting", "delivered", "dead-letter", "superseded"].includes(item.status), "台账运行消息状态/路由损坏");
      time(item.nextAttemptAt); if (item.status === "attempting") { assert(typeof item.attemptId === "string" && item.attemptId, "台账投递身份损坏"); time(item.leaseUntil); }
      continue;
    }
    assert(HASH.test(key) && record(item) && item.id === key && HASH.test(item.issueId) && Object.hasOwn(s.issues, item.issueId) && Number.isSafeInteger(item.issueRevision) && item.issueRevision > 0 && record(item.snapshot) && item.snapshot.id === item.issueId && item.snapshot.revision === item.issueRevision && Number.isSafeInteger(item.attempts) && item.attempts >= 0 && Object.hasOwn(config.channels, item.channel) && ["pending", "digest", "retry", "attempting", "delivered", "dead-letter", "superseded"].includes(item.status), "台账消息记录损坏");
    time(item.nextAttemptAt); if (item.status === "attempting") { assert(typeof item.attemptId === "string" && item.attemptId, "台账投递身份损坏"); time(item.leaseUntil); }
    const issue = s.issues[item.issueId], snapshot = item.snapshot;
    assert(item.issueRevision <= issue.revision && typeof item.kind === "string" && key === sha256(`${item.issueId}:${item.issueRevision}:${item.kind}`) && snapshot.project === issue.project && snapshot.scope === issue.scope && snapshot.fingerprint === issue.fingerprint && snapshot.owner === issue.owner && snapshot.backup === issue.backup && item.channel === scopeChannel(config,issue.project,issue.scope) && Object.hasOwn(LEVEL, snapshot.severity), "台账消息快照/路由损坏");
    assert(record(snapshot.latestEvidence) && SHA.test(snapshot.latestEvidence.sha || ""), "台账消息证据损坏"); link(snapshot.latestEvidence.reportUrl, config); link(snapshot.latestEvidence.pipelineUrl, config);
    assert(["open", "claimed", "awaitingVerification", "closed"].includes(snapshot.status) && snapshot.escalationOwner === issue.escalationOwner, "台账快照状态/升级责任损坏"); time(snapshot.resolveDueAt);
    if (snapshot.pendingEvidence) { assert(record(snapshot.pendingEvidence) && SHA.test(snapshot.pendingEvidence.sha || "") && HASH.test(snapshot.pendingEvidence.reportHash || ""), "台账快照复验证据损坏"); link(snapshot.pendingEvidence.reportUrl, config); link(snapshot.pendingEvidence.pipelineUrl, config); }
  }
  for (const [key, e] of Object.entries(s.events)) {
    assert(id(key) && record(e) && HASH.test(e.digest || "") && ["quality-event", "issue-action", "pipeline-expectations", "lifecycle-event", "governance-migration"].includes(e.kind), "台账事件记录损坏");
    if (e.kind === "quality-event") { target(config, e.project, e.scope); assert(SHA.test(e.sha || "") && Number.isSafeInteger(e.sequence) && e.sequence > 0 && id(e.pipelineId) && id(e.authorId) && HASH.test(e.reportHash || "") && (e.reportEventId === undefined || id(e.reportEventId)), "台账质量事件身份损坏"); }
  }
  for (const [key, scope] of Object.entries(s.scopes)) assert(record(scope) && Number.isSafeInteger(scope.sequence) && scope.sequence > 0 && SHA.test(scope.sha || "") && id(scope.eventId) && Object.hasOwn(s.events, scope.eventId) && key === `${s.events[scope.eventId].project}:${s.events[scope.eventId].scope}` && scope.sha === s.events[scope.eventId].sha && scope.sequence === s.events[scope.eventId].sequence, "台账范围记录损坏");
  return s;
}

function transaction(file, config, fn) {
  file = statePath(file); mkdirSync(path.dirname(file), { recursive: true });
  let release; try { release = acquireControlledLock(`${file}.lock`, file); } catch (error) { throw new Error(`台账写入锁：${error.message}`); }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { const state = loadState(file, config); const result = fn(state); state.revision++; writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, file); return result; }
  finally { rmSync(temporary, { force: true }); release(); }
}

export function readGovernanceState({ configFile, stateFile }) {
  return structuredClone(loadState(statePath(stateFile), loadGovernanceConfig(configFile)));
}

// A migration is a separately authenticated, exact-config action. Existing
// signatures, routing and operator/reviewer authority cannot change here.
export function migrateGovernanceConfig({ configFile, newConfigFile, stateFile, authorizationFile, now = Date.now() }) {
  const previous = loadGovernanceConfig(configFile), next = loadGovernanceConfig(newConfigFile);
  const authorization = receipt(authorizationFile, previous, now, "governance-migration");
  assert(previous.operators.includes(authorization.actorId) && typeof authorization.reason === "string" && authorization.reason.trim(), "台账迁移需要认证运维明确授权和原因");
  assert(authorization.oldConfigHash === identity(previous) && authorization.newConfigHash === identity(next), "迁移授权配置摘要不匹配");
  const withoutClosure = (config) => { const copy = structuredClone(config); delete copy.publicKeyFile; for (const p of Object.values(copy.projects)) for (const s of Object.values(p.scopes)) delete s.closurePolicy; return copy; };
  assert(stableStringify(withoutClosure(previous)) === stableStringify(withoutClosure(next)) && createPublicKey(readFileSync(previous.publicKeyFile)).export({ type: "spki", format: "der" }).equals(createPublicKey(readFileSync(next.publicKeyFile)).export({ type: "spki", format: "der" })), "本迁移只允许收紧关闭策略，不能更换公钥、权限、渠道或批准检查");
  for (const [project, p] of Object.entries(previous.projects)) for (const [scope, s] of Object.entries(p.scopes)) {
    const old = s.closurePolicy, updated = next.projects[project].scopes[scope].closurePolicy;
    assert(updated && (!old || old.deploymentLane === updated.deploymentLane && old.requiredEnvironments.every((e) => updated.requiredEnvironments.includes(e))), "迁移不得删除或放宽必要环境/部署通道");
  }
  return transaction(stateFile, previous, (state) => {
    assert(authorization.expectedRevision === state.revision, "台账修订已变化，重新预览迁移");
    assert(acceptEvent(state, authorization), "迁移授权已使用");
    let reopened = 0;
    for (const issue of Object.values(state.issues)) if (issue.status === "closed") {
      issue.status = issue.pendingEvidence ? "awaitingVerification" : "open"; issue.revision++;
      issue.legacyCloseEvidence = issue.closeEvidence; delete issue.closeEvidence; delete issue.closedAt;
      enqueue(state, issue, "policy-reverification", now, next); reopened++;
    }
    state.identity = identity(next);
    state.audit.push({ at: new Date(now).toISOString(), action: "closure-policy-migration", eventId: authorization.eventId, actorId: authorization.actorId, reason: authorization.reason, oldIdentity: authorization.oldConfigHash, newIdentity: authorization.newConfigHash, reopened });
    return { status: "migrated", reopened, identity: state.identity };
  });
}

export function governanceConfigIdentity({ configFile }) { return identity(loadGovernanceConfig(configFile)); }

function target(config, project, scope) {
  assert(id(project) && Object.hasOwn(config.projects, project), "未登记项目"); const p = config.projects[project];
  assert(id(scope) && Object.hasOwn(p.scopes, scope), "未登记检查范围"); return { p, s: p.scopes[scope] };
}

function link(value, config) {
  assert(typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value), "认证链接缺失/过长/含控制字符"); const u = new URL(value);
  assert(u.protocol === "https:" && config.allowedLinkOrigins.includes(u.origin) && !u.username && !u.password && ![...u.searchParams.keys()].some((k) => /token|secret|password|key/i.test(k)), "链接来源/凭据不合法"); return value;
}

function enqueue(state, issue, kind, now, config) {
  if(scopeNotification(config,issue.project,issue.scope) && ['opened','updated','reopened','risk-increased','awaiting-verification'].includes(kind))return;
  const messageId = sha256(`${issue.id}:${issue.revision}:${kind}`);
  if (Object.hasOwn(state.outbox, messageId)) return;
  for (const item of Object.values(state.outbox)) if (item.issueId === issue.id && ["pending", "retry", "digest"].includes(item.status)) item.status = "superseded";
  state.outbox[messageId] = { id: messageId, issueId: issue.id, issueRevision: issue.revision, snapshot: structuredClone(issue), kind, channel: scopeChannel(config,issue.project,issue.scope),
    status: issue.severity === "warning" && kind === "opened" ? "digest" : "pending", createdAt: new Date(now).toISOString(), attempts: 0, nextAttemptAt: new Date(now).toISOString() };
}

function enqueueCheck(state,report,event,now,config){
  const n=scopeNotification(config,event.project,event.scope);if(!n)return;
  const snapshot=checkSnapshot(report,event,n),messageId=sha256(`check:${event.eventId}`);
  state.events[event.eventId].notificationHash=checkSnapshotHash(snapshot);
  for(const item of Object.values(state.outbox))if(item.subjectType==='check' && item.snapshot.project===event.project && item.snapshot.scope===event.scope && ['pending','retry'].includes(item.status))item.status='superseded';
  state.outbox[messageId]={id:messageId,subjectType:'check',snapshot,kind:'check',channel:n.channel,status:'pending',createdAt:new Date(now).toISOString(),nextAttemptAt:new Date(now).toISOString(),attempts:0};
}

function openIssue(state, data, now, config) {
  const issueId = sha256(`${data.project}:${data.scope}:${data.fingerprint}`); let issue = state.issues[issueId];
  const project = config.projects[data.project];
  if (!issue) {
    issue = state.issues[issueId] = { id: issueId, ...data, owner: project.owner, backup: project.backup, escalationOwner: project.escalationOwner,
      status: "open", revision: 1, recurrence: 0, firstSeenAt: new Date(now).toISOString(), openedAt: new Date(now).toISOString(), ackAt: null,
      firstSourceOccurredAt: data.latestEvidence.occurredAt || null, firstReceivedAt: new Date(now).toISOString(),
      ackDueAt: new Date(now + config.sla.ackMinutes * 60000).toISOString(), resolveDueAt: new Date(now + config.sla.resolveMinutes * 60000).toISOString(), escalations: [] };
    enqueue(state, issue, "opened", now, config);
  } else {
    const pending = Object.values(state.outbox).find((x) => x.issueId === issue.id && ["pending", "retry", "digest"].includes(x.status));
    const evidenceChanged = stableStringify(issue.latestEvidence) !== stableStringify(data.latestEvidence);
    const reappeared = ["closed", "awaitingVerification"].includes(issue.status);
    const increased = LEVEL[data.severity] > LEVEL[issue.severity] || data.occurrenceCount > issue.occurrenceCount;
    const oldSeverity = issue.severity;
    Object.assign(issue, data); if (LEVEL[oldSeverity] > LEVEL[data.severity]) issue.severity = oldSeverity;
    if (reappeared || increased) {
      issue.revision++; issue.status = "open"; issue.pendingEvidence = null;
      if (reappeared) { issue.recurrence++; issue.openedAt = new Date(now).toISOString(); issue.ackAt = null; issue.ackDueAt = new Date(now + config.sla.ackMinutes * 60000).toISOString(); issue.resolveDueAt = new Date(now + config.sla.resolveMinutes * 60000).toISOString(); issue.escalations = []; }
      enqueue(state, issue, reappeared ? "reopened" : "risk-increased", now, config);
    } else if (evidenceChanged) {
      issue.revision++;
      if (pending) enqueue(state, issue, pending.kind, now, config);
    }
  }
  issue.lastSeenAt = new Date(now).toISOString(); return issue;
}

function acceptEvent(state, payload) {
  const digest = sha256(stableStringify(payload)); const previous = Object.hasOwn(state.events, payload.eventId) ? state.events[payload.eventId] : null;
  if (previous) { assert(previous.digest === digest, "相同 eventId 内容冲突"); return false; }
  state.events[payload.eventId] = { digest, project: payload.project || null, scope: payload.scope || null, sha: payload.sha || null,
    sequence: payload.sequence ?? null, pipelineId: payload.pipelineId || null, kind: payload.kind, authorId: payload.authorId || null,
    reportHash: payload.reportHash || null, reportEventId: payload.reportEventId || payload.eventId, reportUrl: payload.reportUrl || null, pipelineUrl: payload.pipelineUrl || null }; return true;
}

function lifecycleKey(fact) { return sha256(`${fact.project}:${fact.scope}:${fact.category}:${fact.lane}:${fact.environment || "none"}`); }
export function isCurrentRepairVerification(issue, fact) {
  if (!issue?.pendingEvidence || !fact?.source) return false;
  const timestamps = [issue.openedAt, issue.pendingEvidence.sourceStartedAt || issue.pendingEvidence.receivedAt, ...(issue.pendingEvidence.occurredAt ? [issue.pendingEvidence.occurredAt] : []), fact.occurredAt, fact.source.observedAt].map(Date.parse);
  if (timestamps.some((value) => !Number.isFinite(value))) return false;
  const repairTime = Math.max(...timestamps.slice(0, -2));
  return timestamps.at(-2) >= repairTime && timestamps.at(-1) >= repairTime;
}
function validateLifecycle(fact, config, now) {
  assert(fact?.schemaVersion === 1 && fact.kind === "lifecycle-event" && id(fact.eventId), "运行事实结构/事件编号无效");
  target(config, fact.project, fact.scope);
  const statuses = { collection: ["attention", "recovered"], review: ["draft", "changes-requested", "approved", "rejected", "canceled"], build: ["running", "success", "failed", "canceled", "not-run"], deploy: ["running", "success", "failed", "canceled", "not-run", "verified"] };
  assert(Object.hasOwn(statuses, fact.category) && statuses[fact.category].includes(fact.status) && id(fact.lane), "运行事实分类/状态/执行通道无效");
  if (fact.environment !== undefined) assert(["dev", "sit", "uat", "pre", "prd"].includes(fact.environment), "运行事实环境无效");
  // The collector may be unavailable before it has discovered any candidate.
  // Its own health is a distinct fact; never invent a SHA or a successful job.
  if (fact.category === "collection") {
    assert(Number.isSafeInteger(fact.sequence) && fact.sequence > 0 && id(fact.executionId) && fact.sourceId === fact.lane && id(fact.sourceId), "采集健康事实缺少执行器/来源/顺序身份");
    assert(fact.sha === undefined && fact.authorId === undefined && fact.pipelineId === undefined && fact.jobId === undefined, "采集健康不能冒充候选质量或构建结果");
    assert(fact.source && ["gitlab", "jenkins"].includes(fact.source.system) && id(fact.source.recordId) && HASH.test(fact.source.recordHash || ""), "采集健康缺少真实执行记录摘要");
    assert(Number.isSafeInteger(fact.errorCount) && fact.errorCount >= 0 && Array.isArray(fact.errorStages) && fact.errorStages.every(id) && new Set(fact.errorStages).size === fact.errorStages.length && (fact.status === "attention" ? fact.errorCount > 0 : fact.errorCount === 0), "采集健康异常分类无效");
    link(fact.source.url, config); link(fact.reportUrl, config);
    const occurred = time(fact.occurredAt), observed = time(fact.source.observedAt);
    assert(occurred <= observed + 60000 && time(fact.firstFailureAt) <= occurred, "采集健康发生/观察时间无效");
    if (now !== undefined) assert(observed <= now + 60000 && now - observed <= 86400000, "采集健康来源采集过期或来自未来");
    return;
  }
  assert(SHA.test(fact.sha || "") && Number.isSafeInteger(fact.sequence) && fact.sequence > 0 && id(fact.pipelineId) && id(fact.jobId) && id(fact.authorId), "运行事实SHA/流水线/作业/作者/序号无效");
  assert(fact.source && ["gitlab", "jenkins", "review", "deployment"].includes(fact.source.system) && id(fact.source.recordId) && HASH.test(fact.source.recordHash || ""), "运行事实来源核验摘要缺失");
  assert(fact.category === "review" ? fact.source.system === "review" : fact.category === "deploy" ? ["gitlab", "jenkins", "deployment"].includes(fact.source.system) : ["gitlab", "jenkins"].includes(fact.source.system), "运行事实来源与分类不一致");
  link(fact.source.url, config); link(fact.reportUrl, config); link(fact.pipelineUrl, config);
  const observed = time(fact.source.observedAt), occurred = time(fact.occurredAt);
  assert(occurred <= observed + 60000, "运行发生时间晚于来源采集时间");
  if (now !== undefined) assert(observed <= now + 60000 && now - observed <= 86400000, "运行事实来源采集过期或来自未来");
  if (fact.category === "review") {
    assert(id(fact.reviewId) && HASH.test(fact.reportHash || "") && HASH.test(fact.evidenceHash || ""), "Review事实缺少正文/九维证据摘要");
    if (["approved", "rejected"].includes(fact.status)) assert(id(fact.authorizationId) && id(fact.actorId) && fact.actorId !== fact.authorId && config.projects[fact.project].reviewers.includes(fact.actorId), "正式Review事实必须来自已登记非作者复核人的明确授权");
  }
  if (fact.category === "build" && fact.status === "success") {
    assert(HASH.test(fact.artifactHash || "") && HASH.test(fact.manifestHash || ""), "构建成功缺少真实制品/清单摘要");
    link(fact.artifactUrl, config);
  }
  if (fact.category === "deploy") {
    assert(["dev", "sit", "uat", "pre", "prd"].includes(fact.environment) && id(fact.deploymentId), "部署事实缺少实际环境/部署记录");
    if (!["not-run", "canceled"].includes(fact.status)) assert(HASH.test(fact.artifactHash || "") && HASH.test(fact.manifestHash || "") && id(fact.authorizationId), "部署事实缺少制品/清单/授权关联");
    if (fact.status === "verified") {
      assert(id(fact.actorId) && fact.actorId !== fact.authorId && config.projects[fact.project].reviewers.includes(fact.actorId) && HASH.test(fact.verificationHash || ""), "环境验证事实须关联独立复核人和实际验证证据");
      link(fact.verificationUrl, config);
    }
  }
}

// The source file is the immutable response captured by the trusted API/SSO
// collector. Signature permission belongs only to that collector; a webhook or
// project job must never be allowed to sign its own claimed success.
export function ingestLifecycleGovernance({ configFile, stateFile, eventFile, sourceFile, now = Date.now() }) {
  const config = loadGovernanceConfig(configFile), fact = receipt(eventFile, config, now, "lifecycle-event");
  validateLifecycle(fact, config, now);
  assert(typeof sourceFile === "string" && existsSync(sourceFile) && sha256(readFileSync(sourceFile, "utf8")) === fact.source.recordHash, "运行事实缺少原始来源响应或来源摘要不一致");
  return transaction(stateFile, config, (state) => {
    if (!acceptEvent(state, fact)) return { status: "duplicate", eventId: fact.eventId };
    const streamId = lifecycleKey(fact), previous = state.lifecycles[streamId];
    if (previous && fact.sequence <= previous.sequence) {
      assert(fact.sequence !== previous.sequence, "同一运行通道序号冲突");
      state.audit.push({ at: new Date(now).toISOString(), action: "lifecycle-stale", eventId: fact.eventId, streamId });
      return { status: "stale", eventId: fact.eventId };
    }
    state.lifecycles[streamId] = structuredClone(fact);
    for (const item of Object.values(state.outbox)) if (item.subjectType === "lifecycle" && item.streamId === streamId && ["pending", "retry"].includes(item.status)) item.status = "superseded";
    const messageId = sha256(`lifecycle:${fact.eventId}`);
    state.outbox[messageId] = { id: messageId, subjectType: "lifecycle", streamId, snapshot: structuredClone(fact), kind: `${fact.category}:${fact.status}`, channel: scopeChannel(config,fact.project,fact.scope), status: "pending", createdAt: new Date(now).toISOString(), attempts: 0, nextAttemptAt: new Date(now).toISOString() };
    state.audit.push({ at: new Date(now).toISOString(), action: "lifecycle-ingest", eventId: fact.eventId, streamId, category: fact.category, status: fact.status });
    return { status: "ingested", eventId: fact.eventId, category: fact.category, state: fact.status, issueStatesChanged: false };
  });
}

export function ingestGovernance({ configFile, stateFile, eventFile, summaryFile, now = Date.now() }) {
  const config = loadGovernanceConfig(configFile); const event = receipt(eventFile, config, now, "quality-event");
  const { s } = target(config, event.project, event.scope);
  if (event.occurredAt !== undefined) assert(time(event.occurredAt) <= now + 60000, "平台发生时间来自未来");
  assert(SHA.test(event.sha || "") && Number.isSafeInteger(event.sequence) && event.sequence > 0 && id(event.pipelineId) && id(event.jobId) && id(event.authorId), "事件源码/流水线/作者/顺序无效");
  if (event.reportEventId !== undefined) assert(id(event.reportEventId), "原始报告事件编号无效");
  if(event.ref!==undefined)assert(typeof event.ref==="string" && !!event.ref && event.ref.length<=512 && !/[\u0000-\u001f]/.test(event.ref),"可信CI分支字段无效");
  link(event.reportUrl, config); link(event.pipelineUrl, config);
  assert(event.reportHash === sha256(readFileSync(summaryFile, "utf8")), "事件报告摘要不一致");
  const validation = validateReportFile(summaryFile); assert(validation.ok, `质量报告无效: ${validation.errors.join("; ")}`);
  const report = read(summaryFile);
  const status = report.decision.status;
  if (status === "invalid") {
    assert(event.jobStatus === "failed", "执行失效必须来自平台实际失败作业");
    assert([event.project, "unknown"].includes(report.run.project) && (!report.run.eventId || report.run.eventId === (event.reportEventId || event.eventId)) && (!report.run.commitSha || report.run.commitSha === "unknown" || report.run.commitSha === event.sha), "失效工件与平台项目/SHA/runId 冲突");
    return transaction(stateFile, config, (state) => {
      if (!acceptEvent(state, event)) return { status: "duplicate", eventId: event.eventId };
      const key = `${event.project}:${event.scope}`;
      if (state.scopes[key]?.sequence >= event.sequence) return { status: "stale", eventId: event.eventId };
      state.scopes[key] = { sequence: event.sequence, sha: event.sha, eventId: event.eventId };
      enqueueCheck(state,report,event,now,config);
      const evidence = { sha: event.sha, reportHash: event.reportHash, eventId: event.eventId, pipelineId: event.pipelineId, jobId: event.jobId, authorId: event.authorId, reportUrl: event.reportUrl, pipelineUrl: event.pipelineUrl, policyHash: s.policyHash, rulesHash: s.rulesHash,
        stage:"ci",trace:event.ref?{targetBranch:event.ref,source:"trusted-central-ci",identityVerified:true}:null,riskCounts:{blocker:0,error:1,warning:0,info:0},
        occurredAt: event.occurredAt || null, receivedAt: new Date(now).toISOString(), sourceStartedAt: report.run.startedAt, receiveDelayMs: event.occurredAt ? Math.max(0, now - time(event.occurredAt)) : null };
      openIssue(state, { project: event.project, scope: event.scope, fingerprint: sha256("GOV/CHECK-INVALID"), ruleId: "GOV/CHECK-INVALID", severity: "error", file: "quality/policy", line: null, occurrenceCount: 1, latestEvidence: evidence, category: "execution" }, now, config);
      state.audit.push({ at: new Date(now).toISOString(), action: "ingest-invalid", eventId: event.eventId });
      return { status: "ingested", eventId: event.eventId, issues: 1, decision: "invalid" };
    });
  }
  assert(report.run.project === event.project && report.run.commitSha === event.sha && report.run.eventId === (event.reportEventId || event.eventId), "事件与项目/SHA/runId 不一致");
  assert(["standard", "release"].includes(report.run.profile) && !report.run.scope && !report.run.base, "台账正式摄入要求完整 standard/release");
  assert(event.jobStatus === (status === "passed" ? "success" : "failed"), "平台实际作业状态与质量判定不一致");
  for (const [a, b] of [["policyHash", "policyHash"], ["rulesHash", "ruleSetHash"], ["baselineHash", "baselineHash"], ["waiversHash", "waiversHash"]]) assert(report.policy[b] === s[a], "报告不是当前批准策略/规则/基线/例外");
  assert(stableStringify([...report.policy.requiredCheckIds].sort()) === stableStringify([...s.requiredChecks].sort()), "批准必需检查范围不一致");
  const actualRequired = report.checks.filter((c) => c.required !== false);
  assert(new Set(actualRequired.map((c) => c.checkId)).size === actualRequired.length && stableStringify(actualRequired.map((c) => c.checkId).sort()) === stableStringify([...s.requiredChecks].sort()), "报告实际必需检查缺失/重复");
  if (status === "passed") assert(report.counts.blockingNew === 0 && !report.findings.some((f) => ["new", "expired"].includes(f.status) && (LEVEL[f.severity] >= 2 || (report.policy.enforceWarnings && f.severity === "warning"))), "passed 与阻断发现矛盾");
  if (status === "passed") {
    const errors = validatePassingSummary(report, { sha: event.sha, project: event.project, profile: report.run.profile, env: report.run.targetEnv, expectPolicyHash: s.policyHash, expectRulesHash: s.rulesHash, expectBaselineHash: s.baselineHash, expectWaiversHash: s.waiversHash });
    assert(!errors.length, `通过报告独立验收失败: ${errors.join("; ")}`);
  }
  if (status !== "invalid") assert(report.run.sourceBound === true && report.checks.filter((c) => c.required !== false).every((c) => c.status === "ok" && c.toolVersionVerified), "正式发现缺少真实源码/工具执行绑定");
  return transaction(stateFile, config, (state) => {
    if (!acceptEvent(state, event)) return { status: "duplicate", eventId: event.eventId };
    const scopeKey = `${event.project}:${event.scope}`;
    if (state.scopes[scopeKey]?.sequence >= event.sequence) { state.audit.push({ at: new Date(now).toISOString(), action: "stale-event", eventId: event.eventId }); return { status: "stale", eventId: event.eventId }; }
    state.scopes[scopeKey] = { sequence: event.sequence, sha: event.sha, eventId: event.eventId };
    enqueueCheck(state,report,event,now,config);
    const evidence = { sha: event.sha, reportHash: event.reportHash, eventId: event.eventId, pipelineId: event.pipelineId, jobId: event.jobId, authorId: event.authorId, reportUrl: event.reportUrl, pipelineUrl: event.pipelineUrl,
      riskCounts:Object.fromEntries(Object.keys(LEVEL).map(level=>[level,report.findings.filter(f=>f.severity===level).length])),
      stage:"ci",trace:report.run.trace || event.ref ? {...(report.run.trace || {}), ...(event.ref?{targetBranch:event.ref,ciRef:event.ref,targetBranchSource:"trusted-central-ci"}:{}), commits:(report.run.trace?.commits || []).slice(0,1).map(({message,...commit})=>commit), fullTraceInReport:true} : null,
      policyHash: report.policy.policyHash, rulesHash: report.policy.ruleSetHash, occurredAt: event.occurredAt || null, receivedAt: new Date(now).toISOString(), sourceStartedAt: report.run.startedAt, receiveDelayMs: event.occurredAt ? Math.max(0, now - time(event.occurredAt)) : null };
    const seen = new Set();
    for (const f of report.findings.filter((f) => LEVEL[f.severity] >= 1 && f.status !== "waived")) {
      assert(HASH.test(f.fingerprint), "发现缺少指纹");
      const issue = openIssue(state, { project: event.project, scope: event.scope, fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity,
        file: f.file, line: f.line, occurrenceCount: f.occurrences?.length || 1, latestEvidence: evidence, category: "code" }, now, config); seen.add(issue.id);
    }
    if (status === "invalid") {
      const issue = openIssue(state, { project: event.project, scope: event.scope, fingerprint: sha256("GOV/CHECK-INVALID"), ruleId: "GOV/CHECK-INVALID", severity: "error",
        file: "quality/policy", line: null, occurrenceCount: 1, latestEvidence: evidence, category: "execution" }, now, config); seen.add(issue.id);
    }
    // Only a valid full passed scan of this approved scope can mark absence.
    if (status === "passed") for (const issue of Object.values(state.issues)) {
      if (issue.project !== event.project || issue.scope !== event.scope || seen.has(issue.id) || issue.status === "closed" || issue.category === "missing") continue;
      if (issue.latestEvidence.policyHash !== evidence.policyHash || issue.latestEvidence.rulesHash !== evidence.rulesHash) continue;
      if (issue.status === "awaitingVerification") { issue.pendingEvidence = evidence; issue.revision++; enqueue(state, issue, "awaiting-verification", now, config); continue; }
      issue.status = "awaitingVerification"; issue.pendingEvidence = evidence; issue.revision++; enqueue(state, issue, "awaiting-verification", now, config);
    }
    state.audit.push({ at: new Date(now).toISOString(), action: "ingest", eventId: event.eventId, status });
    return { status: "ingested", eventId: event.eventId, issues: seen.size, decision: status };
  });
}

export function actionGovernance({ configFile, stateFile, actionFile, now = Date.now() }) {
  const config = loadGovernanceConfig(configFile); const action = receipt(actionFile, config, now, "issue-action");
  assert(id(action.actorId) && ["claim", "close", "retry-delivery", "resolve-delivery"].includes(action.action), "动作/平台认证人员无效");
  return transaction(stateFile, config, (state) => {
    if (!acceptEvent(state, action)) return { status: "duplicate", eventId: action.eventId };
    if (action.action === "resolve-delivery") {
      assert(config.operators.includes(action.actorId) && typeof action.reason === "string" && action.reason.trim(), "投递核实需渠道运维授权和实际查询原因");
      const item = state.outbox[action.messageId]; assert(item?.status === "attempting", "消息没有未知投递结果");
      assert(typeof action.expectedAttemptId === "string" && action.expectedAttemptId === item.attemptId, "投递核实对象已过期");
      assert(item.completedAt || now > time(item.leaseUntil), "消息仍在有效投递租约中，禁止提前裁决");
      assert(["accepted-by-provider", "not-received"].includes(action.outcome), "投递核实必须有明确服务端查询结论");
      link(action.verificationUrl, config);
      item.status = action.outcome === "accepted-by-provider" ? "delivered" : currentMessage(item, state) ? "pending" : "superseded";
      item.lastResult = `operator-verified:${action.outcome}`; item.completedAt = new Date(now).toISOString();
      item.deliveryVerification = { actorId: action.actorId, outcome: action.outcome, reason: action.reason, verificationUrl: action.verificationUrl, at: new Date(now).toISOString() };
      if (item.status === "delivered") item.deliveredAt = new Date(now).toISOString();
      if (item.status === "pending") { item.attempts = 0; item.nextAttemptAt = new Date(now).toISOString(); }
    } else if (action.action === "retry-delivery") {
      assert(config.operators.includes(action.actorId) && typeof action.reason === "string" && action.reason.trim(), "投递重试需渠道运维授权和核实原因");
      const item = state.outbox[action.messageId]; assert(item && ["dead-letter", "attempting", "retry"].includes(item.status), "消息没有可重试状态");
      assert(typeof action.expectedAttemptId === "string" && action.expectedAttemptId === item.attemptId, "投递重试卡片已过期");
      assert(item.status !== "attempting" || item.completedAt || now > time(item.leaseUntil), "消息仍在有效投递租约中，禁止并发重试");
      assert(currentMessage(item, state), "消息已被新版问题/运行事实替代，禁止重发旧卡片");
      item.status = "pending"; item.attempts = 0; item.nextAttemptAt = new Date(now).toISOString();
    } else {
      const issue = state.issues[action.issueId]; assert(issue, "问题不存在"); const project = config.projects[issue.project];
      assert(Number.isSafeInteger(action.expectedRevision) && action.expectedRevision === issue.revision, "问题状态已变更，旧动作/卡片拒绝");
      if (action.action === "claim") {
        assert([issue.owner, issue.backup].includes(action.actorId) && issue.status === "open", "只有主备可认领未关闭问题");
        issue.ackAt = new Date(now).toISOString(); issue.assignee = action.actorId; issue.status = "claimed";
      } else {
        assert(project.reviewers.includes(action.actorId) && action.actorId !== issue.assignee && action.actorId !== issue.pendingEvidence?.authorId && issue.status === "awaitingVerification", "独立非作者复核人只能关闭待复验问题");
        assert(action.sha === issue.pendingEvidence.sha && action.reportHash === issue.pendingEvidence.reportHash, "关闭依据不是当前修复复验版本");
        assert(action.result === "passed" && ["dev", "sit", "uat", "pre", "prd"].includes(action.environment) && typeof action.reason === "string" && action.reason.trim(), "缺少实际复验通过/环境/复核说明");
        link(action.verificationUrl, config);
        const closure = project.scopes[issue.scope].closurePolicy;
        assert(closure, "当前范围未批准必要环境关闭策略；先授权迁移，禁止默认放宽");
        assert(Array.isArray(action.verificationEventIds) && action.verificationEventIds.length === closure.requiredEnvironments.length && new Set(action.verificationEventIds).size === action.verificationEventIds.length, "关闭必须逐必要环境绑定当前部署验证事实");
        const verified = closure.requiredEnvironments.map((environment) => {
          const fact = Object.values(state.lifecycles).find((x) => x.project === issue.project && x.scope === issue.scope && x.category === "deploy" && x.lane === closure.deploymentLane && x.environment === environment);
          assert(fact && fact.status === "verified" && action.verificationEventIds.includes(fact.eventId), `必要环境 ${environment} 缺少最新有效部署验证，旧成功不能覆盖新失败`);
          assert(fact.sha === action.sha && fact.actorId === action.actorId && fact.actorId !== issue.pendingEvidence.authorId && HASH.test(fact.releaseSetHash || "") && HASH.test(fact.executionHash || "") && HASH.test(fact.verificationHash || "") && HASH.test(fact.artifactHash || "") && HASH.test(fact.manifestHash || "") && id(fact.deploymentId) && id(fact.authorizationId), "关闭事实缺少当前候选/组合制品/部署/独立验证关联");
          assert(isCurrentRepairVerification(issue, fact), "部署验证早于本轮当前修复证据；旧环境验证不能重复关闭复发问题");
          assert(action.verificationUrl === fact.verificationUrl || closure.requiredEnvironments.length > 1, "关闭验证链接不是已采集实际验证证据");
          return { eventId: fact.eventId, environment, deploymentId: fact.deploymentId, releaseSetHash: fact.releaseSetHash, executionHash: fact.executionHash, verificationHash: fact.verificationHash, artifactHash: fact.artifactHash, manifestHash: fact.manifestHash, verificationUrl: fact.verificationUrl };
        });
        assert(closure.requiredEnvironments.includes(action.environment), "关闭环境不是批准的必要环境");
        issue.status = "closed"; issue.closedAt = new Date(now).toISOString(); issue.closeEvidence = { actorId: action.actorId, sha: action.sha, reportHash: action.reportHash, environment: action.environment, verificationUrl: action.verificationUrl, verified };
      }
      issue.revision++; enqueue(state, issue, action.action, now, config);
    }
    state.audit.push({ at: new Date(now).toISOString(), action: action.action, actorId: action.actorId, issueId: action.issueId || null, messageId: action.messageId || null, eventId: action.eventId, reason: action.reason || null, outcome: action.outcome || null });
    return { status: "applied", action: action.action, eventId: action.eventId };
  });
}

export function reconcileGovernance({ configFile, stateFile, expectationsFile, now = Date.now() }) {
  const config = loadGovernanceConfig(configFile); const payload = receipt(expectationsFile, config, now, "pipeline-expectations");
  assert(Array.isArray(payload.expectedRuns), "缺少平台查询的 expectedRuns");
  for (const e of payload.expectedRuns) { target(config, e.project, e.scope); assert(SHA.test(e.sha || "") && Number.isSafeInteger(e.sequence) && e.sequence > 0 && id(e.pipelineId), "预期运行身份无效"); time(e.dueAt); link(e.pipelineUrl, config); }
  assert(new Set(payload.expectedRuns.map((e) => `${e.project}:${e.scope}:${e.sha}:${e.pipelineId}:${e.sequence}`)).size === payload.expectedRuns.length, "预期运行重复");
  return transaction(stateFile, config, (state) => {
    if (!acceptEvent(state, payload)) return { status: "duplicate", eventId: payload.eventId };
    let missing = 0, escalated = 0;
    for (const e of payload.expectedRuns) {
      const executed = Object.values(state.events).filter((x) => x.kind === "quality-event" && x.project === e.project && x.scope === e.scope && x.sha === e.sha && x.sequence >= e.sequence && x.pipelineId === e.pipelineId).sort((a, b) => b.sequence - a.sequence)[0];
      const fingerprint = sha256(`GOV/NOT-RUN:${e.sha}:${e.pipelineId}:${e.sequence}`);
      const issueId = sha256(`${e.project}:${e.scope}:${fingerprint}`);
      if (executed) {
        const issue = state.issues[issueId];
        if (issue && issue.status !== "closed" && (issue.status !== "awaitingVerification" || issue.pendingEvidence?.reportHash !== executed.reportHash || !issue.pendingEvidence?.receivedAt)) {
          issue.status = "awaitingVerification"; issue.pendingEvidence = { sha: e.sha, reportHash: executed.reportHash, authorId: executed.authorId, eventId: payload.eventId, reportUrl: executed.reportUrl, pipelineUrl: e.pipelineUrl, receivedAt: new Date(now).toISOString() };
          issue.revision++; enqueue(state, issue, "awaiting-verification", now, config);
        }
      } else if (now >= time(e.dueAt)) { missing++; openIssue(state, { project: e.project, scope: e.scope, fingerprint, ruleId: "GOV/NOT-RUN", severity: "error", file: "pipeline", line: null, occurrenceCount: 1, latestEvidence: { sha: e.sha, reportUrl: e.pipelineUrl, pipelineUrl: e.pipelineUrl }, category: "missing" }, now, config); }
    }
    for (const issue of Object.values(state.issues)) {
      if (issue.status === "closed") continue;
      const reasons = []; if (!issue.ackAt && now >= time(issue.ackDueAt)) reasons.push("unclaimed"); if (now >= time(issue.resolveDueAt)) reasons.push("overdue");
      for (const reason of reasons) {
        const start = time(reason === "unclaimed" ? issue.ackDueAt : issue.resolveDueAt); const key = `${reason}:${Math.floor((now - start) / (config.sla.escalationMinutes * 60000))}`;
        if (issue.escalations.includes(key)) continue; issue.escalations.push(key); issue.revision++; enqueue(state, issue, reason, now, config); escalated++;
      }
    }
    state.audit.push({ at: new Date(now).toISOString(), action: "reconcile", eventId: payload.eventId, missing, escalated }); return { status: "reconciled", missing, escalated };
  });
}

function currentMessage(item, state) { return item.subjectType === 'check' ? item.snapshot.eventId===state.scopes[`${item.snapshot.project}:${item.snapshot.scope}`]?.eventId : item.subjectType === "lifecycle" ? item.snapshot.eventId === state.lifecycles[item.streamId]?.eventId : item.issueRevision === state.issues[item.issueId]?.revision; }

function groups(state, includeDigest, now) {
  const selected = Object.values(state.outbox).filter((x) => currentMessage(x, state) && (["pending", "retry"].includes(x.status) || (includeDigest && x.status === "digest")) && time(x.nextAttemptAt) <= now);
  const result = [], digests = new Map();
  for (const item of selected) { if (item.status !== "digest") result.push([item]); else { const issue=state.issues[item.issueId],key = `${item.channel}:${issue.project}:${issue.scope}`; const list = digests.get(key) || []; list.push(item); digests.set(key, list); } }
  return [...result, ...[...digests.values()].flatMap((x) => Array.from({ length: Math.ceil(x.length / 100) }, (_, n) => x.slice(n * 100, n * 100 + 100)))];
}

export function outboxGovernance({ configFile, stateFile, includeDigest = false, now = Date.now() }) {
  const config = loadGovernanceConfig(configFile), state = loadState(statePath(stateFile), config);
  return { schemaVersion: 1, kind: "notification-preview", networkExecuted: false,
    messages: groups(state, includeDigest, now).map((items) => {
      const message = items[0].subjectType==='check'?centralCheckNotification(items[0].snapshot,config):items[0].subjectType === "lifecycle" ? lifecycleNotification(items[0].snapshot, config) : issueNotification(items, config);
      return { ids: items.map((x) => x.id), channel: items[0].channel, ...message };
    }),
    unknownDeliveries: Object.values(state.outbox).filter((x) => x.status === "attempting").map((x) => x.id),
    deadLetters: Object.values(state.outbox).filter((x) => x.status === "dead-letter").map((x) => x.id) };
}

function webhook(channel, env) {
  const raw = env[channel.webhookEnv]; assert(raw, "缺少消息渠道凭据环境变量"); const u = new URL(raw);
  const valid = channel.type === "feishu" ? u.hostname === "open.feishu.cn" && /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(u.pathname) && !u.search :
    u.hostname === "qyapi.weixin.qq.com" && u.pathname === "/cgi-bin/webhook/send" && /^[A-Za-z0-9_-]+$/.test(u.searchParams.get("key") || "") && [...u.searchParams.keys()].length === 1 && u.searchParams.has("key");
  assert(valid && u.protocol === "https:" && !u.port && !u.username && !u.password && !u.hash, "消息 webhook 不属于批准的官方端点"); return raw;
}

export async function dispatchGovernance({ configFile, stateFile, includeDigest = false, send = false, now = Date.now(), env = process.env, fetchImpl = globalThis.fetch, clock = () => performance.now() }) {
  if (!send) return outboxGovernance({ configFile, stateFile, includeDigest, now });
  const config = loadGovernanceConfig(configFile); const preview = outboxGovernance({ configFile, stateFile, includeDigest, now });
  const wallStarted = clock(), currentTime = () => now + Math.max(0, Math.floor(clock() - wallStarted));
  const results = [];
  for (const group of preview.messages) {
    const attemptId = randomUUID(), groupNow = currentTime();
    let configurationError = false;
    try {
      const c = config.channels[group.channel]; webhook(c, env);
      if (c.type === "feishu") { assert(env[c.signingSecretEnv], "缺少飞书签名密钥"); assert(Buffer.byteLength(JSON.stringify(group.payload), "utf8") <= 20000, "飞书卡片超出字节预算"); }
      else assert(Buffer.byteLength(group.text, "utf8") <= 1800, "消息超出公共字节预算");
    } catch { configurationError = true; }
    const acquired = transaction(stateFile, config, (state) => {
      const available = group.ids.every((x) => state.outbox[x] && currentMessage(state.outbox[x], state) && ["pending", "retry", "digest"].includes(state.outbox[x].status) && time(state.outbox[x].nextAttemptAt) <= groupNow);
      if (!available) return false;
      for (const key of group.ids) { const item = state.outbox[key]; item.status = "attempting"; item.attemptId = attemptId; item.attemptedAt = new Date(groupNow).toISOString(); item.leaseUntil = new Date(groupNow + config.delivery.timeoutMs + 60000).toISOString(); item.completedAt = null; item.attempts++; }
      return true;
    });
    if (!acquired) continue;
    const channel = config.channels[group.channel]; let ok = false, failure = configurationError ? "configuration-error" : "delivery-error";
    let networkExecuted = false;
    try {
      if (configurationError) throw new Error("channel-preflight-failed");
      const body = channel.type === "feishu" ? structuredClone(group.payload) : { msgtype: "text", text: { content: group.text } };
      if (channel.type === "feishu") { body.timestamp = String(Math.floor(groupNow / 1000)); body.sign = createHmac("sha256", `${body.timestamp}\n${env[channel.signingSecretEnv]}`).update("").digest("base64"); }
      networkExecuted = true;
      const response = await fetchImpl(webhook(channel, env), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(config.delivery.timeoutMs) });
      if (!response.ok) failure = "http-rejected";
      else { const result = await response.json(); assert(result && typeof result === "object" && !Array.isArray(result), "消息服务响应无效"); ok = channel.type === "feishu" ?
        (Object.hasOwn(result, "code") || Object.hasOwn(result, "StatusCode")) && (!Object.hasOwn(result, "code") || result.code === 0) && (!Object.hasOwn(result, "StatusCode") || result.StatusCode === 0) : result.errcode === 0;
        if (!ok) failure = "provider-rejected"; }
    } catch { if (!configurationError) failure = "transport-unknown"; }
    const completedNow = currentTime();
    transaction(stateFile, config, (state) => {
      for (const key of group.ids) {
        const item = state.outbox[key]; assert(item.status === "attempting" && item.attemptId === attemptId, "投递状态发生并发变化");
        item.status = ok ? "delivered" : failure === "transport-unknown" ? "attempting" : item.attempts >= config.delivery.maxAttempts ? "dead-letter" : "retry";
        item.lastResult = ok ? "accepted-by-provider" : failure;
        item.completedAt = new Date(completedNow).toISOString();
        if (ok) item.deliveredAt = new Date(completedNow).toISOString();
        else if (item.status === "retry") item.nextAttemptAt = new Date(completedNow + config.delivery.retrySeconds * 1000 * 2 ** (item.attempts - 1)).toISOString();
      }
      state.audit.push({ at: new Date(completedNow).toISOString(), action: "dispatch", attemptId, messageIds: group.ids, result: ok ? "accepted-by-provider" : failure });
    });
    results.push({ ids: group.ids, status: ok ? "delivered" : failure, networkExecuted });
  }
  const remaining = outboxGovernance({ configFile, stateFile, includeDigest, now: currentTime() });
  return { schemaVersion: 1, kind: "notification-dispatch", networkExecuted: results.some((r) => r.networkExecuted), results,
    unknownDeliveries: remaining.unknownDeliveries, deadLetters: remaining.deadLetters };
}
