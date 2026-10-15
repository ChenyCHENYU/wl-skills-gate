import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { controlledPath, readControlledJson } from './control-store.js';
import { loadReviewCollectorConfig, verifyCollectedReview } from './review-collect.js';
import { loadGovernanceConfig } from './governance.js';
import { createReviewDraft, validateReviewDraftIntegrity } from './review.js';
import { signRecord, verifyRecord } from './evidence.js';
import { safePath } from './source-state.js';
import { stableStringify } from './util.js';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (v) => createHash('sha256').update(v).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const equal = (a, b) => stableStringify(a) === stableStringify(b);
const relative = (v) => typeof v === 'string' && v && !path.isAbsolute(v) && !/[\\\u0000-\u001f?#%]/.test(v) && v.split('/').every((p) => p && p !== '.' && p !== '..');
const fileIn = (root, rel) => { assert(relative(rel), 'Review补证文件须在批准根目录内'); const f = safePath(root, rel); assert(lstatSync(f).isFile(), 'Review补证原件须为普通文件'); return f; };
const inRoot = (root, f) => { const rel = path.relative(root, controlledPath(f)).split(path.sep).join('/'); fileIn(root, rel); return rel; };
const timestamp = (now) => { const n = Number(new Date(now)); assert(Number.isFinite(n), 'Review补证时间无效'); return n; };
const keyHash = (file) => { const key = createPublicKey(readFileSync(file)); assert(key.asymmetricKeyType === 'ed25519', 'Review补证固定公钥须为Ed25519'); return hash(key.export({ type: 'spki', format: 'der' })); };

function settings(configFile, checked) {
  const c = loadReviewCollectorConfig(configFile), s = c.supplement;
  assert(s, 'Review采集器尚未批准自动/认证补证配置');
  const g = loadGovernanceConfig(s.governanceConfigFile), project = g.projects[c.project], scope = project?.scopes[checked.scope];
  assert(project && scope, 'Review补证项目/范围未登记治理责任');
  return { c, s, g, project, scope, governanceHash: hash(readFileSync(s.governanceConfigFile)), authorizationPublicKeyHash: keyHash(s.authorizationPublicKeyFile) };
}

function automaticFacts(checked, cfg, binding) {
  const v = checked.observation, p = cfg.project;
  const common = { schemaVersion: 1, project: checked.project, candidateSha: checked.candidateSha, authorId: checked.authorId, scope: checked.scope, ...binding,
    machineBusinessCorrectnessClaimed: false, approved: false };
  return [
    { file: 'pipeline.json', type: 'pipeline-verification', dimensionId: 'cicd', value: { ...common, kind: 'pipeline-verification', authority: 'verified-ci-observation',
      system: v.system, runId: v.runId, jobId: v.jobId, ref: v.ref, jobStatus: v.jobStatus, status: v.status,
      requiredJobs: v.requiredJobs, sourceHash: checked.provenance.sourceFileHash, ciConfigHash: v.configHash,
      allRequiredJobsSucceeded: v.requiredJobs.length > 0 && v.requiredJobs.every((j) => j.status === 'success') } },
    { file: 'ownership.json', type: 'ownership-verification', dimensionId: 'governance', value: { ...common, kind: 'ownership-verification', authority: 'approved-governance-config',
      governanceConfigHash: cfg.governanceHash, owner: p.owner, backup: p.backup, escalationOwner: p.escalationOwner, reviewers: p.reviewers,
      members: p.members || [], channel: p.channel, issueBaseUrl: p.issueBaseUrl, approvedScope: cfg.scope } }
  ];
}

function humanBody({ human, entry, checked, cfg, binding, createdAt }) {
  assert(human && typeof human.actorId === 'string' && cfg.project.reviewers.includes(human.actorId) && human.actorId !== checked.authorId, 'Review补证须由已登记非作者复核人认证提交');
  const identity = new URL(human.identitySource);
  assert(identity.protocol === 'https:' && !identity.username && !identity.password && !identity.search && !identity.hash, 'Review补证缺少认证身份来源');
  assert(['ui', 'review', 'tests'].includes(entry.dimensionId) && checked.record.content.dimensions.some((d) => d.id === entry.dimensionId && d.applicable), '仅适用的UI/影响分析/外部测试维度允许认证人工补证');
  assert(typeof entry.conclusion === 'string' && entry.conclusion.trim().length >= (entry.dimensionId === 'tests' ? 8 : 4) && entry.conclusion.length <= 2000 && !/[\u0000]/.test(entry.conclusion), 'Review补证须填写明确验证范围、结果及复核结论');
  assert(typeof entry.verificationUrl === 'string' && entry.verificationUrl.length <= 2048 && !/[\u0000-\u0020]/.test(entry.verificationUrl), 'Review补证须提供原始验证记录链接');
  const url = new URL(entry.verificationUrl);
  assert(url.protocol === 'https:' && !url.username && !url.password && cfg.g.allowedLinkOrigins.includes(url.origin), 'Review补证原件链接不在治理批准HTTPS来源内');
  return { schemaVersion: 1, kind: 'authenticated-review-verification', scope: 'review-evidence-supplement', issuer: cfg.s.authorizationIssuer,
    project: checked.project, candidateSha: checked.candidateSha, authorId: checked.authorId, dimensionId: entry.dimensionId,
    actorId: human.actorId, identitySource: human.identitySource, conclusion: entry.conclusion.trim(), verificationUrl: entry.verificationUrl,
    ...binding, createdAt, attestationKind: 'human-reviewed-external-report', machineExecutionClaimed: false,
    approved: false, reviewApproved: false, repairAuthorized: false, promotionAuthorized: false, deploymentAuthorized: false };
}

function inputFrom(parent, policyFile, evidence, derivedFrom, notes) {
  const c = parent.content;
  return { schemaVersion: 1, kind: 'review-input', ...Object.fromEntries(['reviewId', 'project', 'authorId', 'candidateSha', 'scope', 'source', 'target', 'sourceSha', 'targetBeforeSha', 'comparisonWarning'].map((k) => [k, c[k]])),
    policyFile, evidence: [...c.evidence, ...evidence], unresolvedBlocking: [...c.unresolvedBlocking], derivedFrom,
    notes: { ...Object.fromEntries(c.dimensions.map((d) => [d.id, d.note])), ...notes } };
}

// Only central automation and the authenticated service own these output roots
// and the authorization key. A JSON actor field without that key is not proof.
export function extendCollectedReview({ configFile, recordFile, evidenceRoot, provenanceFile, outDir, now = Date.now(), human, authorizationPrivateKeyFile }) {
  evidenceRoot = realpathSync(evidenceRoot); configFile = controlledPath(configFile); recordFile = controlledPath(recordFile); provenanceFile = controlledPath(provenanceFile);
  const checked = verifyCollectedReview({ configFile, recordFile, evidenceRoot, provenanceFile, now }), cfg = settings(configFile, checked);
  const parentRecordFile = inRoot(evidenceRoot, recordFile), parentProvenanceFile = inRoot(evidenceRoot, provenanceFile);
  const parentRecordHash = hash(readFileSync(recordFile)), parentProvenanceHash = hash(readFileSync(provenanceFile));
  const binding = { parentRecordHash, parentProvenanceHash, parentReviewDigest: checked.record.reviewDigest };
  const createdAt = new Date(timestamp(now)).toISOString(), tag = parentRecordHash.slice(0, 16);
  let humanRecords = [];
  if (human !== undefined) {
    assert(authorizationPrivateKeyFile && Array.isArray(human?.entries) && human.entries.length > 0 && human.entries.length <= 3 && new Set(human.entries.map((e) => e.dimensionId)).size === human.entries.length, '认证人工补证须提供签名权限和不重复的UI/影响/外部测试结论');
    humanRecords = human.entries.map((entry) => {
      const body = humanBody({ human, entry, checked, cfg, binding, createdAt }), signed = signRecord(body, controlledPath(authorizationPrivateKeyFile));
      verifyRecord(signed, cfg.s.authorizationPublicKeyFile); return signed;
    });
  } else assert(!authorizationPrivateKeyFile, '无人工补证不得夹带认证签名动作');
  const rel = path.relative(evidenceRoot, path.resolve(outDir)).split(path.sep).join('/');
  assert(relative(rel), 'Review补证输出须在批准根目录内的新目录');
  const output = safePath(evidenceRoot, rel); mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  try {
    const copy = (name, bytes) => { writeFileSync(safePath(output, name), bytes, { flag: 'wx', mode: 0o600 }); return `${rel}/${name}`; };
    const copiedGovernanceConfigFile = copy('governance-config.json', readFileSync(cfg.s.governanceConfigFile));
    const policyFile = copy('review-policy.json', json(checked.record.content.policy));
    const source = `central-review-supplement/${parentRecordHash}`;
    const evidence = [{ id: `governance-config-${tag}`, type: 'governance-config', file: copiedGovernanceConfigFile, dimensionIds: [] }];
    for (const fact of automaticFacts(checked, cfg, binding)) evidence.push({ id: `central-${fact.dimensionId}-${tag}`, type: fact.type, file: copy(fact.file, json(fact.value)), dimensionIds: [fact.dimensionId] });
    for (const fact of humanRecords) evidence.push({ id: `authenticated-${fact.dimensionId}-${tag}`, type: { ui: 'ui-verification', review: 'impact-review', tests: 'test-verification' }[fact.dimensionId], file: copy(`human-${fact.dimensionId}.json`, json(fact)), dimensionIds: [fact.dimensionId] });
    const additions = evidence.map((e) => ({ ...e, project: checked.project, candidateSha: checked.candidateSha, source, role: 'current', sha256: hash(readFileSync(fileIn(evidenceRoot, e.file))) }));
    const parent = checked.record, derivedFrom = { recordFile: parentRecordFile, recordHash: parentRecordHash, reviewDigest: parent.reviewDigest, bodyDigest: parent.bodyDigest, evidenceDigest: parent.evidenceDigest };
    const input = inputFrom(parent, policyFile, additions, derivedFrom, {}), inputFile = copy('review-input.json', json(input));
    const draft = createReviewDraft({ input, evidenceRoot, outDir: path.join(output, 'draft'), now: new Date(now) });
    const provenance = { schemaVersion: 1, kind: 'extended-collected-review-provenance', project: checked.project, candidateSha: checked.candidateSha, authorId: checked.authorId,
      configFile, collectorConfigHash: hash(readFileSync(configFile)), reviewPolicyHash: cfg.c.reviewPolicyHash,
      parentRecordFile, parentRecordHash, parentProvenanceFile, parentProvenanceHash,
      sourceFile: checked.provenance.sourceFile, sourceFileHash: checked.provenance.sourceFileHash,
      recordFile: inRoot(evidenceRoot, draft.recordFile), reviewRecordHash: hash(readFileSync(draft.recordFile)),
      governanceConfigFile: cfg.s.governanceConfigFile, governanceConfigHash: cfg.governanceHash, copiedGovernanceConfigFile,
      authorizationPublicKeyHash: cfg.authorizationPublicKeyHash, authorizationIssuer: cfg.s.authorizationIssuer,
      inputFile, inputFileHash: hash(readFileSync(fileIn(evidenceRoot, inputFile))), policyFile, additions, createdAt,
      machineBusinessCorrectnessClaimed: false, approved: false };
    const nextProvenanceFile = path.join(output, 'provenance.json'); writeFileSync(nextProvenanceFile, json(provenance), { flag: 'wx', mode: 0o600 });
    const verified = verifyCollectedReview({ configFile, recordFile: draft.recordFile, evidenceRoot, provenanceFile: nextProvenanceFile, now });
    return { ...draft, provenanceFile: nextProvenanceFile, identityVerified: true, signed: false, missingEvidenceIds: verified.missingEvidenceIds,
      humanEvidenceCount: humanRecords.length, automaticallyApproved: false, promotionAuthorized: false };
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}

export function verifyExtendedCollectedReview({ recordFile, evidenceRoot, provenanceFile, configFile, now, _depth, _seen }) {
  const p = readControlledJson(provenanceFile);
  assert(_depth < 8 && p.schemaVersion === 1 && p.kind === 'extended-collected-review-provenance' && p.approved === false && p.machineBusinessCorrectnessClaimed === false, 'Review扩展来源声明或父链深度无效');
  const parentFile = fileIn(evidenceRoot, p.parentRecordFile), parentProvenance = fileIn(evidenceRoot, p.parentProvenanceFile);
  assert(hash(readFileSync(parentFile)) === p.parentRecordHash && hash(readFileSync(parentProvenance)) === p.parentProvenanceHash, 'Review补证父记录/来源原件变化');
  const checked = verifyCollectedReview({ configFile, recordFile: parentFile, provenanceFile: parentProvenance, evidenceRoot, now, _depth: _depth + 1, _seen: [..._seen, controlledPath(provenanceFile)] });
  const cfg = settings(configFile, checked);
  assert(p.project === checked.project && p.candidateSha === checked.candidateSha && p.authorId === checked.authorId && p.configFile === controlledPath(configFile) && p.collectorConfigHash === hash(readFileSync(configFile)) && p.reviewPolicyHash === cfg.c.reviewPolicyHash &&
    p.governanceConfigFile === cfg.s.governanceConfigFile && p.governanceConfigHash === cfg.governanceHash && p.authorizationPublicKeyHash === cfg.authorizationPublicKeyHash && p.authorizationIssuer === cfg.s.authorizationIssuer, 'Review补证固定配置/治理责任/公钥变化');
  assert(p.sourceFile === checked.provenance.sourceFile && p.sourceFileHash === checked.provenance.sourceFileHash && p.recordFile === inRoot(evidenceRoot, recordFile) && p.reviewRecordHash === hash(readFileSync(recordFile)), 'Review补证候选/实际来源/记录被替换');
  assert(hash(readFileSync(fileIn(evidenceRoot, p.copiedGovernanceConfigFile))) === cfg.governanceHash && equal(readControlledJson(fileIn(evidenceRoot, p.policyFile)), checked.record.content.policy), 'Review补证治理/策略原件变化');
  const created = Date.parse(p.createdAt); assert(Number.isFinite(created) && created <= timestamp(now) + 30000 && created >= Date.parse(checked.record.createdAt), 'Review补证时间早于父记录或来自未来');
  const binding = { parentRecordHash: p.parentRecordHash, parentProvenanceHash: p.parentProvenanceHash, parentReviewDigest: checked.record.reviewDigest };
  const prefix = path.dirname(p.policyFile), tag = p.parentRecordHash.slice(0, 16), source = `central-review-supplement/${p.parentRecordHash}`;
  assert(p.copiedGovernanceConfigFile === `${prefix}/governance-config.json` && p.inputFile === `${prefix}/review-input.json` && p.policyFile === `${prefix}/review-policy.json`, 'Review补证固定原件路径变化');
  const expected = [{ id: `governance-config-${tag}`, type: 'governance-config', file: p.copiedGovernanceConfigFile, dimensionIds: [] }];
  for (const fact of automaticFacts(checked, cfg, binding)) {
    const file = `${prefix}/${fact.file}`; assert(equal(readControlledJson(fileIn(evidenceRoot, file)), fact.value), 'Review自动CI/责任事实不能由手填状态冒充');
    expected.push({ id: `central-${fact.dimensionId}-${tag}`, type: fact.type, file, dimensionIds: [fact.dimensionId] });
  }
  assert(Array.isArray(p.additions) && p.additions.length >= 3 && p.additions.length <= 6, 'Review补证清单无效');
  const humanAdditions = p.additions.slice(3); assert(new Set(humanAdditions.map((e) => e.dimensionIds?.[0])).size === humanAdditions.length, 'Review人工补证维度重复');
  for (const addition of humanAdditions) {
    const dimensionId = addition.dimensionIds?.[0], file = `${prefix}/human-${dimensionId}.json`;
    assert(['ui', 'review', 'tests'].includes(dimensionId) && addition.file === file, 'Review补证仅允许固定UI/影响/外部测试原件');
    const signed = readControlledJson(fileIn(evidenceRoot, file)), body = verifyRecord(signed, cfg.s.authorizationPublicKeyFile);
    const expectedBody = humanBody({ human: body, entry: body, checked, cfg, binding, createdAt: p.createdAt });
    assert(equal(body, expectedBody), '认证人工证据签发者/父链/候选/结论被替换');
    expected.push({ id: `authenticated-${dimensionId}-${tag}`, type: { ui: 'ui-verification', review: 'impact-review', tests: 'test-verification' }[dimensionId], file, dimensionIds: [dimensionId] });
  }
  const additions = expected.map((e) => ({ ...e, project: checked.project, candidateSha: checked.candidateSha, source, role: 'current', sha256: hash(readFileSync(fileIn(evidenceRoot, e.file))) }));
  assert(equal(additions, p.additions), 'Review补证映射、原件摘要或维度被替换');
  const parent = checked.record, derivedFrom = { recordFile: p.parentRecordFile, recordHash: p.parentRecordHash, reviewDigest: parent.reviewDigest, bodyDigest: parent.bodyDigest, evidenceDigest: parent.evidenceDigest };
  const expectedInput = inputFrom(parent, p.policyFile, additions, derivedFrom, {});
  assert(p.inputFileHash === hash(readFileSync(fileIn(evidenceRoot, p.inputFile))) && equal(readControlledJson(fileIn(evidenceRoot, p.inputFile)), expectedInput), 'Review补证输入不能替换原始证据/候选或清除阻断');
  const record = readControlledJson(recordFile); validateReviewDraftIntegrity(record, { evidenceRoot });
  assert(equal(record.content.evidence, expectedInput.evidence) && equal(record.content.derivedFrom, derivedFrom) && equal(record.content.unresolvedBlocking, expectedInput.unresolvedBlocking), 'Review补证正文丢失父证据/阻断或来源');
  for (const key of ['reviewId', 'project', 'authorId', 'candidateSha', 'scope', 'source', 'target', 'sourceSha', 'targetBeforeSha', 'comparisonWarning']) assert(equal(record.content[key], parent.content[key]), `Review补证不可改变${key}`);
  assert(equal(record.content.dimensions.map((d) => [d.id, d.note]), parent.content.dimensions.map((d) => [d.id, d.note])) && record.createdAt === p.createdAt, 'Review补证正文备注/时间被替换');
  const missingEvidenceIds = checked.missingEvidenceIds.filter((id) => {
    const spec = cfg.c.evidence.find((e) => e.id === id); return !spec || spec.dimensionIds.some((dim) => record.content.dimensions.find((d) => d.id === dim)?.status === 'pending-evidence');
  });
  return { ...checked, record, provenance: { ...checked.provenance, ...p }, baseProvenance: checked.baseProvenance || checked.provenance, missingEvidenceIds };
}
