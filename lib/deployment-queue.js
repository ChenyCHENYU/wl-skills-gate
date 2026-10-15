import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { controlledPath, releaseDigest } from "./release-set.js";
import { loadDeploymentConfig } from "./deployment.js";
import { verifyRecord, validateTime } from "./evidence.js";
import { stableStringify } from "./util.js";

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !["__proto__", "prototype", "constructor"].includes(value);
const hash = (value) => releaseDigest(value);
const jsonHash = (value) => hash(stableStringify(value));
function readJson(file) { file = controlledPath(file); assert(lstatSync(file).isFile() && lstatSync(file).size <= 1024 * 1024, "部署队列/授权文件必须为不超过1MiB的普通文件"); return JSON.parse(readFileSync(file, "utf8")); }

// The executor writes a request only. The authenticated service owns catalog
// registration and human authorization; this process has no identity key.
export function queueDeploymentPlan({ requestsDir, planId, configId, planFile, releaseSetFile }) {
  assert(id(planId) && id(configId), "部署队列计划/配置编号无效");
  requestsDir = controlledPath(requestsDir); assert(path.basename(requestsDir) === "deployment-requests", "部署请求必须写入中央固定deployment-requests目录");
  const controlRoot = path.dirname(requestsDir); planFile = controlledPath(planFile); releaseSetFile = controlledPath(releaseSetFile);
  const relative = path.relative(controlRoot, planFile);
  assert(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), "部署计划必须位于中央control.dataDir内");
  const plan = readJson(planFile), { planHash, ...body } = plan;
  assert(plan.kind === "deployment-plan" && plan.schemaVersion === 1 && planHash === jsonHash(body), "部署请求计划正文与摘要不一致");
  assert(lstatSync(releaseSetFile).isFile(), "部署请求组合文件必须为普通文件");
  const request = { schemaVersion: 1, kind: "deployment-plan-request", planId, configId, planFile, releaseSetFile, planFileHash: hash(readFileSync(planFile)) };
  mkdirSync(requestsDir, { recursive: true, mode: 0o700 });
  const requestFile = controlledPath(path.join(requestsDir, planId + ".json"));
  if (existsSync(requestFile)) { assert(stableStringify(readJson(requestFile)) === stableStringify(request), "同一部署队列编号已经绑定其他计划，拒绝覆盖"); return { status: "queued", requestFile, planId, reused: true }; }
  const temporary = path.join(requestsDir, `.${planId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(request, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // Publishing a completed inode is atomic and never replaces a winner.
    try { linkSync(temporary, requestFile); }
    catch (error) { if (error.code !== "EEXIST") throw error; assert(stableStringify(readJson(requestFile)) === stableStringify(request), "并发部署队列编号冲突"); }
  } finally { rmSync(temporary, { force: true }); }
  return { status: "queued", requestFile, planId, reused: false };
}

export function queueDeploymentDelivery({ deliveryDir, configId, executionFile, releaseSetFile, expectReleaseSetHash }) {
  assert(id(configId) && /^[a-f0-9]{64}$/.test(expectReleaseSetHash || ""), "部署交付配置/组合摘要无效");
  deliveryDir = controlledPath(deliveryDir); assert(path.basename(deliveryDir) === "deployment-deliveries", "部署交付须进入中央固定deployment-deliveries目录");
  executionFile = controlledPath(executionFile); const execution = readJson(executionFile);
  assert(execution.kind === "deployment-execution" && id(execution.executionId) && execution.releaseSetHash === expectReleaseSetHash, "部署交付执行记录与固定组合不符");
  const bytes = readFileSync(controlledPath(releaseSetFile)), releaseSet = JSON.parse(bytes);
  assert(bytes.length <= 24 * 1024 * 1024 && jsonHash(releaseSet) === expectReleaseSetHash, "部署交付组合原件发生变化");
  // Keep the exact selected combination alongside the immutable execution.
  // A later job may update its selected-release pointer before ingestion.
  const archivedRelease = controlledPath(path.join(path.dirname(executionFile), "release-set.delivery.json"));
  if (existsSync(archivedRelease)) assert(hash(readFileSync(archivedRelease)) === hash(bytes), "已有交付组合原件冲突");
  else writeFileSync(archivedRelease, bytes, { flag: "wx", mode: 0o600 });
  const executionFileHash = hash(readFileSync(executionFile)), deliveryId = `delivery-${hash(`${configId}:${executionFileHash}`).slice(0, 48)}`;
  const delivery = { schemaVersion: 1, kind: "deployment-delivery", deliveryId, configId, executionFile, executionFileHash, releaseSetFile: archivedRelease, expectReleaseSetHash };
  mkdirSync(deliveryDir, { recursive: true, mode: 0o700 }); const deliveryFile = controlledPath(path.join(deliveryDir, deliveryId + ".json"));
  if (existsSync(deliveryFile)) { assert(stableStringify(readJson(deliveryFile)) === stableStringify(delivery), "部署交付编号冲突"); return { status: "queued", deliveryId, deliveryFile, reused: true }; }
  const temporary = path.join(deliveryDir, `.${deliveryId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(delivery, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, deliveryFile); } catch (error) { if (error.code !== "EEXIST") throw error; assert(stableStringify(readJson(deliveryFile)) === stableStringify(delivery), "并发部署交付冲突"); }
  } finally { rmSync(temporary, { force: true }); }
  return { status: "queued", deliveryId, deliveryFile, reused: false };
}

