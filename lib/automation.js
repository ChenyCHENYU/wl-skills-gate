import path from "node:path";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, randomUUID, verify } from "node:crypto";
import { loadCiSourceConfig, collectCiSource } from "./ci-source.js";
import { discoverCiRuns } from "./ci-discovery.js";
import { loadGovernanceConfig, signPlatformReceipt, ingestGovernance, ingestLifecycleGovernance, reconcileGovernance, dispatchGovernance, readGovernanceState } from "./governance.js";
import { createBuildLifecycle, createValidationBuildLifecycle, createReviewLifecycle } from "./lifecycle-source.js";
import {BUILD_RESULT_PATH,BUILD_ARCHIVE_PATH} from './build-artifacts.js';
import { controlledPath, readControlledJson, writeExclusiveJson, lockedJson } from "./control-store.js";
import { stableStringify } from "./util.js";
import { createCiReview } from "./review-ci.js";
import { ingestReviewPublications } from "./review-publication.js";
import { ingestDeploymentDeliveries } from "./deployment-delivery.js";
import {loadBuildDispatch,dispatchApprovedBuilds} from './jenkins-dispatch.js';
const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

export function loadAutomationConfig(file) {
  const c = readControlledJson(file), base = path.dirname(path.resolve(file));
  assert(c.schemaVersion === 1 && Array.isArray(c.sources) && c.sources.length > 0 && c.sources.length <= 1000, "自动执行器必须登记固定CI来源");
  for (const field of ["governanceConfigFile", "stateFile", "dataDir", "receiptPrivateKeyFile"]) { assert(c[field], `自动执行器缺少${field}`); c[field] = controlledPath(path.resolve(base, c[field])); }
  const g = loadGovernanceConfig(c.governanceConfigFile), key = createPrivateKey(readFileSync(c.receiptPrivateKeyFile));
  assert(key.asymmetricKeyType === "ed25519" && createPublicKey(key).export({ type: "spki", format: "der" }).equals(createPublicKey(readFileSync(g.publicKeyFile)).export({ type: "spki", format: "der" })), "自动执行器事件密钥未绑定治理公钥");
  const seen = new Set();
  for (const source of c.sources) {
    assert(safeId(source.id) && source.configFile && source.actors && Object.keys(source.actors).length > 0 && Object.values(source.actors).every(safeId), "CI来源编号/已认证用户映射缺失");
    source.configFile = controlledPath(path.resolve(base, source.configFile)); source.config = loadCiSourceConfig(source.configFile);
    const scopeKey = source.config.project + ":" + source.config.scope + (source.buildResultPath?':build':':quality');
    assert(!seen.has(source.id) && !seen.has(scopeKey), "一个项目范围的同类检查/构建只能绑定一个CI来源，避免运行顺序串线"); seen.add(source.id); seen.add(scopeKey);
    assert(g.projects[source.config.project]?.scopes[source.config.scope] && g.allowedLinkOrigins.includes(source.config.baseUrl), "CI来源项目/范围/链接未在治理批准");
    assert(typeof source.since === "string" && Number.isFinite(Date.parse(source.since)), "首次发现窗口必须明确，禁止默认只看最新一次");
    if(source.buildResultPath!==undefined){
      assert(source.buildResultPath===BUILD_RESULT_PATH && source.manifestPath===undefined && source.environment===undefined && source.config.system==='jenkins' && !source.config.qualitySummary,'验证构建来源需独立BUILD Job与固定结果，不声明部署环境');
      assert([BUILD_RESULT_PATH,BUILD_ARCHIVE_PATH].every(p=>source.config.artifacts.paths.includes(p)),'验证构建来源缺少固定归档');
    }
    if (source.manifestPath !== undefined) {
      assert(["dev", "sit", "uat", "pre", "prd"].includes(source.environment), "必须固定构建目标环境");
      assert(source.config.artifacts.paths.includes(source.manifestPath), "构建清单必须登记在固定来源工件内");
    } else assert(source.environment === undefined || source.environment === null || ["dev", "sit", "uat", "pre", "prd"].includes(source.environment), "纯检查来源不需要构建环境；不能用test冒充正式发布环境");
    if (source.review !== undefined) {
      assert(source.review && typeof source.review.configFile === "string" && typeof source.review.outRoot === "string", "自动Review必须固定接线配置和中央证据根目录");
      source.review.configFile = controlledPath(path.resolve(base, source.review.configFile)); source.review.outRoot = controlledPath(path.resolve(base, source.review.outRoot));
      if (source.review.publication) {
        for (const key of ["manifestDir", "publicKeyFile", "authorizationPublicKeyFile", "evidenceRoot"]) { assert(source.review.publication[key], `正式Review订阅缺少${key}`); source.review.publication[key] = controlledPath(path.resolve(base, source.review.publication[key])); }
        assert(source.review.publication.expectAuthorizationIssuer && /^[a-f0-9]{64}$/.test(source.review.publication.expectReviewPolicyHash || ""), "正式Review订阅身份/策略摘要无效");
      }
    }
    if(source.buildDispatch){
      assert(source.review?.publication,'自动续建须先登记正式Review交付');
      source.buildDispatch.registryFile=controlledPath(path.resolve(base,source.buildDispatch.registryFile));
      loadBuildDispatch({config:source.buildDispatch,ciConfigFile:source.configFile});
    }
  }
  for(const source of c.sources)if(source.buildResultPath){
    const companion=c.sources.filter(other=>other!==source && other.config.qualitySummary && other.config.project===source.config.project && other.config.scope===source.config.scope && other.config.ref.replace(/^(?:origin\/|refs\/heads\/)/,'')===source.config.ref.replace(/^(?:origin\/|refs\/heads\/)/,''));
    assert(companion.length===1 && companion[0].buildDispatch,'验证构建须绑定同范围CHECK与正式Review续建，不能独立冒充完整九维');
    const dispatch=loadBuildDispatch({config:companion[0].buildDispatch,ciConfigFile:companion[0].configFile});
    assert(dispatch.b.jobs.build===source.config.jobPath && dispatch.registry.jenkinsOrigin===source.config.baseUrl+'/','验证构建采集必须对应受控续建的实际BUILD任务');
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
  assert(!existsSync(path.join(c.dataDir, "fleet-maintenance.json")), "批量接入维护中；完成原批次续跑或回退，不删除业务台账");
  // Acquire the scheduler lock across discovery, receipt ingestion and outbox;
  // governance has a separate lock so authenticated actions remain serializable.
  return lockedJson(path.join(c.dataDir, "automation-state.json"), { schemaVersion: 1, binding, runs: {}, history: [], health: {}, discovery: {}, reviewPublications: {} }, async (state, checkpoint) => {
    assert(!existsSync(path.join(c.dataDir, "fleet-maintenance.json")), "批量接入维护中，稍后再采集");
    assert(state.schemaVersion === 1 && state.binding === binding && state.runs && Array.isArray(state.history) && state.health && typeof state.health === "object" && !Array.isArray(state.health), "自动执行器配置身份变化或状态损坏，不能静默重置");
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
        const window = Object.hasOwn(state.discovery, source.id) ? state.discovery[source.id] : (state.discovery[source.id] = { updatedSince: source.since, cursor: null, highWatermarkRunId: 0, pendingRunIds: [] });
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
            else record = state.runs[runKey] = { project: source.config.project, scope: source.config.scope, qualitySource:!!source.config.qualitySummary,sha: run.sha, pipelineId: String(run.runId), pipelineUrl: run.pipelineUrl, dueAt: run.dueAt, generation: 0, revisions: {} };
            assert(record.revisions && typeof record.revisions === "object" && Number.isSafeInteger(record.generation), "运行进度损坏，不能重置");
            const revision = run.observedRevision || hash(stableStringify({ status: run.status, missingJobs: run.missingJobs, actorSource: run.actorSource, sha: run.sha }));
            assert(/^[a-f0-9]{64}$/.test(revision), "发现快照摘要无效");
            let progress = record.revisions[revision];
            if (progress?.collection && !progress.done) {
              if (!progress.qualityDone && alreadyIngested(progress.qualityReceiptFile, progress.collection.sourceFile, progress.collection.summaryFile)) progress.qualityDone = true;
              if (!progress.buildDone && alreadyIngested(progress.buildReceiptFile, progress.build?.sourceFile)) progress.buildDone = true;
              if (!progress.reviewDone && alreadyIngested(progress.reviewReceiptFile, progress.reviewLifecycle?.sourceFile)) progress.reviewDone = true;
              if ((!progress.collection.eventFile || progress.qualityDone) && (!(source.manifestPath || source.buildResultPath) || progress.buildDone) && (!source.review || progress.review && progress.reviewDone)) progress.done = true;
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
            if ((source.manifestPath || source.buildResultPath) && !progress.buildDone) {
              if (!progress.build) {
                const create=source.buildResultPath?createValidationBuildLifecycle:createBuildLifecycle;
                progress.build = create({ configFile: source.configFile, sourceFile: collection.sourceFile, manifestPath: source.manifestPath, resultPath:source.buildResultPath,env: source.environment, sha: run.sha, outDir: path.join(tickDir, source.id, `build-${run.runId}`), now });
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
        const expectedRuns = Object.entries(state.runs).filter(([key,r]) => r.qualitySource!==false && key.slice(0, key.lastIndexOf(":")) === source.id).flatMap(([, r]) => Object.values(r.revisions).map((p) => ({ project: r.project, scope: r.scope, sha: r.sha, pipelineId: r.pipelineId, sequence: p.sequence, pipelineUrl: r.pipelineUrl, dueAt: r.dueAt })));
        item.reconciliation = reconcileGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, expectationsFile: sign({ schemaVersion: 1, kind: "pipeline-expectations", eventId: `query-${source.id}-${randomUUID()}`, expectedRuns }, `${source.id}/expectations`), now });
      } catch (error) { item.errors.push({ stage: "source", reason: error.message }); }
      if (source.review?.publication) {
        try {
          assert(existsSync(source.review.publication.manifestDir) && lstatSync(source.review.publication.manifestDir).isDirectory(), "登记的正式Review输入队列不存在或未挂载；不能当作空队列");
          item.formalReviews = await ingestReviewPublications({ configFile: c.governanceConfigFile, stateFile: c.stateFile, receiptPrivateKeyFile: c.receiptPrivateKeyFile, ciConfigFile: source.configFile, publication: source.review.publication, dataDir: path.join(c.dataDir, "formal-reviews", source.id), now: currentInstant() });
          item.errors.push(...item.formalReviews.errors.map((e) => ({ stage: "formal-review", ...e })));
        } catch (error) { item.errors.push({ stage: "formal-review", reason: error.message }); }
      }
      if(source.buildDispatch){
        try{
          item.buildDispatch=await dispatchApprovedBuilds({config:source.buildDispatch,ciConfigFile:source.configFile,dataDir:path.join(c.dataDir,'build-dispatch',source.id),send,env,fetchImpl,now:currentInstant(),afterStage});
          item.errors.push(...item.buildDispatch.errors.map(e=>({stage:'build-dispatch',...e})),...item.buildDispatch.unknown.map(id=>({stage:'build-dispatch',reason:'续建结果待自动对账，不盲目重复触发',id})));
        }catch(error){item.errors.push({stage:'build-dispatch',reason:error.message});}
      }
    }
    const deploymentErrors = [];
    if (c.deployments) {
      try {
        assert(existsSync(c.deployments.deliveryDir) && lstatSync(c.deployments.deliveryDir).isDirectory(), "登记的部署回流输入队列不存在或未挂载；不能当作空队列");
        result.deployments = await ingestDeploymentDeliveries({ governanceConfigFile: c.governanceConfigFile, stateFile: c.stateFile, receiptPrivateKeyFile: c.receiptPrivateKeyFile, deliveryDir: c.deployments.deliveryDir, dataDir: path.join(c.dataDir, "deployments"), configs: c.deployments.configs, now: currentInstant() });
        deploymentErrors.push(...result.deployments.errors.map((e) => ({ stage: "deployment", ...e })));
      } catch (error) { deploymentErrors.push({ stage: "deployment", reason: error.message }); }
    }
    // Queue-level errors may not have a trustworthy project identity yet. Alert
    // one registered source per project, rather than trusting malformed input or
    // silently logging a failed deployment/publication consumer.
    const deploymentAlerted = new Set();
    for (const [index, source] of c.sources.entries()) {
      const item = result.sources[index];
      if (deploymentErrors.length && !deploymentAlerted.has(source.config.project)) { item.errors.push(...deploymentErrors); deploymentAlerted.add(source.config.project); }
      const health = Object.hasOwn(state.health, source.id) ? state.health[source.id] : (state.health[source.id] = {}), previousStatus = health?.status;
      assert(health && typeof health === "object" && !Array.isArray(health) && (health.status === undefined || ["attention", "ok"].includes(health.status)) && (health.sequence === undefined || Number.isSafeInteger(health.sequence) && health.sequence >= 0), "采集健康状态损坏，禁止重置");
      if (item.errors.length && previousStatus !== "attention") health.firstFailureAt = new Date(now).toISOString();
      health.at = new Date(now).toISOString(); health.status = item.errors.length ? "attention" : "ok"; health.errors = item.errors;
      // Journal signed health facts before ingest so a crash cannot silently
      // lose the first outage. Old schema-1 health rows gain these fields lazily.
      const ingestHealth = async () => {
        const pending = health.pendingNotification;
        if (!pending) return;
        if (!alreadyIngested(pending.receiptFile, pending.sourceFile)) {
          const original = readControlledJson(pending.sourceFile);
          if (now - Date.parse(original.observedAt) > 23 * 3600000) {
            health.expiredNotification = pending; delete health.pendingNotification; checkpoint(); return;
          }
          pending.receiptFile = refreshReceipt(pending.receiptFile, `${source.id}/health`); checkpoint();
          ingestLifecycleGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, eventFile: pending.receiptFile, sourceFile: pending.sourceFile, now });
        }
        await afterStage("source-health-ingested", { source: source.id, status: pending.status });
        health.notification = pending; delete health.pendingNotification; checkpoint();
      };
      try {
        await ingestHealth();
        const notification = health.notification, status = item.errors.length ? "attention" : "recovered";
        if (notification) assert(alreadyIngested(notification.receiptFile, notification.sourceFile), "中央采集健康台账与执行缓存不一致；不能将已丢失提醒当作已入账");
        const reminderDue = status === "attention" && notification?.status === status && now - Date.parse(notification.at) >= c.governance.sla.escalationMinutes * 60000;
        if (status === "attention" && (!notification || notification.status !== status || reminderDue) || status === "recovered" && notification?.status === "attention") {
          health.firstFailureAt ||= new Date(now).toISOString();
          health.sequence = (health.sequence ?? notification?.sequence ?? 0) + 1;
          assert(Number.isSafeInteger(health.sequence) && health.sequence > 0, "采集健康通知序号损坏");
          const sourceFile = writeExclusiveJson(path.join(tickDir, source.id, `health-${health.sequence}.source.json`), {
            schemaVersion: 1, kind: "automation-source-health", executionId, sourceId: source.id, project: source.config.project, scope: source.config.scope,
            status, observedAt: new Date(now).toISOString(), firstFailureAt: health.firstFailureAt,
            errorCount: item.errors.length, errorStages: [...new Set(item.errors.map((e) => e.stage))].sort(),
            failedRunIds: [...new Set(item.errors.map((e) => e.runId).filter((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0).map(String))].sort(),
          });
          const original = readControlledJson(sourceFile), payload = { schemaVersion: 1, kind: "lifecycle-event", eventId: `health-${source.id.slice(0, 70)}-${health.sequence}-${randomUUID()}`,
            category: "collection", project: source.config.project, scope: source.config.scope, lane: source.id, sourceId: source.id, executionId, status, sequence: health.sequence,
            errorCount: original.errorCount, errorStages: original.errorStages, firstFailureAt: original.firstFailureAt, occurredAt: original.observedAt,
            reportUrl: c.governance.projects[source.config.project].issueBaseUrl,
            source: { system: source.config.system, recordId: executionId, recordHash: hash(readFileSync(sourceFile)), observedAt: original.observedAt, url: source.config.baseUrl } };
          health.pendingNotification = { status, sequence: health.sequence, at: original.observedAt, eventId: payload.eventId, sourceFile, receiptFile: sign(payload, `${source.id}/health-${health.sequence}`) };
          checkpoint(); await ingestHealth();
        }
      } catch (error) { item.errors.push({ stage: "source-health", reason: error.message }); }
      if (item.errors.length) { health.status = "attention"; health.firstFailureAt ||= new Date(now).toISOString(); }
      checkpoint();
      result.errors.push(...item.errors.map((e) => ({ source: source.id, ...e })));
    }
    // A source outage still leaves a durable health result and allows retries /
    // SLA escalation / other projects' pending notifications to make progress.
    try {
      reconcileGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, expectationsFile: sign({ schemaVersion: 1, kind: "pipeline-expectations", eventId: `sla-${randomUUID()}`, expectedRuns: Object.values(state.runs).filter(r=>r.qualitySource!==false).flatMap((r) => Object.values(r.revisions || {}).map((p) => ({ project: r.project, scope: r.scope, sha: r.sha, pipelineId: r.pipelineId, sequence: p.sequence, pipelineUrl: r.pipelineUrl, dueAt: r.dueAt }))) }, "all-expectations"), now });
      result.delivery = await dispatchGovernance({ configFile: c.governanceConfigFile, stateFile: c.stateFile, includeDigest: true, send, env, fetchImpl, now: currentInstant() });
      if (result.delivery.results?.some((r) => r.status !== "delivered") || result.delivery.deadLetters?.length || result.delivery.unknownDeliveries?.length) result.errors.push({ stage: "delivery", reason: "消息存在待恢复投递；查看认证操作入口" });
    } catch (error) { result.errors.push({ stage: "outbox", reason: error.message }); }
    result.status = result.errors.length ? "attention" : "ok";
    state.history.push({ executionId, at: result.startedAt, status: result.status, errors: result.errors }); if (state.history.length > 100) state.history.splice(0, state.history.length - 100);
    writeExclusiveJson(path.join(tickDir, "result.json"), result); return result;
  });
}

export function startAutomation({ configFile, send = false, onResult = (result) => process.stdout.write(JSON.stringify(result) + "\n"), ...options }) {
  const c = loadAutomationConfig(configFile); let stopped = false, timer, inFlight = Promise.resolve();
  const next = () => {
    if (stopped) return inFlight;
    inFlight = (async () => {
      let result;
      try { result = await automationTick({ configFile, send, ...options }); }
      catch (error) { result = { status: "attention", stage: "scheduler", reason: error.message }; }
      // The result handler can be asynchronous. Drain it together with the tick
      // before acknowledging stop; a failed handler must not create an unhandled
      // rejection or schedule more work whose result cannot be reported.
      try { await onResult(result); }
      catch { stopped = true; result = { status: "attention", stage: "result-handler", reason: "调度结果回调失败；已停止后续周期" }; }
      if (!stopped) timer = setTimeout(next, c.intervalSeconds * 1000);
      return result;
    })();
    return inFlight;
  };
  next();
  return { stop() {
    // Already-issued network requests and journaled actions cannot be undone.
    // Stop new cycles immediately, then finish the current bounded transaction.
    stopped = true; clearTimeout(timer); return inFlight;
  } };
}
