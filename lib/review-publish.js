import path from 'node:path';
import { readFileSync, readdirSync, lstatSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { controlledPath, readControlledJson, writeExclusiveJson, lockedJson } from './control-store.js';
import { verifyRecord, signReviewRecord, verifyReview } from './evidence.js';
import { loadReviewCollectorConfig, verifyCollectedReview } from './review-collect.js';
import { verifyLiveCiReview } from './review-live.js';
import { inspectCiObservation } from './lifecycle-source.js';
import { validateReviewPolicy } from './review.js';
import { stableStringify } from './util.js';
import { collectorFiles, resolveAdditionalCollectors, collectorFromProvenance, assertCollectorScopes } from './review-collectors.js';
import {managerReviewSatisfied} from './review-responsibility.js';
const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const equal = (a, b) => stableStringify(a) === stableStringify(b);
const publicBytes = (file) => createPublicKey(readFileSync(controlledPath(file))).export({ type: 'spki', format: 'der' });
function within(root, file) {
  root = controlledPath(root); file = controlledPath(file); const rel = path.relative(root, file);
  assert(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel), 'Review签发路径不在项目批准证据根目录内'); return file;
}
export function loadReviewPublishConfig(configFile, env = process.env) {
  configFile = controlledPath(configFile); const c = readControlledJson(configFile), base = path.dirname(configFile);
  assert(c.schemaVersion === 1 && id(c.authorizationIssuer) && c.projects && typeof c.projects === 'object' && !Array.isArray(c.projects) && Object.keys(c.projects).length, 'Review独立签发配置无效');
  for (const field of ['controlCatalogFile', 'authorizationDir', 'stateFile', 'manifestDir', 'reviewPublicKeyFile', 'authorizationPublicKeyFile']) { assert(typeof c[field] === 'string' && c[field], `Review签发缺少固定路径 ${field}`); c[field] = controlledPath(path.resolve(base, c[field])); }
  let privateKeyFile;
  if (c.reviewPrivateKeyEnv !== undefined) { assert(/^[A-Z][A-Z0-9_]+$/.test(c.reviewPrivateKeyEnv) && env[c.reviewPrivateKeyEnv], 'Review独立签名凭据未注入'); privateKeyFile = controlledPath(env[c.reviewPrivateKeyEnv]); }
  else { assert(typeof c.reviewPrivateKeyFile === 'string' && c.reviewPrivateKeyFile, '缺少独立Review签名私钥'); privateKeyFile = controlledPath(path.resolve(base, c.reviewPrivateKeyFile)); }
  const key = createPrivateKey(readFileSync(privateKeyFile)), keyPublic = createPublicKey(key).export({ type: 'spki', format: 'der' });
  assert(key.asymmetricKeyType === 'ed25519' && keyPublic.equals(publicBytes(c.reviewPublicKeyFile)) && !keyPublic.equals(publicBytes(c.authorizationPublicKeyFile)), 'Review签发公私钥不匹配或未与身份授权密钥分离');
  const resolvedPrivate = privateKeyFile;
  for (const [project, p] of Object.entries(c.projects)) {
    assert(id(project) && p && Array.isArray(p.evidenceRoots) && p.evidenceRoots.length && Array.isArray(p.reviewers) && p.reviewers.length && p.reviewers.every(id), 'Review签发项目证据根/复核人未固定');
    p.evidenceRoots = p.evidenceRoots.map((r) => controlledPath(path.resolve(base, r)));
    if(p.requireTechnicalManagerReview!==undefined)assert(typeof p.requireTechnicalManagerReview==='boolean','独立签发经理确认策略须为布尔值');
    if(p.requireTechnicalManagerReview===true)assert(id(p.technicalManager) && p.reviewers.includes(p.technicalManager),'独立签发技术经理确认策略缺少批准经理身份');
    for (const field of ['collectorConfigFile', 'reviewPolicyFile']) { assert(typeof p[field] === 'string' && p[field], `缺少固定项目配置 ${field}`); p[field] = controlledPath(path.resolve(base, p[field])); }
    for (const field of ['reviewPolicyHash', 'policyHash', 'rulesHash', 'baselineHash', 'waiversHash']) assert(/^[a-f0-9]{64}$/.test(p[field] || ''), `Review批准摘要无效 ${field}`);
    resolveAdditionalCollectors(p,base);assertCollectorScopes(p,project);
    for(const collectorFile of collectorFiles(p)) {
    const collector = loadReviewCollectorConfig(collectorFile), policy = validateReviewPolicy(readControlledJson(p.reviewPolicyFile), project);
    assert(collector.project === project && collector.reviewPolicyHash === p.reviewPolicyHash && hash(stableStringify(policy)) === p.reviewPolicyHash, 'Review固定采集器/九维策略与批准摘要不一致');
    }
    p.profile ??= 'standard'; assert(['standard', 'release'].includes(p.profile) && (p.profile !== 'release' || ['dev', 'sit', 'uat', 'pre', 'prd'].includes(p.env)), 'Review固定档位/发布环境无效');
    p.maxAgeMinutes ??= 1440; assert(Number.isSafeInteger(p.maxAgeMinutes) && p.maxAgeMinutes > 0 && p.maxAgeMinutes <= 1440, 'Review签发时效预算无效');
  }
  const binding = hash(stableStringify({ config: c, reviewPublicKeyHash: hash(keyPublic), authorizationPublicKeyHash: hash(publicBytes(c.authorizationPublicKeyFile)) }));
  return { ...c, privateKeyFile: resolvedPrivate, binding };
}
function pins(c, p, project, record, now) {
  return { project, sha: record.candidateSha, profile: p.profile, env: p.env, expectReviewPolicyHash: p.reviewPolicyHash,
    expectPolicyHash: p.policyHash, expectRulesHash: p.rulesHash, expectBaselineHash: p.baselineHash, expectWaiversHash: p.waiversHash,
    publicKeyFile: c.reviewPublicKeyFile, authorizationPublicKeyFile: c.authorizationPublicKeyFile, expectAuthorizationIssuer: c.authorizationIssuer,
    authorId: record.authorId, reviewerId: record.reviewerId, now: new Date(now), maxAgeMinutes: p.maxAgeMinutes };
}
function matchEntry(c, p, catalog, auth, now) {
  const entries = Object.values(catalog.reviews).filter((e) => e.project === auth.project), matches = [];
  for (const entry of entries) {
    assert(p.evidenceRoots.some((root) => { try { within(root, entry.recordFile); within(root, path.join(entry.evidenceRoot, '.scope')); return true; } catch { return false; } }), 'Review目录记录越出批准项目根');
    within(entry.evidenceRoot, entry.recordFile); within(entry.evidenceRoot, entry.provenanceFile);
    const record = readControlledJson(entry.recordFile);
    if (record.reviewDigest !== auth.reviewDigest || record.candidateSha !== auth.candidateSha) continue;
    assert(hash(readFileSync(entry.recordFile)) === entry.recordHash && hash(readFileSync(entry.provenanceFile)) === entry.provenanceHash, 'Review目录正文或来源已变化');
    for (const field of ['bodyDigest', 'evidenceDigest']) assert(record[field] === auth[field], 'Review授权未匹配目录实际正文/证据');
    matches.push({ entry, record });
  }
  assert(matches.length && new Set(matches.map(({ entry }) => entry.recordFile)).size === 1, '身份授权未匹配唯一的已登记Review版本');
  const chosen = matches.sort((a, b) => a.entry.reviewId.localeCompare(b.entry.reviewId))[0];
  if (catalog.latest) {
    const verified = verifyCollectedReview({ configFile: collectorFromProvenance(p,chosen.entry.provenanceFile), recordFile: chosen.entry.recordFile, evidenceRoot: chosen.entry.evidenceRoot, provenanceFile: chosen.entry.provenanceFile, now });
    const current = catalog.latest[`${auth.project}:${verified.scope}:${auth.candidateSha}`];
    if (current !== undefined) assert(current === chosen.entry.reviewId || current.reviewId === chosen.entry.reviewId, '此Review已被新版本替代，不得签发');
  }
  return chosen;
}
function manifestPins(c, p) {
  return { publicKeyFile: c.reviewPublicKeyFile, authorizationPublicKeyFile: c.authorizationPublicKeyFile, expectAuthorizationIssuer: c.authorizationIssuer,
    expectReviewPolicyHash: p.reviewPolicyHash, expectPolicyHash: p.policyHash, expectRulesHash: p.rulesHash,
    expectBaselineHash: p.baselineHash, expectWaiversHash: p.waiversHash, profile: p.profile, ...(p.env ? { env: p.env } : {}), maxAgeMinutes: p.maxAgeMinutes };
}
function reusePublished(c, p, progress, auth, authDigest) {
  assert(progress.authorizationDigest === authDigest && progress.manifestFile === path.join(c.manifestDir, `${hash(auth.authorizationId)}.json`), '已发布授权/checkpoint身份变化');
  const manifest = readControlledJson(progress.manifestFile), formal = readControlledJson(progress.recordFile), catalog = readControlledJson(c.controlCatalogFile);
  assert(p.evidenceRoots.some((root) => { try { within(root, progress.recordFile); within(root, path.join(manifest.evidenceRoot, '.scope')); return true; } catch { return false; } }) &&
    progress.recordFile === path.join(manifest.evidenceRoot, 'signed-reviews', `${hash(auth.authorizationId)}.json`), '历史正式Review路径越出批准根');
  assert(hash(readFileSync(progress.manifestFile)) === progress.manifestHash && hash(readFileSync(progress.recordFile)) === progress.recordHash &&
    manifest.recordHash === progress.recordHash && manifest.authorizationDigest === authDigest && manifest.recordFile === progress.recordFile && manifest.project === auth.project, '已发布Review/manifest字节变化');
  const entry = catalog.reviews?.[manifest.registrationId];
  assert(entry && entry.evidenceRoot === manifest.evidenceRoot, '历史Review目录证据根变化');
  within(manifest.evidenceRoot, entry.recordFile); within(manifest.evidenceRoot, entry.provenanceFile);
  assert(entry && entry.recordFile === progress.draftRecordFile && entry.project === auth.project && hash(readFileSync(controlledPath(entry.recordFile))) === entry.recordHash &&
    hash(readFileSync(controlledPath(entry.provenanceFile))) === entry.provenanceHash && entry.provenanceHash === manifest.provenanceHash, '已发布Review的原目录/来源字节变化');
  assert(equal(formal.authorization, auth) && formal.reviewDigest === auth.reviewDigest, '历史正式Review与原身份授权不一致');
  // Completed work is history. Verify its original immutable evidence as of
  // publication, without treating old CI observation age as a new failure.
  verifyReview({ ...pins(c, p, auth.project, formal, Date.parse(formal.signedAt)), recordFile: progress.recordFile, evidenceRoot: manifest.evidenceRoot });
}

