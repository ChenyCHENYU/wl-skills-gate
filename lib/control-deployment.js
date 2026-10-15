import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { loadDeploymentConfig, planDeployment } from "./deployment.js";
import { signRecord, validateTime } from "./evidence.js";
import { stableStringify } from "./util.js";
import { controlledPath, readControlledJson, lockedJson, writeExclusiveJson } from "./control-store.js";
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (v) => createHash("sha256").update(v).digest("hex");
const id = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export function inspectControlDeployment(c, entry, now = Date.now()) {
  assert(c.deploymentConfigs && Object.hasOwn(c.deploymentConfigs, entry.configId), "部署通道未登记");
  const configFile = c.deploymentConfigs[entry.configId], config = loadDeploymentConfig(configFile);
  const allowed = path.relative(c.dataDir, controlledPath(entry.planFile)); assert(allowed && allowed !== ".." && !allowed.startsWith(".." + path.sep) && !path.isAbsolute(allowed), "部署计划必须来自中央证据目录");
  assert(hash(readFileSync(entry.planFile)) === entry.planFileHash, "部署计划已变化，旧入口失效");
  const plan = readControlledJson(entry.planFile), { planHash, ...planBody } = plan;
  assert(hash(stableStringify(planBody)) === planHash, "部署计划正文与确认摘要不一致");
  validateTime(plan.createdAt, { now: new Date(now), maxAgeMinutes: 60 });
  const fresh = planDeployment({ configFile, releaseSetFile: entry.releaseSetFile, expectReleaseSetHash: plan.releaseSetHash, stateFile: config.stateFile, action: plan.action, now: new Date(plan.createdAt) });
  const { executed, ...freshPlan } = fresh;
  assert(fresh.planHash === plan.planHash && stableStringify(freshPlan) === stableStringify(plan), "当前组合/部署状态/脚本已变化，重新生成计划");
  const authPublic = createPublicKey(createPrivateKey(readFileSync(c.authorizationPrivateKeyFile))).export({ type: "spki", format: "der" });
  assert(config.authorizationIssuer === c.authorizationIssuer && createPublicKey(readFileSync(config.authorizationPublicKeyFile)).export({ type: "spki", format: "der" }).equals(authPublic), "部署身份授权方与认证操作服务不匹配");
  return { plan, config };
}
export async function registerControlDeployment({ config, planId, configId, planFile, releaseSetFile, now = Date.now() }) {
  assert(id(planId) && id(configId), "部署计划入口编号无效");
  const entry = { planId, configId, planFile: controlledPath(planFile), releaseSetFile: controlledPath(releaseSetFile), planFileHash: hash(readFileSync(planFile)) };
  inspectControlDeployment(config, entry, now);
  return lockedJson(path.join(config.dataDir, "deployments.json"), { schemaVersion: 1, plans: {} }, (catalog) => {
    assert(catalog.schemaVersion === 1 && catalog.plans, "部署计划目录损坏");
    if (Object.hasOwn(catalog.plans, planId)) assert(stableStringify(catalog.plans[planId]) === stableStringify(entry), "同一部署计划入口不能替换内容");
    catalog.plans[planId] = entry; return { status: "registered", url: `${config.origin}/deployments/${planId}` };
  });
}
export function authorizeControlDeployment({ config: c, entry, actorId, reason, expectedPlanHash, identitySource, now = Date.now() }) {
  const { plan, config } = inspectControlDeployment(c, entry, now);
  assert(plan.planHash === expectedPlanHash && typeof reason === "string" && reason.trim() && reason.length <= 2000, "部署计划已变化或缺少明确原因");
  assert((plan.action === "smoke" ? config.verifiers : config.operators).includes(actorId), "当前认证人员无权授权该动作");
  const releaseSet = readControlledJson(entry.releaseSetFile); assert(!releaseSet.components.some((v) => v.authorId === actorId), "组件作者不能授权自己的部署/独立验证");
  const authorization = signRecord({ schemaVersion: 1, kind: "deployment-authorization", authorizationId: `deploy-authorization-${randomUUID()}`, issuer: c.authorizationIssuer, identitySource, scope: "deployment-execute", decision: "approved", action: plan.action, planHash: plan.planHash, releaseSetHash: plan.releaseSetHash, environment: plan.environment, stateHash: plan.stateHash, actorId, reason, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString() }, c.authorizationPrivateKeyFile);
  writeExclusiveJson(path.join(c.dataDir, "authorizations", authorization.authorizationId + ".json"), authorization);
  return authorization;
}
