import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, randomUUID, verify } from "node:crypto";
import { loadCiSourceConfig, collectCiSource } from "./ci-source.js";
import { discoverCiRuns } from "./ci-discovery.js";
import { loadGovernanceConfig, signPlatformReceipt, ingestGovernance, ingestLifecycleGovernance, reconcileGovernance, dispatchGovernance, readGovernanceState } from "./governance.js";
import { createBuildLifecycle, createReviewLifecycle } from "./lifecycle-source.js";
import { controlledPath, readControlledJson, writeExclusiveJson, lockedJson } from "./control-store.js";
import { stableStringify } from "./util.js";
import { createCiReview } from "./review-ci.js";
import { ingestReviewPublications } from "./review-publication.js";
import { ingestDeploymentDeliveries } from "./deployment-delivery.js";
const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

export function loadAutomationConfig(file) {
  const c = readControlledJson(file), base = path.dirname(path.resolve(file));
  assert(c.schemaVersion === 1 && Array.isArray(c.sources) && c.sources.length > 0 && c.sources.length <= 100, "自动执行器必须登记固定CI来源");
  for (const field of ["governanceConfigFile", "stateFile", "dataDir", "receiptPrivateKeyFile"]) { assert(c[field], `自动执行器缺少${field}`); c[field] = controlledPath(path.resolve(base, c[field])); }
  const g = loadGovernanceConfig(c.governanceConfigFile), key = createPrivateKey(readFileSync(c.receiptPrivateKeyFile));
  assert(key.asymmetricKeyType === "ed25519" && createPublicKey(key).export({ type: "spki", format: "der" }).equals(createPublicKey(readFileSync(g.publicKeyFile)).export({ type: "spki", format: "der" })), "自动执行器事件密钥未绑定治理公钥");
  const seen = new Set();
  for (const source of c.sources) {
    assert(safeId(source.id) && source.configFile && source.actors && Object.keys(source.actors).length > 0 && Object.values(source.actors).every(safeId), "CI来源编号/已认证用户映射缺失");
    source.configFile = controlledPath(path.resolve(base, source.configFile)); source.config = loadCiSourceConfig(source.configFile);
    const scopeKey = source.config.project + ":" + source.config.scope;
    assert(!seen.has(source.id) && !seen.has(scopeKey), "一个项目范围只能绑定一个CI来源，避免运行顺序串线"); seen.add(source.id); seen.add(scopeKey);
    assert(g.projects[source.config.project]?.scopes[source.config.scope] && g.allowedLinkOrigins.includes(source.config.baseUrl), "CI来源项目/范围/链接未在治理批准");
    assert(typeof source.since === "string" && Number.isFinite(Date.parse(source.since)), "首次发现窗口必须明确，禁止默认只看最新一次");
    assert(["dev", "sit", "uat", "pre", "prd"].includes(source.environment), "必须固定构建目标环境");
    if (source.manifestPath !== undefined) assert(source.config.artifacts.paths.includes(source.manifestPath), "构建清单必须登记在固定来源工件内");
    if (source.review !== undefined) {
      assert(source.review && typeof source.review.configFile === "string" && typeof source.review.outRoot === "string", "自动Review必须固定接线配置和中央证据根目录");
      source.review.configFile = controlledPath(path.resolve(base, source.review.configFile)); source.review.outRoot = controlledPath(path.resolve(base, source.review.outRoot));
      if (source.review.publication) {
        for (const key of ["manifestDir", "publicKeyFile", "authorizationPublicKeyFile", "evidenceRoot"]) { assert(source.review.publication[key], `正式Review订阅缺少${key}`); source.review.publication[key] = controlledPath(path.resolve(base, source.review.publication[key])); }
        assert(source.review.publication.expectAuthorizationIssuer && /^[a-f0-9]{64}$/.test(source.review.publication.expectReviewPolicyHash || ""), "正式Review订阅身份/策略摘要无效");
      }
    }
  }
  if (c.deployments !== undefined) {
    assert(c.deployments && typeof c.deployments.deliveryDir === "string" && c.deployments.configs && typeof c.deployments.configs === "object" && !Array.isArray(c.deployments.configs) && Object.keys(c.deployments.configs).length > 0, "部署回流必须登记固定交付目录和配置映射");
    c.deployments.deliveryDir = controlledPath(path.resolve(base, c.deployments.deliveryDir));
    for (const [id, spec] of Object.entries(c.deployments.configs)) {
      assert(safeId(id) && spec && typeof spec === "object", "部署回流配置编号无效");
      for (const field of ["configFile", "executorPublicKeyFile", "executionRoot"]) { assert(typeof spec[field] === "string" && spec[field], `部署回流缺少${field}`); spec[field] = controlledPath(path.resolve(base, spec[field])); }
    }
  }
  c.intervalSeconds ??= 60; assert(Number.isSafeInteger(c.intervalSeconds) && c.intervalSeconds >= 10 && c.intervalSeconds <= 3600, "自动执行间隔必须在10~3600秒");
  c.governance = g; return c;
}