// This consumer never loads control-service/IdP or event signing credentials.
// One bad authorization cannot stop another project from publishing its record.
export async function publishReviewAuthorizations({ configFile, env = process.env, fetchImpl = fetch, now = Date.now(), afterStage = async () => {} }) {
  const startedWallTime = Date.now(), instant = () => now + Math.max(0, Date.now() - startedWallTime);
  const c = loadReviewPublishConfig(configFile, env); mkdirSync(c.manifestDir, { recursive: true, mode: 0o700 });
  assert(lstatSync(c.authorizationDir).isDirectory(), 'Review授权目录不存在或无效');
  return lockedJson(c.stateFile, { schemaVersion: 1, kind: 'review-publication-state', configHash: c.binding, authorizations: {}, failures: {} }, async (state, checkpoint) => {
    assert(state.schemaVersion === 1 && state.kind === 'review-publication-state' && state.configHash === c.binding && state.authorizations && state.failures, 'Review签发checkpoint配置/状态损坏');
    const result = { status: 'ok', published: [], reused: [], skipped: [], errors: [], manifestDir: c.manifestDir };
    const files = readdirSync(c.authorizationDir).filter((name) => name.endsWith('.json')).sort();
    for (const name of files) {
      let authorizationFile, auth, progress;
      try {
        authorizationFile = controlledPath(path.join(c.authorizationDir, name)); assert(lstatSync(authorizationFile).isFile(), '授权必须为受控普通JSON文件');
        auth = readControlledJson(authorizationFile); verifyRecord(auth, c.authorizationPublicKeyFile);
        if (auth.schemaVersion === 1 && auth.kind === 'deployment-authorization' && auth.scope === 'deployment-execute' && auth.issuer === c.authorizationIssuer && id(auth.authorizationId)) {
          result.skipped.push({ authorizationId: auth.authorizationId, reason: 'handled-by-deployment-consumer' }); continue;
        }
        assert(auth.kind === 'review-authorization' && id(auth.authorizationId) && Object.hasOwn(c.projects, auth.project), '授权类型/编号/项目无效');
        let p = c.projects[auth.project]; assert(p.reviewers.includes(auth.actorId), '此身份不在项目批准复核人清单');
        assert(managerReviewSatisfied(p,auth),'独立签发拒绝未满足技术经理责任的Review授权');
        const authDigest = hash(stableStringify(auth)); progress = state.authorizations[auth.authorizationId];
        if (progress?.status === 'published') {
          reusePublished(c, p, progress, auth, authDigest);
          result.reused.push({ authorizationId: auth.authorizationId, manifestFile: progress.manifestFile, recordFile: progress.recordFile }); continue;
        }
        const catalog = readControlledJson(c.controlCatalogFile); assert(catalog.schemaVersion === 1 && catalog.reviews && !Array.isArray(catalog.reviews), 'Review只读目录损坏');
        const { entry, record } = matchEntry(c, p, catalog, auth, instant());
        p={...p,collectorConfigFile:collectorFromProvenance(p,entry.provenanceFile)};
        const validated = verifyCollectedReview({ configFile: p.collectorConfigFile, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot, provenanceFile: entry.provenanceFile, now });
        const expected = pins(c, p, auth.project, { ...record, reviewerId: auth.actorId }, now);
        progress = state.authorizations[auth.authorizationId];
        assert(!progress || progress.authorizationDigest === authDigest && progress.draftRecordFile === entry.recordFile, '同一授权编号的正文/授权字节已变化');
        if (!progress) {
          const stem = hash(auth.authorizationId), recordFile = within(entry.evidenceRoot, path.join(entry.evidenceRoot, 'signed-reviews', `${stem}.json`)), manifestFile = path.join(c.manifestDir, `${stem}.json`);
          progress = state.authorizations[auth.authorizationId] = { authorizationId: auth.authorizationId, authorizationDigest: authDigest,
            draftRecordFile: entry.recordFile, recordFile, manifestFile, status: 'prepared', attempts: 0 };
          checkpoint();
        }
        assert(progress.recordFile === path.join(entry.evidenceRoot, 'signed-reviews', `${hash(auth.authorizationId)}.json`) &&
          progress.manifestFile === path.join(c.manifestDir, `${hash(auth.authorizationId)}.json`) &&
          ['prepared', 'checking', 'retryable', 'published'].includes(progress.status) && Number.isSafeInteger(progress.attempts) && progress.attempts >= 0, 'Review签发checkpoint路径/状态损坏');
        progress.attempts++; progress.status = 'checking'; delete progress.error; checkpoint();
        // Validate the explicit non-author nine-dimension authorization before
        // making remote requests; no publication exists at this point.
        if (existsSync(progress.recordFile)) {
          const historical = verifyReview({ ...expected, recordFile: progress.recordFile, evidenceRoot: entry.evidenceRoot });
          assert(equal(historical.authorization, auth) && historical.reviewDigest === record.reviewDigest, '待恢复正式Review不属于本授权');
        } else signReviewRecord({ ...expected, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot,
          privateKeyFile: c.privateKeyFile, authorizationFile });
        const live = await verifyLiveCiReview({ configFile: p.collectorConfigFile, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot,
          provenanceFile: entry.provenanceFile, outDir: path.join(c.manifestDir, 'live-checks', randomUUID()), env, fetchImpl, now: instant() });
        progress.liveSourceFile = live.sourceFile; checkpoint(); await afterStage('live-verified', { authorizationId: auth.authorizationId });
        // Re-read catalog immediately before signing. Content replacement or
        // explicit supersession during the CI await cannot reuse old approval.
        const latest = matchEntry(c, p, readControlledJson(c.controlCatalogFile), auth, instant());
        assert(equal(latest.entry, entry), '签发期间Review目录版本变化');
        assert(hash(stableStringify(readControlledJson(authorizationFile))) === authDigest, '签发期间身份授权已变化，拒绝串用');
        expected.now = new Date(instant());
        let formal;
        if (existsSync(progress.recordFile)) {
          formal = verifyReview({ ...expected, recordFile: progress.recordFile, evidenceRoot: entry.evidenceRoot });
          assert(equal(formal.authorization, auth) && formal.reviewDigest === record.reviewDigest, '已有正式Review不属于本授权，禁止覆盖');
        } else {
          formal = signReviewRecord({ ...expected, recordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot, privateKeyFile: c.privateKeyFile, authorizationFile });
          writeExclusiveJson(progress.recordFile, formal);
        }
        verifyReview({ ...expected, recordFile: progress.recordFile, evidenceRoot: entry.evidenceRoot });
        assert(equal(formal.authorization, auth), '正式Review没有绑定本轮原始授权');
        progress.recordHash = hash(readFileSync(progress.recordFile)); checkpoint(); await afterStage('record-written', { authorizationId: auth.authorizationId });
        const manifest = { schemaVersion: 1, kind: 'published-review-manifest', publicationId: auth.authorizationId,
          registrationId: entry.reviewId, project: auth.project, scope: validated.scope, candidateSha: record.candidateSha,
          authorId: record.authorId, reviewerId: auth.actorId, createdAt: formal.signedAt, recordFile: progress.recordFile,
          recordHash: progress.recordHash, draftRecordFile: entry.recordFile, evidenceRoot: entry.evidenceRoot,
          provenanceFile: entry.provenanceFile, provenanceHash: entry.provenanceHash, authorizationFile, authorizationDigest: authDigest,
          sourceFile: progress.liveSourceFile, sourceHash: hash(readFileSync(progress.liveSourceFile)), collectorConfigFile: p.collectorConfigFile,
          ciConfigFile: loadReviewCollectorConfig(p.collectorConfigFile).ciConfigFile, ...manifestPins(c, p),
          repairAuthorized: false, promotionAuthorized: false, deploymentAuthorized: false, closureAuthorized: false };
        assert(hash(readFileSync(progress.recordFile)) === progress.recordHash, '正式Review在归档前变化，拒绝交付');
        if (existsSync(progress.manifestFile)) {
          const old = readControlledJson(progress.manifestFile);
          for (const key of Object.keys(manifest).filter((key) => !['sourceFile', 'sourceHash', 'authorizationFile'].includes(key))) assert(equal(old[key], manifest[key]), '已有Review交付manifest不属于本授权，禁止覆盖');
          const source = inspectCiObservation({ configFile: manifest.ciConfigFile, sourceFile: old.sourceFile, sha: record.candidateSha, now });
          assert(source.value.authorId === record.authorId && hash(readFileSync(old.sourceFile)) === old.sourceHash, '已有Review manifest当前来源损坏');
          for (const key of ['project', 'scope', 'system', 'sha', 'ref', 'configHash', 'runId', 'jobId', 'jobStatus', 'status', 'authorId', 'requiredJobs', 'artifacts', 'missingArtifacts'])
            assert(equal(source.value[key], validated.observation[key]), '已有Review manifest来源事实与已批准原件不一致');
        } else writeExclusiveJson(progress.manifestFile, manifest);
        await afterStage('manifest-written', { authorizationId: auth.authorizationId });
        assert(hash(readFileSync(progress.recordFile)) === progress.recordHash, '正式Review在交付确认前变化');
        progress.status = 'published'; progress.manifestHash = hash(readFileSync(progress.manifestFile)); progress.publishedAt = formal.signedAt; checkpoint();
        result.published.push({ authorizationId: auth.authorizationId, manifestFile: progress.manifestFile, recordFile: progress.recordFile });
      } catch (error) {
        const failure = { authorizationFile: authorizationFile || path.join(c.authorizationDir, name), authorizationId: auth?.authorizationId || null,
          reason: error.message, at: new Date(now).toISOString(), published: false };
        if (progress) { progress.status = 'retryable'; progress.error = failure; }
        state.failures[hash(name)] = failure; checkpoint(); result.errors.push(failure);
      }
    }
    result.status = result.errors.length ? result.published.length || result.reused.length ? 'partial' : 'attention' : 'ok';
    return result;
  });
}
