import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { controlledPath, readControlledJson } from './control-store.js';
import { inspectCiObservation } from './lifecycle-source.js';
import { REVIEW_DIMENSIONS, supplementReviewDraft, validateReviewDraftIntegrity } from './review.js';
import { safePath } from './source-state.js';
import { stableStringify } from './util.js';
import { verifyExtendedCollectedReview } from './review-additions.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const equal = (a, b) => stableStringify(a) === stableStringify(b);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const relative = (value) => typeof value === 'string' && value && !path.isAbsolute(value) && !/[\\\u0000-\u001f?#%]/.test(value) && value.split('/').every((p) => p && p !== '.' && p !== '..');
const fileIn = (root, relativeFile) => { assert(relative(relativeFile), '采集证据必须使用根目录内明确相对文件'); const file = safePath(root, relativeFile); assert(lstatSync(file).isFile(), '采集证据必须是普通文件'); return file; };
const inRoot = (root, file) => { const relativeFile = path.relative(root, controlledPath(file)).split(path.sep).join('/'); fileIn(root, relativeFile); return relativeFile; };

export function loadReviewCollectorConfig(configFile) {
  configFile = controlledPath(configFile);
  const c = readControlledJson(configFile), base = path.dirname(configFile);
  assert(c.schemaVersion === 1 && id(c.project) && /^[a-f0-9]{64}$/.test(c.reviewPolicyHash || ''), 'Review采集配置项目/批准策略无效');
  c.ciConfigFile = controlledPath(path.resolve(base, c.ciConfigFile || ''));
  assert(Array.isArray(c.allowedAuthorIds) && c.allowedAuthorIds.length && c.allowedAuthorIds.every(id) && !c.allowedAuthorIds.includes('unverified-local-author') && new Set(c.allowedAuthorIds).size === c.allowedAuthorIds.length, 'Review作者必须登记受控SCM身份映射，不能使用占位作者');
  assert(Array.isArray(c.evidence) && new Set(c.evidence.map((e) => e.id)).size === c.evidence.length, 'Review采集证据映射重复或无效');
  for (const e of c.evidence) assert(id(e.id) && typeof e.type === 'string' && e.type.trim() && e.type !== 'gate-summary' && relative(e.path) &&
    Array.isArray(e.dimensionIds) && e.dimensionIds.length && new Set(e.dimensionIds).size === e.dimensionIds.length && e.dimensionIds.every((d) => REVIEW_DIMENSIONS.some((known) => known.id === d)), 'Review采集映射必须固定工件路径、类型、维度，不能替换Gate原件');
  if (c.supplement !== undefined) {
    assert(c.supplement && typeof c.supplement === 'object' && !Array.isArray(c.supplement) && id(c.supplement.authorizationIssuer), 'Review补证须固定认证签发者');
    for (const key of ['governanceConfigFile', 'authorizationPublicKeyFile']) {
      assert(typeof c.supplement[key] === 'string' && c.supplement[key], `Review补证缺少固定配置: ${key}`);
      c.supplement[key] = controlledPath(path.resolve(base, c.supplement[key]));
    }
  }
  return c;
}

