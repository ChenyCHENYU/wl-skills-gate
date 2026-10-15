import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { loadCiSourceConfig } from "./ci-source.js";
import { loadGovernanceConfig, readGovernanceState, signPlatformReceipt, ingestLifecycleGovernance } from "./governance.js";
import { inspectCiObservation, createReviewLifecycle } from "./lifecycle-source.js";
import { verifyReview } from "./evidence.js";
import { controlledPath, readControlledJson, writeExclusiveJson, lockedJson } from "./control-store.js";
import { stableStringify } from "./util.js";
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (v) => createHash("sha256").update(v).digest("hex");
const inside = (root, file) => { const rel = path.relative(controlledPath(root), controlledPath(file)); assert(rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel), "正式Review原件越出批准证据根"); return file; };

// The publisher owns the Review key. This reader has only its public key plus
// the event key, and independently verifies before emitting a formal fact.
export async function ingestReviewPublications({ configFile, stateFile, receiptPrivateKeyFile, ciConfigFile, publication, dataDir, now = Date.now(), afterStage = () => {} }) {
  const config = loadGovernanceConfig(configFile), ci = loadCiSourceConfig(ciConfigFile), scope = config.projects[ci.project]?.scopes[ci.scope];
  assert(scope && publication && /^[a-f0-9]{64}$/.test(publication.expectReviewPolicyHash || "") && publication.expectAuthorizationIssuer, "正式Review读取缺少批准项目/范围/策略/身份方");
  const settings = { ...publication };
  for (const key of ["manifestDir", "publicKeyFile", "authorizationPublicKeyFile", "evidenceRoot"]) settings[key] = controlledPath(settings[key]);
  const binding = hash(stableStringify({ ci, settings, scope, reviewKey: hash(readFileSync(settings.publicKeyFile)), authorizationKey: hash(readFileSync(settings.authorizationPublicKeyFile)) }));
  return lockedJson(path.join(dataDir, "publication-state.json"), { schemaVersion: 1, binding, records: {}, canonical: {} }, async (state, checkpoint) => {
    assert(state.schemaVersion === 1 && state.binding === binding && state.records, "正式Review读取配置或状态变化，不能重置旧账");
    state.canonical ??= {};
    const result = { status: "ok", ingested: [], reused: [], errors: [] };
    if (!existsSync(settings.manifestDir)) return result;
    const names = readdirSync(settings.manifestDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)); assert(names.length <= 10000, "正式Review交付清单超出预算，请受控归档已结项记录");
    for (const name of names) {
      try {
        const manifestFile = controlledPath(path.join(settings.manifestDir, name)), manifestHash = hash(readFileSync(manifestFile)), m = readControlledJson(manifestFile);
        if (m.project !== ci.project || m.scope !== ci.scope) continue;
        assert(m.schemaVersion === 1 && m.kind === "published-review-manifest" && path.resolve(m.ciConfigFile) === path.resolve(ciConfigFile) && typeof m.publicationId === "string" && name === hash(m.publicationId) + ".json", "正式Review清单身份与固定CI不一致");
        inside(settings.evidenceRoot, m.recordFile); inside(settings.evidenceRoot, path.join(m.evidenceRoot, ".scope"));
        assert(hash(readFileSync(controlledPath(m.recordFile))) === m.recordHash, "正式Review文件被替换");
        let progress = state.records[m.publicationId];
        if (progress) {
          assert(progress.manifestHash === manifestHash && progress.recordHash === m.recordHash, "同授权的正式Review交付发生变化");
          if (["ingested", "duplicate"].includes(progress.status)) {
            const canonical = progress.status === "duplicate" ? state.records[progress.canonicalPublicationId] : progress;
            assert(canonical?.status === "ingested" && canonical.receiptFile, "正式Review原入账缓存损坏");
            const payload = readControlledJson(canonical.receiptFile).payload, known = readGovernanceState({ configFile, stateFile }).events[payload.eventId];
            assert(known && known.digest === canonical.payloadHash && hash(stableStringify(payload)) === canonical.payloadHash, "正式Review台账事件缺失或与缓存不一致；请恢复配套台账后重试");
            result.reused.push(m.publicationId); continue;
          }
          const pending = readControlledJson(progress.receiptFile).payload, known = readGovernanceState({ configFile, stateFile }).events[pending.eventId];
          if (known) {
            assert(known.digest === progress.payloadHash && hash(stableStringify(pending)) === known.digest && hash(readFileSync(controlledPath(progress.lifecycle.sourceFile))) === pending.source.recordHash, "已入账正式Review回执/原件冲突");
            const formal = readControlledJson(m.recordFile);
            assert(pending.reportHash === formal.bodyDigest && pending.evidenceHash === formal.evidenceDigest && pending.sha === m.candidateSha, "已入账正式Review正文关联冲突");
            state.canonical[hash(stableStringify([ci.project, ci.scope, m.candidateSha, formal.reviewDigest, formal.bodyDigest, formal.evidenceDigest]))] = m.publicationId;
            progress.status = "ingested"; checkpoint(); result.reused.push(m.publicationId); continue;
          }
        }
        const record = readControlledJson(m.recordFile);
        assert(config.projects[ci.project].reviewers.includes(record.reviewerId), "正式Review复核人未登记");
        const pins = { project: ci.project, sha: m.candidateSha, publicKeyFile: settings.publicKeyFile, authorizationPublicKeyFile: settings.authorizationPublicKeyFile, expectAuthorizationIssuer: settings.expectAuthorizationIssuer, evidenceRoot: m.evidenceRoot, expectReviewPolicyHash: settings.expectReviewPolicyHash, expectPolicyHash: scope.policyHash, expectRulesHash: scope.rulesHash, expectBaselineHash: scope.baselineHash, expectWaiversHash: scope.waiversHash, profile: settings.profile || "standard", env: settings.env, now: new Date(now) };
        const { value } = inspectCiObservation({ configFile: ciConfigFile, sourceFile: m.sourceFile, sha: m.candidateSha, now });
        assert(hash(readFileSync(controlledPath(m.sourceFile))) === m.sourceHash && value.project === ci.project && value.scope === ci.scope && value.authorId === record.authorId, "正式Review当前CI原件/作者不一致");
        verifyReview({ ...pins, recordFile: m.recordFile });
        const canonicalKey = hash(stableStringify([ci.project, ci.scope, m.candidateSha, record.reviewDigest, record.bodyDigest, record.evidenceDigest]));
        const previousPublication = state.canonical[canonicalKey];
        if (previousPublication && previousPublication !== m.publicationId) {
          assert(state.records[previousPublication]?.status === "ingested", "同份正式Review原入账进度未完成，稍后重试");
          state.records[m.publicationId] = { manifestHash, recordHash: m.recordHash, status: "duplicate", canonicalPublicationId: previousPublication }; checkpoint(); result.reused.push(m.publicationId); continue;
        }
        const base = Number(value.runId) * 10000, generation = value.sequence - base;
        assert(Number.isSafeInteger(base) && Number.isSafeInteger(generation) && generation > 0 && generation <= 4999 && Number.isSafeInteger(base + generation * 2), "正式Review阶段顺序无法绑定中央运行generation");
        if (!progress) {
          const outDir = path.join(dataDir, hash(m.publicationId), randomUUID());
          const lifecycle = createReviewLifecycle({ ...pins, now, configFile: ciConfigFile, sourceFile: m.sourceFile, recordFile: m.recordFile, evidenceRoot: m.evidenceRoot, sha: m.candidateSha, sequence: base + generation * 2, reportUrl: `${new URL(config.projects[ci.project].issueBaseUrl).origin}/reviews/${m.registrationId}`, outDir });
          const payload = readControlledJson(lifecycle.eventFile), receiptFile = writeExclusiveJson(path.join(outDir, "receipt.json"), signPlatformReceipt(payload, { privateKeyFile: receiptPrivateKeyFile, issuer: config.issuer, createdAt: new Date(now).toISOString() }));
          progress = state.records[m.publicationId] = { manifestHash, recordHash: m.recordHash, lifecycle, receiptFile, payloadHash: hash(stableStringify(payload)), status: "prepared" }; checkpoint();
        }
        const envelope = readControlledJson(progress.receiptFile), payload = envelope.payload;
        assert(hash(stableStringify(payload)) === progress.payloadHash && hash(readFileSync(controlledPath(progress.lifecycle.sourceFile))) === payload.source.recordHash, "待入账正式Review回执或原件变化");
        const known = readGovernanceState({ configFile, stateFile }).events[payload.eventId];
        if (known) assert(known.digest === progress.payloadHash, "已入账正式Review内容冲突");
        else ingestLifecycleGovernance({ configFile, stateFile, eventFile: progress.receiptFile, sourceFile: progress.lifecycle.sourceFile, now });
        await afterStage("formal-review-ingested", { publicationId: m.publicationId });
        progress.status = "ingested"; state.canonical[canonicalKey] = m.publicationId; checkpoint(); result.ingested.push(m.publicationId);
      } catch (error) { result.errors.push({ manifest: name, reason: error.message }); }
    }
    result.status = result.errors.length ? "attention" : "ok"; return result;
  });
}
