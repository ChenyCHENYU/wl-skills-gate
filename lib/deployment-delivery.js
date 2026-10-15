import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { controlledPath, readControlledJson, lockedJson, writeExclusiveJson } from "./control-store.js";
import { releaseDigest } from "./release-set.js";
import { loadDeploymentConfig, verifyDeploymentCiContext, createDeploymentLifecycle } from "./deployment.js";
import { verifyRecord, validateTime } from "./evidence.js";
import { loadGovernanceConfig, signPlatformReceipt, ingestLifecycleGovernance, readGovernanceState } from "./governance.js";
import { stableStringify } from "./util.js";

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const digest = (value) => releaseDigest(value), jsonHash = (value) => digest(stableStringify(value));
const inside = (root, file) => { const rel = path.relative(controlledPath(root), controlledPath(file)); assert(rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel), "部署交付原件越出中央批准执行根目录"); };

// Read only fixed-scope executor deliveries, verify the executor signature and
// actual Jenkins context, then sign central receipts. Project jobs never own
// this event key. Every project and delivery checkpoints independently.
export async function ingestDeploymentDeliveries({ governanceConfigFile, stateFile, receiptPrivateKeyFile, deliveryDir, dataDir, configs, now = Date.now(), afterStage = () => {} }) {
  const governance = loadGovernanceConfig(governanceConfigFile), key = createPrivateKey(readFileSync(controlledPath(receiptPrivateKeyFile)));
  assert(key.asymmetricKeyType === "ed25519" && createPublicKey(key).export({ type: "spki", format: "der" }).equals(createPublicKey(readFileSync(governance.publicKeyFile)).export({ type: "spki", format: "der" })), "部署交付事件私钥未绑定治理固定公钥");
  assert(configs && typeof configs === "object" && Object.keys(configs).length > 0, "部署交付缺少中央配置映射");
  deliveryDir = controlledPath(deliveryDir); dataDir = controlledPath(dataDir);
  const binding = jsonHash({ governanceConfigFile: controlledPath(governanceConfigFile), stateFile: controlledPath(stateFile), publicKey: createPublicKey(key).export({ type: "spki", format: "pem" }), configs });
  return lockedJson(path.join(dataDir, "deployment-delivery-state.json"), { schemaVersion: 1, binding, deliveries: {}, streams: {} }, async (state, checkpoint) => {
    assert(state.schemaVersion === 1 && state.binding === binding && state.deliveries && typeof state.deliveries === "object" && state.streams && typeof state.streams === "object", "部署交付状态损坏/配置身份变化，禁止重置");
    const result = { status: "ok", delivered: 0, skipped: 0, errors: [], facts: [], networkExecuted: false };
    if (!existsSync(deliveryDir)) return result;
    assert(lstatSync(deliveryDir).isDirectory(), "部署交付队列不是目录");
    for (const entry of readdirSync(deliveryDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".json")) continue;
      try {
        assert(entry.isFile() && !entry.isSymbolicLink() && /^delivery-[a-f0-9]{48}\.json$/.test(entry.name), "部署交付队列文件格式不合法");
        const file = controlledPath(path.join(deliveryDir, entry.name)); assert(lstatSync(file).size <= 65536, "部署交付队列超出大小预算");
        const request = readControlledJson(file), requestHash = digest(readFileSync(file));
        assert(request.schemaVersion === 1 && request.kind === "deployment-delivery" && request.deliveryId + ".json" === entry.name && Object.hasOwn(configs, request.configId), "部署交付类型/配置身份无效");
        let progress = state.deliveries[request.deliveryId];
        if (progress) assert(progress.requestHash === requestHash, "部署交付编号/原件发生变化");
        else progress = state.deliveries[request.deliveryId] = { requestHash, occurredAt: now, projects: {}, done: false };
        const spec = configs[request.configId], config = loadDeploymentConfig(spec.configFile);
        assert(config.ci, "部署交付消费者禁止缺少固定CI签名上下文的孤立执行记录");
        inside(spec.executionRoot, request.executionFile); inside(spec.executionRoot, request.releaseSetFile);
        const executionFile = controlledPath(request.executionFile); assert(lstatSync(executionFile).isFile() && lstatSync(executionFile).size <= 1024 * 1024 && digest(readFileSync(executionFile)) === request.executionFileHash, "部署交付执行原件摘要不一致");
        const execution = readControlledJson(executionFile); verifyRecord(execution, controlledPath(spec.executorPublicKeyFile));
        assert(execution.kind === "deployment-execution" && execution.schemaVersion === 1 && execution.configHash === jsonHash(config) && execution.issuer === config.issuer && execution.releaseSetHash === request.expectReleaseSetHash && request.deliveryId === `delivery-${digest(`${request.configId}:${request.executionFileHash}`).slice(0, 48)}`, "部署交付签名配置/组合/编号不一致");
        const ci = verifyDeploymentCiContext(config, execution.ciContext), phase = { deploy: 1, smoke: 2, recover: 3 }[execution.action];
        assert(phase, "部署交付动作不合法");
        const sequence = ci.buildNumber * 10000 + phase, planId = `deployment-${digest(ci.buildUrl).slice(0, 24)}`;
        const reportUrl = new URL(`artifact/deployment-delivery/${planId}/execution.json`, ci.buildUrl).href;
        const assertRecorded = (item) => {
          const fact = readControlledJson(path.join(item.factDir, "lifecycle-event.json")), ledger = readGovernanceState({ configFile: governanceConfigFile, stateFile });
          assert(item.eventId === fact.eventId && ledger.events[item.eventId]?.digest === jsonHash(fact), "部署交付checkpoint存在但治理原事件缺失/变化，须恢复真实台账，禁止假装完成");
        };
        if (progress.done) { for (const project of config.projects) { assert(progress.projects[project]?.done, "组合交付完成标记缺少组件checkpoint"); assertRecorded(progress.projects[project]); } result.skipped++; continue; }
        checkpoint();
        for (const project of config.projects) {
          const old = progress.projects[project]; if (old?.done) { assertRecorded(old); continue; }
          const item = old || (progress.projects[project] = { factDir: path.join(dataDir, "facts", request.deliveryId, `${project}-${randomUUID()}`), observedAt: progress.occurredAt });
          checkpoint();
          const options = { configFile: spec.configFile, executionFile, executorPublicKeyFile: spec.executorPublicKeyFile, releaseSetFile: request.releaseSetFile, expectReleaseSetHash: request.expectReleaseSetHash, project, sequence, pipelineId: String(ci.buildNumber), jobId: ci.jobId, pipelineUrl: ci.buildUrl, reportUrl, now: item.observedAt };
          const factFile = path.join(item.factDir, "lifecycle-event.json");
          if (!existsSync(factFile)) {
            if (existsSync(item.factDir)) { item.factDir = path.join(dataDir, "facts", request.deliveryId, `${project}-${randomUUID()}`); checkpoint(); }
            createDeploymentLifecycle({ ...options, outDir: item.factDir });
          }
          const actualFactFile = path.join(item.factDir, "lifecycle-event.json"), fact = readControlledJson(actualFactFile);
          const stream = `${fact.project}:${fact.scope}:${fact.lane}:${fact.environment}`, streamBinding = jsonHash({ ci: config.ci, executorPublicKey: createPublicKey(readFileSync(spec.executorPublicKeyFile)).export({ type: "spki", format: "pem" }) });
          if (state.streams[stream]) assert(state.streams[stream] === streamBinding, "同项目范围/环境/通道不得混用不同CI作业或执行签名来源；请使用独立通道或受审计迁移");
          else { state.streams[stream] = streamBinding; checkpoint(); }
          // A crash may have published the fact before its receipt checkpoint.
          // Rebuild deterministically and compare; never trust a leftover JSON.
          const scratch = path.join(dataDir, "verification", randomUUID());
          try { const expected = createDeploymentLifecycle({ ...options, outDir: scratch }); assert(stableStringify(readControlledJson(expected.eventFile)) === stableStringify(fact), "部署交付持久事实与实际执行原件不一致"); }
          finally { rmSync(scratch, { recursive: true, force: true }); }
          const known = readGovernanceState({ configFile: governanceConfigFile, stateFile }).events[fact.eventId];
          if (known) assert(known.digest === jsonHash(fact), "部署交付已入账事实内容冲突");
          else {
            validateTime(execution.createdAt, { now: new Date(now) });
            const receiptFile = writeExclusiveJson(path.join(dataDir, "receipts", `${request.deliveryId}-${project}-${randomUUID()}.json`), signPlatformReceipt(fact, { privateKeyFile: receiptPrivateKeyFile, issuer: governance.issuer, createdAt: new Date(now).toISOString() }));
            ingestLifecycleGovernance({ configFile: governanceConfigFile, stateFile, eventFile: receiptFile, sourceFile: executionFile, now });
          }
          await afterStage("deployment-ingested", { deliveryId: request.deliveryId, project });
          item.done = true; item.eventId = fact.eventId; checkpoint(); result.facts.push({ project, eventId: fact.eventId, status: fact.status });
        }
        progress.done = true; checkpoint(); result.delivered++;
      } catch (error) { result.errors.push({ delivery: entry.name, reason: error.message }); checkpoint(); }
    }
    result.status = result.errors.length ? "attention" : "ok"; return result;
  });
}