function inspected({ configFile, sourceFile, recordFile, evidenceRoot, now }) {
  const c = loadReviewCollectorConfig(configFile); inRoot(evidenceRoot, recordFile);
  const record = readControlledJson(recordFile); validateReviewDraftIntegrity(record, { evidenceRoot });
  assert(record.project === c.project && record.content.policyHash === c.reviewPolicyHash, 'Review不属于批准采集项目/九维策略');
  const { config: ci, value } = inspectCiObservation({ configFile: c.ciConfigFile, sourceFile, sha: record.candidateSha, now });
  assert(ci.project === c.project && c.allowedAuthorIds.includes(value.authorId), 'CI作者不在受控员工映射中');
  assert(record.authorId === 'unverified-local-author' || record.authorId === value.authorId, '已知作者与可信CI身份冲突，禁止重新归属');
  assert(ci.qualitySummary && ci.artifacts.paths.includes(ci.qualitySummary), 'Review采集须固定同轮原始Gate报告');
  const readArtifact = (relativeFile) => {
    const entry = value.artifacts.find((a) => a.path === relativeFile); assert(entry, `固定CI工件未采集: ${relativeFile}`);
    const file = fileIn(realpathSync(path.join(path.dirname(sourceFile), 'artifacts')), relativeFile), bytes = readFileSync(file);
    assert(bytes.length === entry.bytes && hash(bytes) === entry.sha256, `CI工件原始字节或摘要变化: ${relativeFile}`);
    return { entry, bytes };
  };
  const current = record.content.evidence.filter((e) => e.type === 'gate-summary' && e.role === 'current');
  assert(current.length === 1, '原自动草稿须保留唯一当前Gate证据');
  const gate = readArtifact(ci.qualitySummary);
  assert(gate.entry.sha256 === current[0].sha256, '可信CI与原自动草稿不是同份Gate报告，禁止混用候选证据');
  const collected = [], missing = [];
  for (const spec of c.evidence) {
    assert(ci.artifacts.paths.includes(spec.path), `Review工件未在固定CI来源登记: ${spec.path}`);
    if (!value.artifacts.some((a) => a.path === spec.path)) {
      const missingFact = value.missingArtifacts.find((a) => a.path === spec.path);
      const optionalMissing = ci.artifacts.optionalPaths?.includes(spec.path) && missingFact?.reason === 'optional-unavailable';
      const failedMissing = value.jobStatus === 'failed' && ['not-archived', 'download-unavailable'].includes(missingFact?.reason);
      assert(optionalMissing || failedMissing, `Review工件无可信缺失记录: ${spec.path}`);
      missing.push(spec.id); continue;
    }
    collected.push({ ...spec, ...readArtifact(spec.path) });
  }
  return { c, ci, value, record, collected, missing };
}

