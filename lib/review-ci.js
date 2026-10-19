import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { controlledPath, readControlledJson } from './control-store.js';
import { inspectCiObservation } from './lifecycle-source.js';
import { loadReviewCollectorConfig, collectReviewEvidence, verifyCollectedReview } from './review-collect.js';
import { loadControlConfig, registerControlReview } from './control-service.js';
import { buildReviewInput, createReviewDraft, validateReviewPolicy } from './review.js';
import { SHA_PATTERN, safePath } from './source-state.js';
import { stableStringify } from './util.js';
import { extendCollectedReview } from './review-additions.js';
import { assertCollectorApproved } from './review-collectors.js';
const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const relative = (value) => typeof value === 'string' && value && !path.isAbsolute(value) && !/[\\\u0000-\u001f?#%]/.test(value) && value.split('/').every((p) => p && p !== '.' && p !== '..');
function artifact(sourceFile, value, name) {
  assert(relative(name), 'Review CI工件路径必须固定且不得越界');
  const entry = value.artifacts.find((a) => a.path === name); assert(entry, `Review CI缺少原始工件: ${name}`);
  const file = safePath(realpathSync(path.join(path.dirname(sourceFile), 'artifacts')), name); assert(lstatSync(file).isFile(), 'Review CI工件不是普通文件');
  const bytes = readFileSync(file); assert(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'Review CI工件字节/摘要变化'); return bytes;
}
function branch(value) {
  assert(typeof value === 'string' && value && spawnSync('git', ['check-ref-format', '--branch', value], { encoding: 'utf8' }).status === 0, '固定Review分支无效'); return value;
}

// Central automation calls this once per verified CI observation. Developers do
// not construct manifests, author identity or JSON approval flags themselves.
export async function createCiReview({ configFile, sourceFile, outDir, now = Date.now() }) {
  configFile = controlledPath(configFile); sourceFile = controlledPath(sourceFile);
  const config = readControlledJson(configFile), base = path.dirname(configFile);
  assert(config.schemaVersion === 1, 'Review CI接线配置版本无效');
  for (const key of ['collectorConfigFile', 'reviewPolicyFile', 'controlConfigFile']) {
    assert(typeof config[key] === 'string' && config[key], `Review CI缺少固定配置: ${key}`); config[key] = controlledPath(path.resolve(base, config[key]));
  }
  const collector = loadReviewCollectorConfig(config.collectorConfigFile), control = loadControlConfig(config.controlConfigFile), approved = control.reviewPolicies[collector.project];
  assert(approved && approved.policyHash === collector.reviewPolicyHash, 'Review CI未绑定操作服务批准采集配置');
  assertCollectorApproved(approved,config.collectorConfigFile);
  const policyBytes = readFileSync(config.reviewPolicyFile), policy = validateReviewPolicy(JSON.parse(policyBytes), collector.project);
  assert(hash(stableStringify(policy)) === collector.reviewPolicyHash, 'Review CI固定九维策略与批准摘要不符');
  const rawSource = readControlledJson(sourceFile), { config: ci, value } = inspectCiObservation({ configFile: collector.ciConfigFile, sourceFile, sha: rawSource.sha, now });
  assert(value.project === collector.project && collector.allowedAuthorIds.includes(value.authorId), 'Review CI项目/作者不在受控映射中');
  assert(ci.qualitySummary && ci.artifacts.paths.includes(ci.qualitySummary), 'Review CI须固定原始Gate工件');
  const summaryBytes = artifact(sourceFile, value, ci.qualitySummary), summary = JSON.parse(summaryBytes);
  assert(summary.run?.project === value.project && summary.run.commitSha === value.sha && /^[A-Za-z0-9-]{1,128}$/.test(summary.run.eventId || ''), 'Review CI原始Gate项目/候选/事件不匹配');
  let context = {};
  if (config.candidateContextPath !== undefined) {
    assert(relative(config.candidateContextPath) && ci.artifacts.paths.includes(config.candidateContextPath), '候选上下文必须登记为固定CI工件');
    const candidate = JSON.parse(artifact(sourceFile, value, config.candidateContextPath));
    const sourceBranch = branch(config.sourceBranch), targetBranch = branch(config.targetBranch);
    assert(candidate.schemaVersion === 1 && candidate.candidateSha === value.sha && candidate.source === sourceBranch && candidate.target === targetBranch &&
      SHA_PATTERN.test(candidate.sourceSha || '') && SHA_PATTERN.test(candidate.targetBeforeSha || ''), '候选上下文源码/四项/固定分支不一致');
    if (candidate.project !== undefined) assert(candidate.project === value.project, '候选上下文项目不一致');
    context = { sourceBranch, targetBranch, sourceSha: candidate.sourceSha, targetBeforeSha: candidate.targetBeforeSha };
  } else {
    // Fixed branch names without real candidate facts are deliberately not
    // enough to make a promotable Review; all four fields stay visibly null.
    if (config.sourceBranch !== undefined) branch(config.sourceBranch);
    if (config.targetBranch !== undefined) branch(config.targetBranch);
  }
  const facts = (v) => Object.fromEntries(['project', 'scope', 'system', 'sha', 'ref', 'configHash', 'runId', 'jobId', 'jobStatus', 'status', 'authorId', 'requiredJobs', 'artifacts', 'missingArtifacts'].map((key) => [key, v[key] ?? null]));
  const observationFingerprint = hash(stableStringify({ facts: facts(value), gateHash: hash(summaryBytes),
    collectorConfigHash: hash(readFileSync(config.collectorConfigFile)), ciConfigHash: hash(readFileSync(collector.ciConfigFile)),
    policyHash: collector.reviewPolicyHash, configHash: hash(stableStringify(config)), candidateContext: context,
    supplementBindings: collector.supplement ? { governanceConfigHash: hash(readFileSync(collector.supplement.governanceConfigFile)),
      authorizationPublicKeyHash: hash(createPublicKey(readFileSync(collector.supplement.authorizationPublicKeyFile)).export({ type: 'spki', format: 'der' })), authorizationIssuer: collector.supplement.authorizationIssuer } : null }));
  const registrationId = `${summary.run.eventId.slice(0, 115)}-${observationFingerprint.slice(0, 12)}`;
  const catalogFile = path.join(control.dataDir, 'reviews.json'), existing = existsSync(catalogFile) ? readControlledJson(catalogFile).reviews?.[registrationId] : null;
  if (existing) {
    const checked = verifyCollectedReview({ recordFile: existing.recordFile, evidenceRoot: existing.evidenceRoot,
      provenanceFile: existing.provenanceFile, configFile: config.collectorConfigFile, now });
    const previous = readControlledJson(safePath(existing.evidenceRoot, checked.provenance.sourceFile));
    assert(stableStringify(facts(previous)) === stableStringify(facts(value)), 'Review revision指纹冲突，拒绝复用不同CI事实');
    for (const [key, expected] of [['source', context.sourceBranch], ['target', context.targetBranch], ['sourceSha', context.sourceSha], ['targetBeforeSha', context.targetBeforeSha]])
      assert((checked.record[key] ?? null) === (expected ?? null), '同一Gate事件的候选上下文变化，拒绝复用');
    const registration = await registerControlReview({ configFile: config.controlConfigFile, reviewId: registrationId,
      recordFile: existing.recordFile, evidenceRoot: existing.evidenceRoot, provenanceFile: existing.provenanceFile, now });
    return { status: 'pending-confirmation', approved: false, automaticallyApproved: false, registered: true, reused: true,
      reviewId: summary.run.eventId, registrationId, observationFingerprint, url: registration.url, recordFile: existing.recordFile, bodyFile: safePath(existing.evidenceRoot, checked.record.bodyFile),
      reviewDigest: checked.record.reviewDigest, bodyDigest: checked.record.bodyDigest, evidenceDigest: checked.record.evidenceDigest,
      policyHash: checked.record.content.policyHash, dimensions: checked.record.content.dimensions, provenanceFile: existing.provenanceFile,
      candidateContextVerified: !!config.candidateContextPath, promotionAuthorized: false, evidenceRoot: existing.evidenceRoot, identityVerified: true, signed: false };
  }
  const evidenceRoot = realpathSync(approved.evidenceRoot), requested = path.resolve(outDir), rel = path.relative(evidenceRoot, requested).split(path.sep).join('/');
  assert(relative(rel), 'Review CI输出必须位于操作服务批准证据根目录内的新目录');
  const output = safePath(evidenceRoot, rel); mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  let registered = false;
  try {
    const summaryFile = path.join(output, 'quality-summary.json'), policyFile = path.join(output, 'review-policy.json'), inputFile = path.join(output, 'review-input.json');
    writeFileSync(summaryFile, summaryBytes, { flag: 'wx', mode: 0o600 }); writeFileSync(policyFile, policyBytes, { flag: 'wx', mode: 0o600 });
    const input = buildReviewInput({ summaryFile, policyFile, evidenceRoot: output, authorId: value.authorId,
      context: { ...context, source: `${value.system}/trusted-central-ci/${value.runId}/${value.jobId}` } });
    input.reviewId = summary.run.eventId;
    input.unresolvedBlocking = value.requiredJobs.filter((j) => j.status !== 'success').map((j) => `ci-job:${j.name}:${j.id}:${j.status}`);
    // The actual candidate context is evidence too, rather than four scalars
    // copied from automation arguments. It does not grant promotion authority.
    if (config.candidateContextPath) {
      const contextFile = path.join(output, 'candidate-context.json'); writeFileSync(contextFile, artifact(sourceFile, value, config.candidateContextPath), { flag: 'wx', mode: 0o600 });
      input.evidence.push({ id: 'candidate-context', type: 'candidate-context', source: `${ci.system}/${value.runId}/${value.jobId}`, project: value.project, candidateSha: value.sha, file: 'candidate-context.json', dimensionIds: [] });
    }
    writeFileSync(inputFile, json(input), { flag: 'wx', mode: 0o600 });
    const automatic = createReviewDraft({ input, evidenceRoot: output, outDir: path.join(output, 'automatic'), now: new Date(now) });
    const collected = collectReviewEvidence({ configFile: config.collectorConfigFile, sourceFile, inputFile, recordFile: automatic.recordFile, evidenceRoot: output, outDir: path.join(output, 'collected'), now });
    const prepared = collector.supplement ? extendCollectedReview({ configFile: config.collectorConfigFile, recordFile: collected.recordFile,
      evidenceRoot: output, provenanceFile: collected.provenanceFile, outDir: path.join(output, 'central-evidence'), now }) : collected;
    const registration = await registerControlReview({ configFile: config.controlConfigFile, reviewId: registrationId,
      recordFile: prepared.recordFile, evidenceRoot: output, provenanceFile: prepared.provenanceFile, now }); registered = true;
    return { ...prepared, reviewId: input.reviewId, registrationId, observationFingerprint, url: registration.url, registered: true, automaticallyApproved: false,
      candidateContextVerified: !!config.candidateContextPath, promotionAuthorized: false, evidenceRoot: output, automaticRecordFile: automatic.recordFile };
  } catch (error) {
    // Do not erase records that registration might already have committed.
    // A catalog conflict leaves the original version untouched.
    if (!registered) {
      const catalogFile = path.join(control.dataDir, 'reviews.json');
      const entry = existsSync(catalogFile) ? readControlledJson(catalogFile).reviews?.[registrationId] : null;
      if (!entry || !path.resolve(entry.recordFile).startsWith(output + path.sep)) rmSync(output, { recursive: true, force: true });
    }
    throw error;
  }
}