export function selectDeploymentAuthorization({ configFile, planFile, authorizationDir, now = Date.now() }) {
  const config = loadDeploymentConfig(configFile), plan = readJson(planFile), { planHash, ...body } = plan;
  assert(plan.kind === "deployment-plan" && plan.schemaVersion === 1 && planHash === jsonHash(body) && plan.configHash === jsonHash(config) && plan.environment === config.environment && plan.lane === config.lane && ["deploy", "smoke", "recover"].includes(plan.action), "待执行部署计划/config/环境摘要不一致");
  validateTime(plan.createdAt, { now: new Date(now), maxAgeMinutes: 60 });
  authorizationDir = controlledPath(authorizationDir);
  if (!existsSync(authorizationDir)) return { status: "pending", planHash, rejected: 0 };
  assert(lstatSync(authorizationDir).isDirectory(), "部署授权目录不是普通目录");
  let rejected = 0; const accepted = [];
  for (const entry of readdirSync(authorizationDir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    try {
      assert(entry.isFile() && !entry.isSymbolicLink(), "授权文件不是普通文件");
      const authorizationFile = controlledPath(path.join(authorizationDir, entry.name)), authorization = readJson(authorizationFile);
      if (authorization.kind !== "deployment-authorization" || authorization.planHash !== planHash) continue;
      verifyRecord(authorization, config.authorizationPublicKeyFile);
      assert(authorization.schemaVersion === 1 && id(authorization.authorizationId) && authorization.issuer === config.authorizationIssuer && authorization.scope === "deployment-execute" && authorization.decision === "approved" && authorization.action === plan.action && authorization.releaseSetHash === plan.releaseSetHash && authorization.environment === plan.environment && authorization.stateHash === plan.stateHash && typeof authorization.reason === "string" && authorization.reason.trim(), "部署授权与固定计划/状态不匹配");
      validateTime(authorization.createdAt, { now: new Date(now), maxAgeMinutes: 60 });
      const expires = Date.parse(authorization.expiresAt); assert(Number.isFinite(expires) && expires > now && expires <= Date.parse(authorization.createdAt) + 3600000, "部署授权过期或有效期过长");
      assert((plan.action === "smoke" ? config.verifiers : config.operators).includes(authorization.actorId), "部署授权人无当前动作权限");
      accepted.push({ authorizationFile, authorizationId: authorization.authorizationId, createdAt: authorization.createdAt });
    } catch { rejected++; }
  }
  accepted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.authorizationId.localeCompare(b.authorizationId));
  return accepted.length ? { status: "authorized", planHash, ...accepted[0], rejected } : { status: "pending", planHash, rejected };
}

export async function waitForDeploymentAuthorization({ timeoutMs = 900000, pollIntervalMs = 1000, clock = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal, ...options }) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900000 && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 100 && pollIntervalMs <= 10000, "部署授权等待预算无效（最长15分钟）");
  const started = clock();
  while (true) {
    if (signal?.aborted) return { status: "canceled", executed: false, exitCode: 2 };
    const now = clock(), selected = selectDeploymentAuthorization({ ...options, now });
    if (selected.status === "authorized") return selected;
    const elapsed = now - started; assert(Number.isFinite(elapsed) && elapsed >= 0, "授权等待时钟异常");
    if (elapsed >= timeoutMs) return { status: "timed-out", planHash: selected.planHash, executed: false, exitCode: 2 };
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
  }
}