// A central-only adapter copies observed raw bytes, never interprets a document
// title/type as proof that business correctness has been machine-validated.
export function collectReviewEvidence({ configFile, sourceFile, inputFile, recordFile, evidenceRoot, outDir, now = Date.now() }) {
  evidenceRoot = realpathSync(evidenceRoot);
  configFile = controlledPath(configFile); sourceFile = controlledPath(sourceFile); inputFile = controlledPath(inputFile); recordFile = controlledPath(recordFile);
  const { c, ci, value, collected, missing } = inspected({ configFile, sourceFile, recordFile, evidenceRoot, now });
  inRoot(evidenceRoot, inputFile);
  const requested = path.resolve(outDir), relativeOutput = path.relative(evidenceRoot, requested);
  assert(relativeOutput && relative(relativeOutput.split(path.sep).join('/')), 'Review采集输出须位于批准证据根目录内的新目录');
  const output = safePath(evidenceRoot, relativeOutput); mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  // The winner owns cleanup; an already-existing directory is never removed.
  mkdirSync(output, { mode: 0o700 });
  try {
    const prefix = path.relative(evidenceRoot, output).split(path.sep).join('/'), sourceBytes = readFileSync(sourceFile), ciBytes = readFileSync(c.ciConfigFile), collectorBytes = readFileSync(configFile);
    const copy = (relativeFile, bytes) => { const file = safePath(output, relativeFile); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); return `${prefix}/${relativeFile}`; };
    const copiedSource = copy('ci/source.json', sourceBytes), copiedCi = copy('ci-config.json', ciBytes), copiedCollector = copy('collector-config.json', collectorBytes);
    // Include every downloaded configured artifact: the copied observation stays
    // independently verifiable even when the original collector job is cleaned.
    for (const a of value.artifacts) {
      const bytes = readFileSync(fileIn(realpathSync(path.join(path.dirname(sourceFile), 'artifacts')), a.path));
      assert(bytes.length === a.bytes && hash(bytes) === a.sha256, '采集工件在复制前变化'); copy(`ci/artifacts/${a.path}`, bytes);
    }
    const tag = hash(sourceBytes).slice(0, 16), source = `${ci.system}/${value.runId}/${value.jobId}/${hash(sourceBytes)}`;
    const additions = [
      { id: `ci-source-${tag}`, type: 'ci-source-observation', file: copiedSource, dimensionIds: [] },
      { id: `ci-config-${tag}`, type: 'ci-source-config', file: copiedCi, dimensionIds: [] },
      { id: `ci-collector-${tag}`, type: 'review-collector-config', file: copiedCollector, dimensionIds: [] },
      ...collected.map((e) => ({ id: e.id, type: e.type, file: `${prefix}/ci/artifacts/${e.path}`, dimensionIds: e.dimensionIds }))
    ].map((e) => ({ ...e, project: c.project, candidateSha: value.sha, source }));
    const draft = supplementReviewDraft({ inputFile, recordFile, evidenceRoot, authorId: value.authorId, evidence: additions,
      unresolvedBlocking: value.requiredJobs.filter((j) => j.status !== 'success').map((j) => `ci-job:${j.name}:${j.id}:${j.status}`),
      notes: Object.fromEntries(collected.flatMap((e) => e.dimensionIds.map((d) => [d, '原始CI工件已核验来源及字节；业务含义与适用性仍须非作者逐维复核']))), outDir: path.join(output, 'draft'), now: new Date(now) });
    const provenance = { schemaVersion: 1, kind: 'collected-review-provenance', project: c.project, candidateSha: value.sha, authorId: value.authorId,
      reviewRecordHash: hash(readFileSync(draft.recordFile)), recordFile: path.relative(evidenceRoot, draft.recordFile).split(path.sep).join('/'),
      sourceFile: copiedSource, sourceFileHash: hash(sourceBytes), ciConfigFile: c.ciConfigFile, ciConfigHash: hash(ciBytes),
      configFile, collectorConfigHash: hash(collectorBytes), reviewPolicyHash: c.reviewPolicyHash,
      inputFile: inRoot(evidenceRoot, inputFile), inputFileHash: hash(readFileSync(inputFile)), originalRecordFile: inRoot(evidenceRoot, recordFile), originalRecordHash: hash(readFileSync(recordFile)),
      copiedCiConfigFile: copiedCi, copiedCollectorConfigFile: copiedCollector,
      additions: additions.map((e) => ({ ...e, sha256: hash(readFileSync(fileIn(evidenceRoot, e.file))) })), missingEvidenceIds: missing,
      machineBusinessCorrectnessClaimed: false, approved: false };
    const provenanceFile = path.join(output, 'provenance.json'); writeFileSync(provenanceFile, json(provenance), { flag: 'wx', mode: 0o600 });
    verifyCollectedReview({ recordFile: draft.recordFile, evidenceRoot, provenanceFile, configFile, now });
    return { ...draft, provenanceFile, missingEvidenceIds: missing, identityVerified: true, signed: false };
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}