// Exactly one bounded cycle. Cron/Jenkins or the built-in loop calls this;
// developers never maintain an expectedRuns JSON or execute review commands.
export async function automationTick({ configFile, send = false, env = process.env, fetchImpl = fetch, now = Date.now(), discoverImpl = discoverCiRuns, collectImpl = collectCiSource, afterStage = () => {} }) {
  const monotonicStart = performance.now(), currentInstant = () => now + Math.ceil(performance.now() - monotonicStart);
  const c = loadAutomationConfig(configFile), executionId = `tick-${randomUUID()}`, tickDir = path.join(c.dataDir, executionId);
  const binding = hash(stableStringify({ ...c, governance: c.governance }));
  // Acquire the scheduler lock across discovery, receipt ingestion and outbox;
  // governance has a separate lock so authenticated actions remain serializable.
  return lockedJson(path.join(c.dataDir, "automation-state.json"), { schemaVersion: 1, binding, runs: {}, history: [], health: {}, discovery: {}, reviewPublications: {} }, async (state, checkpoint) => {
    assert(state.schemaVersion === 1 && state.binding === binding && state.runs && Array.isArray(state.history) && state.health, "自动执行器配置身份变化或状态损坏，不能静默重置");
    state.discovery ??= {}; state.reviewPublications ??= {};
    // Fail before querying/signing anything if the ledger itself cannot be read.
    readGovernanceState({ configFile: c.governanceConfigFile, stateFile: c.stateFile });
    const result = { executionId, startedAt: new Date(now).toISOString(), sources: [], errors: [], networkExecuted: false };
    const sign = (payload, suffix) => writeExclusiveJson(path.join(tickDir, suffix + ".receipt.json"), signPlatformReceipt(payload, { privateKeyFile: c.receiptPrivateKeyFile, issuer: c.governance.issuer, createdAt: new Date(now).toISOString() }));
    const refreshReceipt = (file, suffix) => {
      const envelope = readControlledJson(file), { signature, ...body } = envelope;
      assert(body.kind === "signed-platform-receipt" && body.issuer === c.governance.issuer && typeof signature === "string" && verify(null, Buffer.from(stableStringify(body)), createPublicKey(readFileSync(c.governance.publicKeyFile)), Buffer.from(signature, "base64")), "持久回执已变化，不能续签");
      const age = now - Date.parse(body.createdAt); assert(Number.isFinite(age) && age >= -60000, "持久回执时间无效");
      // Only the envelope is renewed; payload occurredAt/source/evidence and
      // eventId stay byte-for-byte equivalent. This is a retry, not a new scan.
      return age > 23 * 3600000 ? sign(body.payload, suffix + `-renewed-${randomUUID()}`) : file;
    };
    const alreadyIngested = (file, sourceFile, summaryFile) => {
      if (!file) return false;
      const envelope = readControlledJson(file), { signature, ...body } = envelope;
      assert(body.kind === "signed-platform-receipt" && body.issuer === c.governance.issuer && typeof signature === "string" && verify(null, Buffer.from(stableStringify(body)), createPublicKey(readFileSync(c.governance.publicKeyFile)), Buffer.from(signature, "base64")), "持久回执签名变化");
      const payload = body.payload, known = readGovernanceState({ configFile: c.governanceConfigFile, stateFile: c.stateFile }).events[payload.eventId];
      if (!known) return false;
      assert(known.digest === hash(stableStringify(payload)), "已入账事件与持久回执冲突");
      assert(payload.source?.recordHash === hash(readFileSync(controlledPath(sourceFile))) && (!summaryFile || payload.reportHash === hash(readFileSync(controlledPath(summaryFile)))), "已入账事件原件变化，不能恢复");
      return true;
    };
    for (const source of c.sources) {
      const item = { source: source.id, discovered: 0, collected: 0, skipped: 0, errors: [], reconciliation: null }; result.sources.push(item);
      try {
        const window = state.discovery[source.id] ??= { updatedSince: source.since, cursor: null, highWatermarkRunId: 0, pendingRunIds: [] };
        assert(Array.isArray(window.pendingRunIds) && typeof window.updatedSince === "string" && Number.isSafeInteger(window.highWatermarkRunId), "CI发现水位状态损坏");
        const unfinished = Object.entries(state.runs).filter(([key, run]) => key.slice(0, key.lastIndexOf(":")) === source.id && (!run.terminal || Object.values(run.revisions).some((p) => !p.done && !p.supersededForFreshness))).map(([, r]) => Number(r.pipelineId));
        const recheckQueue = [...new Set([...unfinished, ...window.pendingRunIds])].sort((a, b) => a - b), budget = Math.min(1000, source.config.discovery?.maxRuns || 1000);
        assert(window.lastRecheckedRunId === undefined || Number.isSafeInteger(window.lastRecheckedRunId) && window.lastRecheckedRunId >= 0, "CI重查轮转状态损坏");
        const start = recheckQueue.findIndex((id) => id > (window.lastRecheckedRunId || 0));
        const ordered = start < 0 ? recheckQueue : [...recheckQueue.slice(start), ...recheckQueue.slice(0, start)], recheckRunIds = ordered.slice(0, budget);
        item.recheckBacklog = recheckQueue.length; checkpoint();
        const discovery = await discoverImpl({ configFile: source.configFile, actors: source.actors, since: source.since, updatedSince: window.updatedSince, cursor: window.cursor,
          afterRunId: window.highWatermarkRunId, recheckRunIds, env, fetchImpl, now }); result.networkExecuted = true;
        const attempted = discovery.attemptedRecheckRunIds || [];
        assert(Array.isArray(attempted) && attempted.every((id) => recheckRunIds.includes(Number(id))), "来源返回未批准的重查身份");
        if (attempted.length) window.lastRecheckedRunId = Number(attempted.at(-1));
        writeExclusiveJson(path.join(tickDir, source.id, "discovery.json"), discovery);
        item.errors.push(...(discovery.discoveryErrors || []).map((e) => ({ stage: "discovery", runId: e.runId || null, reason: e.reason || e.message || "source-invalid" })));
        window.pendingRunIds = [...new Set([...window.pendingRunIds, ...discovery.runs.map((r) => Number(r.runId)), ...(discovery.discoveryErrors || []).map((e) => Number(e.runId))])];
        assert(window.pendingRunIds.every((id) => Number.isSafeInteger(id) && id > 0), "坏运行缺少可追查身份，不能推进发现水位");
        window.scanHighWatermarkRunId = Math.max(window.scanHighWatermarkRunId || 0, discovery.highWatermarkRunId || 0);
        window.cursor = discovery.nextCursor || null;
        if (discovery.watermark && !discovery.partial) {
          window.updatedSince = new Date(Math.max(Date.parse(source.since), Date.parse(discovery.watermark) - 60000)).toISOString();
          window.highWatermarkRunId = Math.max(window.highWatermarkRunId, window.scanHighWatermarkRunId); delete window.scanHighWatermarkRunId;
        }
        checkpoint();
        await afterStage("discovery-checkpointed", { source: source.id });
        const runs = [...discovery.runs].sort((a, b) => Number(a.runId) - Number(b.runId)); item.discovered = runs.length;
        for (const run of runs) {
          const runKey = `${source.id}:${run.runId}`; let record = state.runs[runKey];
          try {
            assert(Number.isSafeInteger(Number(run.runId)) && Number(run.runId) > 0 && Number(run.runId) <= Math.floor((Number.MAX_SAFE_INTEGER - 9999) / 10000) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(run.sha), "发现的流水线身份超出顺序预算");
            assert(new URL(run.pipelineUrl).origin === source.config.baseUrl && run.ref === source.config.ref && Number.isFinite(Date.parse(run.dueAt)), "发现的流水线范围/截止时间无效");
            if (record) assert(record.sha === run.sha && record.project === source.config.project && record.scope === source.config.scope, "同runId源码身份发生变化，禁止覆盖原证据");
            else record = state.runs[runKey] = { project: source.config.project, scope: source.config.scope, sha: run.sha, pipelineId: String(run.runId), pipelineUrl: run.pipelineUrl, dueAt: run.dueAt, generation: 0, revisions: {} };
            assert(record.revisions && typeof record.revisions === "object" && Number.isSafeInteger(record.generation), "运行进度损坏，不能重置");
            const revision = run.observedRevision || hash(stableStringify({ status: run.status, missingJobs: run.missingJobs, actorSource: run.actorSource, sha: run.sha }));
            assert(/^[a-f0-9]{64}$/.test(revision), "发现快照摘要无效");
            let progress = record.revisions[revision];
            if (progress?.collection && !progress.done) {
              if (!progress.qualityDone && alreadyIngested(progress.qualityReceiptFile, progress.collection.sourceFile, progress.collection.summaryFile)) progress.qualityDone = true;
              if (!progress.buildDone && alreadyIngested(progress.buildReceiptFile, progress.build?.sourceFile)) progress.buildDone = true;
              if (!progress.reviewDone && alreadyIngested(progress.reviewReceiptFile, progress.reviewLifecycle?.sourceFile)) progress.reviewDone = true;
              if ((!progress.collection.eventFile || progress.qualityDone) && (!source.manifestPath || progress.buildDone) && (!source.review || progress.review && progress.reviewDone)) progress.done = true;
              checkpoint();
            }
            if (progress?.collection && !progress.done) {
              const observedAt = Date.parse(readControlledJson(progress.collection.sourceFile).observedAt);
              assert(Number.isFinite(observedAt) && observedAt <= now + 60000, "持久采集时间无效");
              if (now - observedAt > 23 * 3600000) {
                // Retain the original immutable partial attempt. Re-query the
                // now-stable CI source with a new generation; never edit old
                // payload/source timestamps merely to satisfy freshness.
                record.revisions[`${revision}:expired:${progress.generation}`] = { ...progress, supersededForFreshness: true };
                delete record.revisions[revision]; progress = null;
              }
            }
            if (!progress) {
              record.generation++; assert(record.generation <= 9999, "同一流水线重试超出顺序预算");
              progress = record.revisions[revision] = { revision, generation: record.generation, sequence: Number(run.runId) * 10000 + record.generation, qualityDone: false, buildDone: false, done: false };
            }
            record.sequence = progress.sequence; record.lastObservation = revision;
            record.terminal = !!run.terminal;
            checkpoint(); // reserve sequence and immutable observation before any side effect
            if (!run.authorId || !Object.values(source.actors).includes(run.authorId)) throw new Error("运行责任人未完成认证用户映射；已保留漏跑预期，不能自报authorId");
            if (run.missingJobs?.length) throw new Error("必需作业缺失；已保留漏跑预期");
            if (progress.done) {
              const receipts = [[progress.qualityReceiptFile, progress.collection?.sourceFile, progress.collection?.summaryFile], [progress.buildReceiptFile, progress.build?.sourceFile], [progress.reviewReceiptFile, progress.reviewLifecycle?.sourceFile]].filter(([file]) => file);
              assert(receipts.every(([file, original, summary]) => alreadyIngested(file, original, summary)), "中央台账与执行缓存不一致；请恢复配套台账后重试，不能把缓存当实际入账");
              item.skipped++; continue;
            }
            if (!progress.collection) {
              const requestFile = writeExclusiveJson(path.join(tickDir, source.id, `request-${run.runId}.json`), { sha: run.sha, runId: Number(run.runId), sequence: progress.sequence, authorId: run.authorId });
              const collection = await collectImpl({ configFile: source.configFile, requestFile, outDir: path.join(tickDir, source.id, `run-${run.runId}`), env, fetchImpl, now }); item.collected++;
              progress.collection = collection; checkpoint();
              await afterStage("source-collected", { source: source.id, runId: run.runId, revision });
            }
            const collection = progress.collection;
            // The exact original payload/receipt is journaled before ingest.
            // A crash after ingest retries these same bytes, never recollects a
            // report event with a different observation time/source hash.
            if (collection.eventFile && !progress.qualityDone) {
              if (!progress.qualityReceiptFile) { progress.qualityReceiptFile = sign(readControlledJson(collection.eventFile), `${source.id}/quality-${run.runId}`); checkpoint(); }
              progress.qualityReceiptFile = refreshReceipt(progress.qualityReceiptFile, `${source.id}/quality-${run.runId}`); checkpoint();
              ingestGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, eventFile: progress.qualityReceiptFile, summaryFile: collection.summaryFile, now });
              await afterStage("quality-ingested", { source: source.id, runId: run.runId, revision });
              progress.qualityDone = true; checkpoint();
            }
            if (source.manifestPath && !progress.buildDone) {
              if (!progress.build) {
                progress.build = createBuildLifecycle({ configFile: source.configFile, sourceFile: collection.sourceFile, manifestPath: source.manifestPath, env: source.environment, sha: run.sha, outDir: path.join(tickDir, source.id, `build-${run.runId}`), now });
                progress.buildReceiptFile = sign(readControlledJson(progress.build.eventFile), `${source.id}/build-${run.runId}`); checkpoint();
              }
              progress.buildReceiptFile = refreshReceipt(progress.buildReceiptFile, `${source.id}/build-${run.runId}`); checkpoint();
              ingestLifecycleGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, eventFile: progress.buildReceiptFile, sourceFile: progress.build.sourceFile, now });
              await afterStage("build-ingested", { source: source.id, runId: run.runId, revision });
              progress.buildDone = true; checkpoint();
            }
            if (source.review && !progress.review) {
              const observation = readControlledJson(collection.sourceFile);
              if (observation.artifacts.some((a) => a.path === source.config.qualitySummary)) {
                progress.review = await createCiReview({ configFile: source.review.configFile, sourceFile: collection.sourceFile, outDir: path.join(source.review.outRoot, `${source.id}-${run.runId}-${progress.generation}-${randomUUID()}`), now });
                item.reviewUrl = progress.review.url; checkpoint();
                await afterStage("review-registered", { source: source.id, runId: run.runId, revision });
              } else if (run.terminal) throw new Error("本轮无有效Gate原件可生成Review，保留未运行状态并等待真实补跑");
            } else if (progress.review) item.reviewUrl = progress.review.url;
            if (progress.review && !progress.reviewDone) {
              if (!progress.reviewLifecycle) {
                assert(progress.generation <= 4999, "Review通道重试超出阶段顺序预算");
                progress.reviewLifecycle = createReviewLifecycle({ configFile: source.configFile, sourceFile: collection.sourceFile, recordFile: progress.review.recordFile, evidenceRoot: progress.review.evidenceRoot, sha: run.sha, reportUrl: progress.review.url, sequence: Number(run.runId) * 10000 + progress.generation * 2 - 1, expectReviewPolicyHash: progress.review.policyHash, outDir: path.join(tickDir, source.id, `review-${run.runId}`), now });
                progress.reviewReceiptFile = sign(readControlledJson(progress.reviewLifecycle.eventFile), `${source.id}/review-${run.runId}`); checkpoint();
              }
              ingestLifecycleGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, eventFile: progress.reviewReceiptFile, sourceFile: progress.reviewLifecycle.sourceFile, now });
              progress.reviewDone = true; checkpoint();
            }
            progress.done = true; record.evidenceDir = path.dirname(collection.sourceFile); checkpoint();
          } catch (error) { item.errors.push({ stage: "collection", runId: run.runId, reason: error.message }); }
        }
        // Watermarks may be durable before processing starts. Keep every listed
        // run queued until its last terminal observation is fully journaled.
        const failedRunIds = new Set(item.errors.map((e) => Number(e.runId)).filter(Boolean));
        window.pendingRunIds = window.pendingRunIds.filter((id) => { const run = state.runs[`${source.id}:${id}`]; return failedRunIds.has(id) || !run?.terminal || !run.revisions?.[run.lastObservation]?.done; }); checkpoint();
        // Include all remembered runs, even when an API lookback no longer
        // returns an old missing/canceled job. A later healthy run cannot erase it.
        const expectedRuns = Object.entries(state.runs).filter(([key]) => key.slice(0, key.lastIndexOf(":")) === source.id).flatMap(([, r]) => Object.values(r.revisions).map((p) => ({ project: r.project, scope: r.scope, sha: r.sha, pipelineId: r.pipelineId, sequence: p.sequence, pipelineUrl: r.pipelineUrl, dueAt: r.dueAt })));
        item.reconciliation = reconcileGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, expectationsFile: sign({ schemaVersion: 1, kind: "pipeline-expectations", eventId: `query-${source.id}-${randomUUID()}`, expectedRuns }, `${source.id}/expectations`), now });
      } catch (error) { item.errors.push({ stage: "source", reason: error.message }); }
      if (source.review?.publication) {
        try {
          item.formalReviews = await ingestReviewPublications({ configFile: c.governanceConfigFile, stateFile: c.stateFile, receiptPrivateKeyFile: c.receiptPrivateKeyFile, ciConfigFile: source.configFile, publication: source.review.publication, dataDir: path.join(c.dataDir, "formal-reviews", source.id), now: currentInstant() });
          item.errors.push(...item.formalReviews.errors.map((e) => ({ stage: "formal-review", ...e })));
        } catch (error) { item.errors.push({ stage: "formal-review", reason: error.message }); }
      }
      state.health[source.id] = { at: new Date(now).toISOString(), status: item.errors.length ? "attention" : "ok", errors: item.errors };
      result.errors.push(...item.errors.map((e) => ({ source: source.id, ...e })));
    }
    if (c.deployments) {
      try {
        result.deployments = await ingestDeploymentDeliveries({ governanceConfigFile: c.governanceConfigFile, stateFile: c.stateFile, receiptPrivateKeyFile: c.receiptPrivateKeyFile, deliveryDir: c.deployments.deliveryDir, dataDir: path.join(c.dataDir, "deployments"), configs: c.deployments.configs, now: currentInstant() });
        result.errors.push(...result.deployments.errors.map((e) => ({ stage: "deployment", ...e })));
      } catch (error) { result.errors.push({ stage: "deployment", reason: error.message }); }
    }
    // A source outage still leaves a durable health result and allows retries /
    // SLA escalation / other projects' pending notifications to make progress.
    try {
      reconcileGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, expectationsFile: sign({ schemaVersion: 1, kind: "pipeline-expectations", eventId: `sla-${randomUUID()}`, expectedRuns: Object.values(state.runs).flatMap((r) => Object.values(r.revisions || {}).map((p) => ({ project: r.project, scope: r.scope, sha: r.sha, pipelineId: r.pipelineId, sequence: p.sequence, pipelineUrl: r.pipelineUrl, dueAt: r.dueAt }))) }, "all-expectations"), now });
      result.delivery = await dispatchGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, send, env, fetchImpl, now });
      if (result.delivery.results?.some((r) => r.status !== "delivered") || result.delivery.deadLetters?.length || result.delivery.unknownDeliveries?.length) result.errors.push({ stage: "delivery", reason: "消息存在待恢复投递；查看认证操作入口" });
    } catch (error) { result.errors.push({ stage: "outbox", reason: error.message }); }
    result.status = result.errors.length ? "attention" : "ok";
    state.history.push({ executionId, at: result.startedAt, status: result.status, errors: result.errors }); if (state.history.length > 100) state.history.splice(0, state.history.length - 100);
    writeExclusiveJson(path.join(tickDir, "result.json"), result); return result;
  });
}

export function startAutomation({ configFile, send = false, onResult = (result) => process.stdout.write(JSON.stringify(result) + "\n"), ...options }) {
  const c = loadAutomationConfig(configFile); let stopped = false, timer;
  const next = async () => { try { onResult(await automationTick({ configFile, send, ...options })); } catch (error) { onResult({ status: "attention", stage: "scheduler", reason: error.message }); } if (!stopped) timer = setTimeout(next, c.intervalSeconds * 1000); };
  next(); return { stop() { stopped = true; clearTimeout(timer); } };
}