export function verifyCollectedReview({ recordFile, evidenceRoot, provenanceFile, configFile, now = Date.now(), _depth = 0, _seen = [] }) {
  evidenceRoot = realpathSync(evidenceRoot); inRoot(evidenceRoot, provenanceFile); inRoot(evidenceRoot, recordFile);
  assert(Number.isInteger(_depth) && _depth >= 0 && _depth <= 8 && Array.isArray(_seen) && !_seen.includes(controlledPath(provenanceFile)), 'Review补证父链过深或循环');
  const p = readControlledJson(provenanceFile), c = loadReviewCollectorConfig(configFile);
  if (p.kind === 'extended-collected-review-provenance') return verifyExtendedCollectedReview({ recordFile, evidenceRoot, provenanceFile, configFile, now, _depth, _seen });
  assert(p.schemaVersion === 1 && p.kind === 'collected-review-provenance' && p.project === c.project && p.reviewPolicyHash === c.reviewPolicyHash &&
    p.configFile === controlledPath(configFile) && p.ciConfigFile === c.ciConfigFile && p.collectorConfigHash === hash(readFileSync(configFile)) && p.ciConfigHash === hash(readFileSync(c.ciConfigFile)), 'Review采集来源/固定配置已变化');
  assert(p.approved === false && p.machineBusinessCorrectnessClaimed === false && p.reviewRecordHash === hash(readFileSync(recordFile)) &&
    p.recordFile === inRoot(evidenceRoot, recordFile), 'Review补证记录或来源声明变化');
  const sourceFile = fileIn(evidenceRoot, p.sourceFile), originalRecordFile = fileIn(evidenceRoot, p.originalRecordFile);
  assert(hash(readFileSync(sourceFile)) === p.sourceFileHash && hash(readFileSync(originalRecordFile)) === p.originalRecordHash &&
    hash(readFileSync(fileIn(evidenceRoot, p.inputFile))) === p.inputFileHash &&
    hash(readFileSync(fileIn(evidenceRoot, p.copiedCiConfigFile))) === p.ciConfigHash && hash(readFileSync(fileIn(evidenceRoot, p.copiedCollectorConfigFile))) === p.collectorConfigHash, 'Review原始采集配置/来源/父草稿变化');
  const inspectedResult = inspected({ configFile, sourceFile, recordFile: originalRecordFile, evidenceRoot, now }), { ci, value, record: original, collected, missing } = inspectedResult;
  assert(p.authorId === value.authorId && p.candidateSha === value.sha && equal(p.missingEvidenceIds, missing), 'Review作者/候选/缺失证据与实际CI不同');
  const record = readControlledJson(recordFile); validateReviewDraftIntegrity(record, { evidenceRoot });
  assert(value.requiredJobs.filter((j) => j.status !== 'success').every((j) => record.content.unresolvedBlocking.includes(`ci-job:${j.name}:${j.id}:${j.status}`)), 'Review正文遗漏必需CI作业失败/未运行状态');
  assert(record.authorId === value.authorId && record.candidateSha === value.sha && record.content.derivedFrom?.recordHash === p.originalRecordHash && record.content.derivedFrom.recordFile === p.originalRecordFile, '补证未派生自指定自动草稿或作者无效');
  const prefix = path.dirname(p.sourceFile).replace(/\/ci$/, ''), tag = p.sourceFileHash.slice(0, 16), source = `${ci.system}/${value.runId}/${value.jobId}/${p.sourceFileHash}`;
  const expected = [
    { id: `ci-source-${tag}`, type: 'ci-source-observation', file: p.sourceFile, dimensionIds: [] },
    { id: `ci-config-${tag}`, type: 'ci-source-config', file: p.copiedCiConfigFile, dimensionIds: [] },
    { id: `ci-collector-${tag}`, type: 'review-collector-config', file: p.copiedCollectorConfigFile, dimensionIds: [] },
    ...collected.map((e) => ({ id: e.id, type: e.type, file: `${prefix}/ci/artifacts/${e.path}`, dimensionIds: e.dimensionIds }))
  ].map((e) => ({ ...e, project: c.project, candidateSha: value.sha, source, sha256: hash(readFileSync(fileIn(evidenceRoot, e.file))) }));
  assert(equal(expected, p.additions), 'Review采集映射、工件或证据维度被更换');
  assert(record.content.evidence.length === original.content.evidence.length + expected.length && expected.every((e) => record.content.evidence.some((actual) => equal({ ...e, role: 'current' }, actual))), 'Review正文没有绑定全部固定采集原件');
  return { ok: true, project: c.project, scope: value.scope, candidateSha: value.sha, authorId: value.authorId, record, provenance: p, observation: value, missingEvidenceIds: missing };
}
