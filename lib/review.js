import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SHA_PATTERN } from "./source-state.js";
import { readJson, sha256, stableStringify } from "./util.js";
import { DEFAULT_SCHEMA_FILE, validateSummaryAgainstSchema } from "./validate-report.js";
import { blockingFinding } from "./risk.js";

const HASH = /^[a-f0-9]{64}$/;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => stableStringify(a) === stableStringify(b);
const bytesHash = (value) => createHash("sha256").update(value).digest("hex");
const text = (value) => String(value ?? "").replace(/[\r\n|]/g, " ");

export const REVIEW_DIMENSIONS = Object.freeze([
  { id: "submission", name: "代码提交规范" }, { id: "branch", name: "分支管理规范" },
  { id: "coding", name: "编码规范" }, { id: "ui", name: "UI 与交互规范" },
  { id: "review", name: "Code Review 规范" }, { id: "tests", name: "测试规范" },
  { id: "scan", name: "扫描与质量门禁规范" }, { id: "cicd", name: "CI/CD 与发布规范" },
  { id: "governance", name: "工程资产与持续治理" }
]);

// Evidence is fetched by the unprivileged collector into a dedicated directory.
// Neither the input nor signed records may escape it or redirect through links.
function evidencePath(root, file) {
  assert(typeof file === "string" && file && !path.isAbsolute(file) && !file.includes("\\") &&
    !file.split("/").some((part) => !part || part === "." || part === ".."), "Review 证据路径必须是根目录内的明确相对文件");
  const base = realpathSync(root); let cursor = base;
  for (const part of file.split("/")) {
    cursor = path.join(cursor, part);
    assert(!lstatSync(cursor).isSymbolicLink(), "Review 证据不接受符号链接");
  }
  assert(lstatSync(cursor).isFile(), "Review 证据必须是文件");
  return cursor;
}

function prospectivePath(root, target) {
  assert(typeof target === "string" && target, "Review 输出路径不能为空");
  const base = realpathSync(root);
  let relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) relative = path.relative(base, path.resolve(target));
  const resolved = path.resolve(base, relative);
  assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "Review 输出必须位于证据根目录内的新位置");
  let cursor = base;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, part);
    assert(lstatSync(cursor).isDirectory() && !lstatSync(cursor).isSymbolicLink(), "Review 输出父目录必须已存在且不能是符号链接");
  }
  let exists = false;
  try { lstatSync(resolved); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert(!exists, "Review 输出位置已存在，禁止覆盖目录、记录或原始证据");
  return resolved;
}

function writeDraftAtomically(evidenceRoot, outDir, body, record) {
  const target = prospectivePath(evidenceRoot, outDir), lock = `${target}.review-lock`;
  let descriptor, staging;
  try {
    descriptor = openSync(lock, "wx", 0o600);
    prospectivePath(evidenceRoot, target);
    staging = mkdtempSync(path.join(path.dirname(target), ".review-stage-"));
    writeFileSync(path.join(staging, "review.md"), body, { flag: "wx", mode: 0o600 });
    writeFileSync(path.join(staging, "review-draft.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    prospectivePath(evidenceRoot, target);
    renameSync(staging, target); staging = null;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (descriptor !== undefined) { closeSync(descriptor); rmSync(lock, { force: true }); }
  }
}

/** Call before writing a signed record; library signReviewRecord itself is pure. */
export function validateReviewOutputLocation({ outFile, recordFile, evidenceRoot = path.dirname(recordFile) }) {
  assert(typeof outFile === "string" && outFile, "Review 签发输出文件不能为空");
  return prospectivePath(evidenceRoot, outFile);
}

export function validateReviewPolicy(policy, project) {
  assert(policy?.schemaVersion === 1 && policy.project === project, "Review 适用策略项目/版本不匹配");
  assert(Array.isArray(policy.dimensions) && policy.dimensions.length === 9 &&
    new Set(policy.dimensions.map((item) => item.id)).size === 9, "Review 适用策略必须逐项声明九维，不能省略或重复");
  for (const dimension of REVIEW_DIMENSIONS) {
    const rule = policy.dimensions.find((item) => item.id === dimension.id);
    assert(rule && typeof rule.applicable === "boolean", `Review 缺少 ${dimension.id} 适用性`);
    if (rule.applicable) assert(Array.isArray(rule.requiredEvidenceTypes) && rule.requiredEvidenceTypes.length > 0 &&
      rule.requiredEvidenceTypes.every((item) => typeof item === "string" && item.trim()) &&
      new Set(rule.requiredEvidenceTypes).size === rule.requiredEvidenceTypes.length, `${dimension.id} 必需证据类型为空或重复`);
    else assert(typeof rule.reason === "string" && rule.reason.trim(), `${dimension.id} 不适用必须写明事实`);
  }
  assert(policy.dimensions.find((item) => item.id === "review").applicable &&
    policy.dimensions.find((item) => item.id === "scan").applicable, "Code Review 和扫描门禁不能标为不适用");
  assert(policy.dimensions.find((item) => item.id === "scan").requiredEvidenceTypes.includes("gate-summary"), "扫描门禁必须要求本轮 Gate 原始报告");
  return policy;
}

function summary(file, project, sha) {
  const value = readJson(file);
  const errors = validateSummaryAgainstSchema(value, readJson(DEFAULT_SCHEMA_FILE));
  assert(!errors.length, `Review 原始 Gate 报告无效: ${errors.join("; ")}`);
  assert(project && SHA_PATTERN.test(sha || "") && value.run.project === project && value.run.commitSha === sha, "Review 原始报告未绑定该项目/候选 SHA");
  return value;
}

function comparisonBasis(value) {
  return { project: value.run.project, profile: value.run.profile, scope: value.run.scope || "full",
    base: value.run.base || null, targetEnv: value.run.targetEnv || null,
    policyHash: value.policy?.policyHash, ruleSetHash: value.policy?.ruleSetHash,
    baselineHash: value.policy?.baselineHash, waiversHash: value.policy?.waiversHash,
    requiredCheckIds: [...(value.policy?.requiredCheckIds || [])].sort(),
    lockedToolVersions: value.policy?.lockedToolVersions, junitScopes: value.policy?.junitScopes || {},
    checks: value.checks.map((item) => ({ id: item.checkId, status: item.status, required: item.required !== false,
      toolVersion: item.toolVersion, verified: item.toolVersionVerified === true,
      coverage: item.coverage ? { mode: item.coverage.mode, requestedFiles: item.coverage.requestedFiles,
        scannedFiles: item.coverage.scannedFiles, complete: item.coverage.complete } : null })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function compareReviewSummaries(before, after) {
  const a = comparisonBasis(before), b = comparisonBasis(after);
  const changedBasis = Object.keys(a).filter((key) => !equal(a[key], b[key]));
  if (![before, after].every((s) => s.run.sourceBound === true && HASH.test(s.run.sourceDigest || "") &&
    Array.isArray(s.policy?.requiredCheckIds) && s.policy.requiredCheckIds.length &&
    new Set(s.policy.requiredCheckIds).size === s.policy.requiredCheckIds.length && s.policy.checksSelected === s.checks.length &&
    ["policyHash", "ruleSetHash", "baselineHash", "waiversHash"].every((key) => HASH.test(s.policy?.[key] || "")) &&
    s.policy.requiredCheckIds.every((id) => s.checks.some((c) => c.checkId === id && c.required === true &&
      c.status === "ok" && c.toolVersionVerified === true && s.policy.lockedToolVersions?.[id] === c.toolVersion)) &&
    new Set(s.checks.map((c) => c.checkId)).size === s.checks.length &&
    s.checks.every((c) => c.status === "ok" && c.toolVersionVerified === true))) changedBasis.push("incompleteExecutionEvidence");
  const fingerprints = (report) => new Set(report.findings.map((item) => item.fingerprint).filter(Boolean));
  const previous = fingerprints(before), current = fingerprints(after);
  const count = (report) => ({ blocker: report.findings.filter((f) => f.severity === "blocker").length,
    error: report.findings.filter((f) => f.severity === "error").length,
    warning: report.findings.filter((f) => f.severity === "warning").length });
  return { comparable: changedBasis.length === 0, changedBasis,
    beforeSha: before.run.commitSha, afterSha: after.run.commitSha, before: count(before), after: count(after),
    disappeared: [...previous].filter((id) => !current.has(id)).sort(),
    remaining: [...current].filter((id) => previous.has(id)).sort(),
    introduced: [...current].filter((id) => !previous.has(id)).sort(),
    meaning: changedBasis.length ? "口径或执行证据变化；只显示观测值，不能认定质量改善" : "同口径机器问题变化；不代表业务复验、九维批准或问题关闭" };
}

function coverage(policy, evidence, notes = {}) {
  return REVIEW_DIMENSIONS.map((dimension) => {
    const rule = policy.dimensions.find((item) => item.id === dimension.id);
    const references = evidence.filter((item) => item.role !== "before" && item.dimensionIds.includes(dimension.id));
    const missingTypes = rule.applicable ? rule.requiredEvidenceTypes.filter((type) => !references.some((item) => item.type === type)) : [];
    return { ...dimension, applicable: rule.applicable, reason: rule.reason || null,
      requiredEvidenceTypes: rule.applicable ? [...rule.requiredEvidenceTypes] : [],
      evidenceIds: references.map((item) => item.id), missingTypes,
      status: rule.applicable ? (missingTypes.length ? "pending-evidence" : "evidence-ready") : "pending-na-approval",
      note: String(notes[dimension.id] || "") };
  });
}

export function renderReviewBody(content) {
  const lines = ["# 九维 Code Review 证据报告", "", "此正文须与独立授权记录一同核验；正文和扫描通过均不代表已批准。", "",
    `项目：${text(content.project)}；范围：${text(content.scope)}；候选：${content.candidateSha}`,
    `作者：${text(content.authorId)}；源/目标：${text(content.source)} → ${text(content.target)}`, "",
    "| 维度 | 适用 | 证据状态 | 证据编号 | 待补 / 核对事项 |", "|---|---|---|---|---|"];
  for (const d of content.dimensions) lines.push(`| ${d.name} | ${d.applicable ? "是" : "N/A 待批准"} | ${d.status} | ${d.evidenceIds.map(text).join(", ") || "无"} | ${text(d.missingTypes.join(", ") || d.reason || d.note || "需非作者逐维复核")} |`);
  lines.push("", "## 修前修后", "");
  if (content.comparison) {
    const c = content.comparison;
    lines.push(`修前 ${c.beforeSha}；修后 ${c.afterSha}。`,
      `阻断 ${c.before.blocker} → ${c.after.blocker}；错误 ${c.before.error} → ${c.after.error}；警告 ${c.before.warning} → ${c.after.warning}。`,
      `消失 ${c.disappeared.length}；保留 ${c.remaining.length}；新增 ${c.introduced.length}。`, c.meaning,
      ...(c.changedBasis.length ? [`变化项：${c.changedBasis.map(text).join(", ")}。`] : []));
  } else lines.push("未提供修前报告；不能生成修前修后质量差异结论。");
  if (content.comparisonWarning) lines.push(`历史比较未使用：${text(content.comparisonWarning)}。本轮原始检查及待补证据仍须独立核验。`);
  lines.push("", "## 问题处置与授权", "", `未处置阻断：${content.unresolvedBlocking.length}。`, ...content.unresolvedBlocking.map((issue) => `- ${text(typeof issue === 'string' ? issue : stableStringify(issue))}`),
    "修复执行、Review 发布、晋级 / 部署、问题关闭分别授权；本报告不产生任何写入权限。", "", "## 原始证据", "",
    "| 编号 | 类型 / 来源 | 候选 SHA | 文件 | SHA256 |", "|---|---|---|---|---|");
  for (const item of content.evidence) lines.push(`| ${text(item.id)} | ${text(item.type)} / ${text(item.source)} | ${item.candidateSha} | ${text(item.file)} | ${item.sha256} |`);
  return lines.join("\n") + "\n";
}

// A human may add unresolved business risks, but cannot erase machine blockers
// by supplying an empty array. Invalid executions are blockers too.
export function machineReviewBlocking(report) {
  const issues = report.findings.filter((f) => blockingFinding(f, report.policy?.enforceWarnings === true))
    .map((f) => `finding:${f.fingerprint || f.ruleId}:${f.ruleId}:${f.file}`);
  for (const check of report.checks.filter((c) => c.status !== "ok")) issues.push(`check:${check.checkId}:${check.status}`);
  if (report.decision.status !== "passed" && !issues.length) issues.push(`gate:${report.decision.status}`);
  return [...new Set(issues)].sort();
}

// Project/CI adapters can build this input without asking developers to write
// manifests or execute a command. Only machine evidence is populated here.
export function buildReviewInput({ summaryFile, policyFile, evidenceRoot, authorId, beforeSummaryFile, context = {} }) {
  assert(authorId && evidenceRoot, "自动 Review 草稿仍须明确作者与证据根目录");
  const relative = (file) => {
    const rel = path.relative(realpathSync(evidenceRoot), realpathSync(file)).split(path.sep).join("/");
    evidencePath(evidenceRoot, rel); return rel;
  };
  const report = readJson(summaryFile);
  const project = report.run?.project, candidateSha = report.run?.commitSha;
  summary(summaryFile, project, candidateSha);
  const evidence = [{ id: "gate-current", type: "gate-summary", project, candidateSha, source: context.source || "gate/local-report",
    file: relative(summaryFile), dimensionIds: ["coding", "scan"] }];
  if (beforeSummaryFile) {
    const before = readJson(beforeSummaryFile);
    summary(beforeSummaryFile, project, before.run?.commitSha);
    evidence.push({ id: "gate-before", type: "gate-summary", role: "before", project, candidateSha: before.run.commitSha,
      source: context.beforeSource || "gate/previous-report", file: relative(beforeSummaryFile), dimensionIds: [] });
  }
  return { schemaVersion: 1, kind: "review-input", project, authorId, candidateSha, policyFile: relative(policyFile),
    scope: context.scope || report.run.scope || (report.run.base && report.run.head ? `range:${report.run.base}..${report.run.head}` : "full"), source: context.sourceBranch || null, target: context.targetBranch || null,
    sourceSha: context.sourceSha || null, targetBeforeSha: context.targetBeforeSha || null, evidence };
}

// Enrich the automatic input rather than manufacturing an unrelated review.
// This writes a new immutable draft; the original draft/evidence remain intact.
export function supplementReviewDraft({ inputFile, recordFile, evidenceRoot, evidence = [], authorId, notes = {}, unresolvedBlocking = [], outDir, now = new Date() }) {
  const original = readJson(recordFile), input = readJson(inputFile);
  assert(original.kind === "review-draft" && original.decision === "pending-confirmation" && original.content, "只能为待确认自动草稿补证");
  assert(sha256(stableStringify(original.content)) === original.reviewDigest &&
    bytesHash(readFileSync(evidencePath(evidenceRoot, original.bodyFile))) === original.bodyDigest, "原自动草稿已变化，不能补证");
  for (const key of ["reviewId", "project", "candidateSha", "source", "target", "sourceSha", "targetBeforeSha"])
    assert(equal(input[key] ?? null, original.content[key] ?? null), `自动输入 ${key} 与原草稿不一致`);
  const parentFile = path.relative(realpathSync(evidenceRoot), realpathSync(recordFile)).split(path.sep).join("/");
  evidencePath(evidenceRoot, parentFile);
  const originalEvidence = original.content.evidence;
  assert(input.evidence.length === originalEvidence.length && input.evidence.every((e) => originalEvidence.some((o) =>
    e.id === o.id && e.file === o.file && e.type === o.type && e.candidateSha === o.candidateSha && equal(e.dimensionIds, o.dimensionIds))), "自动输入不能替换原始 Gate 证据");
  const derivedFrom = { recordFile: parentFile, recordHash: bytesHash(readFileSync(recordFile)),
    reviewDigest: original.reviewDigest, bodyDigest: original.bodyDigest, evidenceDigest: original.evidenceDigest };
  return createReviewDraft({ input: { ...input, authorId: authorId || input.authorId,
    evidence: [...originalEvidence, ...evidence], notes: { ...input.notes, ...notes },
    unresolvedBlocking: [...new Set([...(input.unresolvedBlocking || []), ...unresolvedBlocking])], derivedFrom }, evidenceRoot, outDir, now });
}

function validateReviewLineage(content, evidenceRoot) {
  if (!content.derivedFrom) return;
  const lineage = content.derivedFrom, parentFile = evidencePath(evidenceRoot, lineage.recordFile), parent = readJson(parentFile);
  assert(bytesHash(readFileSync(parentFile)) === lineage.recordHash && parent.kind === "review-draft" && parent.decision === "pending-confirmation", "原自动草稿记录损坏或被替换");
  for (const key of ["reviewDigest", "bodyDigest", "evidenceDigest"]) assert(parent[key] === lineage[key], "原自动草稿摘要变化");
  assert(sha256(stableStringify(parent.content)) === parent.reviewDigest &&
    bytesHash(readFileSync(evidencePath(evidenceRoot, parent.bodyFile))) === parent.bodyDigest, "原自动草稿正文变化");
  for (const key of ["reviewId", "project", "candidateSha", "source", "target", "sourceSha", "targetBeforeSha", "policyHash"])
    assert(equal(parent.content[key], content[key]), `补证不能改变原自动草稿 ${key}`);
  assert(parent.content.evidence.every((e) => content.evidence.some((current) => equal(e, current))), "补证不能移除或替换原自动证据");
}

export function validateReviewDraftIntegrity(record, { evidenceRoot }) {
  assert(record?.schemaVersion === 2 && record.kind === "review-draft" && record.decision === "pending-confirmation" && record.content, "必须使用待确认九维草稿");
  const c = record.content;
  validateReviewPolicy(c.policy, c.project); validateReviewLineage(c, evidenceRoot);
  assert(c.policyHash === sha256(stableStringify(c.policy)) && record.reviewDigest === sha256(stableStringify(c)) &&
    record.evidenceDigest === sha256(stableStringify(c.evidence)), "Review草稿正文/策略/证据清单摘要变化");
  assert(record.bodyDigest === bytesHash(readFileSync(evidencePath(evidenceRoot, record.bodyFile))) &&
    record.bodyDigest === bytesHash(Buffer.from(renderReviewBody(c))), "Review草稿实际正文变化");
  assert(Array.isArray(c.evidence) && new Set(c.evidence.map((e) => e.id)).size === c.evidence.length, "Review草稿证据编号重复");
  for (const e of c.evidence) assert(e.project === c.project && (e.role === "before" || e.candidateSha === c.candidateSha) &&
    bytesHash(readFileSync(evidencePath(evidenceRoot, e.file))) === e.sha256, "Review草稿原始证据变化");
  assert(equal(coverage(c.policy, c.evidence, Object.fromEntries(c.dimensions.map((d) => [d.id, d.note]))), c.dimensions), "Review草稿九维状态与证据不符");
  for (const key of ["reviewId", "project", "candidateSha", "authorId", "source", "target", "sourceSha", "targetBeforeSha", "unresolvedBlocking"])
    assert(equal(record[key], c[key]), `Review草稿 ${key} 与正文不一致`);
  return c;
}

export function createReviewDraft({ inputFile, input: providedInput, outDir, evidenceRoot = inputFile ? path.dirname(inputFile) : undefined, now = new Date() }) {
  assert(evidenceRoot, "Review 必须明确证据根目录");
  const output = prospectivePath(evidenceRoot, outDir);
  assert(!!inputFile !== !!providedInput, "Review 必须且只能选择 inputFile 或 input 对象");
  const input = providedInput || readJson(inputFile);
  assert(input.schemaVersion === 1 && input.kind === "review-input" && input.project && input.authorId && SHA_PATTERN.test(input.candidateSha || ""), "Review 输入必须有项目、作者及真实候选 SHA");
  const policy = validateReviewPolicy(readJson(evidencePath(evidenceRoot, input.policyFile)), input.project);
  const policyHash = sha256(stableStringify(policy));
  const evidence = [];
  const entries = input.evidence || [];
  assert(Array.isArray(entries) && new Set(entries.map((item) => item.id)).size === entries.length, "Review 证据编号重复或列表无效");
  for (const item of entries) {
    assert(typeof item.id === "string" && item.id && typeof item.type === "string" && item.type && item.source &&
      item.project === input.project && SHA_PATTERN.test(item.candidateSha || ""), "Review 证据必须声明编号、类型、来源、项目及 SHA");
    assert(item.role === "before" || item.candidateSha === input.candidateSha, "当前 Review 证据候选 SHA 不一致");
    assert(Array.isArray(item.dimensionIds) && new Set(item.dimensionIds).size === item.dimensionIds.length &&
      item.dimensionIds.every((id) => REVIEW_DIMENSIONS.some((d) => d.id === id)), "Review 证据维度无效");
    const file = evidencePath(evidenceRoot, item.file), actualHash = bytesHash(readFileSync(file));
    if (item.sha256) assert(item.sha256 === actualHash, "Review 原始证据摘要不匹配");
    evidence.push({ id: item.id, type: item.type, source: String(item.source), project: item.project,
      candidateSha: item.candidateSha, role: item.role === "before" ? "before" : "current", file: item.file,
      dimensionIds: [...item.dimensionIds], sha256: actualHash });
  }
  const current = evidence.filter((item) => item.type === "gate-summary" && item.role === "current");
  assert(current.length <= 1, "Review 当前 Gate 报告只能有一份明确版本");
  let comparison = null, machineBlocking = [];
  if (current.length) {
    const after = summary(evidencePath(evidenceRoot, current[0].file), input.project, input.candidateSha);
    machineBlocking = machineReviewBlocking(after);
    const beforeEvidence = evidence.filter((item) => item.type === "gate-summary" && item.role === "before");
    assert(beforeEvidence.length <= 1, "Review 修前报告只能有一份明确版本");
    if (beforeEvidence.length) comparison = compareReviewSummaries(summary(evidencePath(evidenceRoot, beforeEvidence[0].file), input.project, beforeEvidence[0].candidateSha), after);
  }
  assert(input.unresolvedBlocking === undefined || Array.isArray(input.unresolvedBlocking), "Review 未处置阻断必须是列表");
  const content = { reviewId: input.reviewId || randomUUID(), project: input.project, scope: String(input.scope || "full"),
    authorId: String(input.authorId), candidateSha: input.candidateSha, source: input.source || null, target: input.target || null,
    sourceSha: input.sourceSha || null, targetBeforeSha: input.targetBeforeSha || null,
    policy, policyHash, evidence, dimensions: coverage(policy, evidence, input.notes), comparison,
    comparisonWarning: input.comparisonWarning || null, derivedFrom: input.derivedFrom || null,
    unresolvedBlocking: [...new Set([...machineBlocking, ...(input.unresolvedBlocking || [])])] };
  validateReviewLineage(content, evidenceRoot);
  const body = renderReviewBody(content);
  const bodyFile = path.join(output, "review.md"), recordFile = path.join(output, "review-draft.json");
  const record = { schemaVersion: 2, kind: "review-draft", decision: "pending-confirmation", createdAt: now.toISOString(),
    ...content, content, bodyFile: path.relative(realpathSync(evidenceRoot), bodyFile).split(path.sep).join("/"),
    reviewDigest: sha256(stableStringify(content)), bodyDigest: bytesHash(Buffer.from(body)),
    evidenceDigest: sha256(stableStringify(evidence)), repairAuthorized: false, promotionAuthorized: false,
    deploymentAuthorized: false, closureAuthorized: false };
  writeDraftAtomically(evidenceRoot, output, body, record);
  return { status: "pending-confirmation", approved: false, recordFile, bodyFile, reviewDigest: record.reviewDigest,
    bodyDigest: record.bodyDigest, evidenceDigest: record.evidenceDigest, policyHash,
    dimensions: content.dimensions, comparison };
}

export function validateReviewEvidence(record, { evidenceRoot, expectReviewPolicyHash, project, sha }) {
  assert(record?.schemaVersion === 2 && record.content && HASH.test(expectReviewPolicyHash || ""), "正式 Review 必须使用九维 v2 记录及受控适用策略摘要");
  const c = record.content;
  validateReviewLineage(c, evidenceRoot);
  assert(c.project === project && c.candidateSha === sha && SHA_PATTERN.test(sha || ""), "Review 正文未绑定该项目/候选");
  validateReviewPolicy(c.policy, project);
  assert(sha256(stableStringify(c.policy)) === expectReviewPolicyHash && c.policyHash === expectReviewPolicyHash, "Review 适用策略未经批准或被替换");
  assert(sha256(stableStringify(c)) === record.reviewDigest && sha256(stableStringify(c.evidence)) === record.evidenceDigest, "Review 正文或证据清单摘要不一致");
  assert(bytesHash(readFileSync(evidencePath(evidenceRoot, record.bodyFile))) === record.bodyDigest &&
    bytesHash(Buffer.from(renderReviewBody(c))) === record.bodyDigest, "Review 实际正文与已确认摘要不一致");
  assert(Array.isArray(c.evidence) && new Set(c.evidence.map((e) => e.id)).size === c.evidence.length, "Review 证据列表重复或无效");
  for (const item of c.evidence) {
    assert(item.project === project && (item.role === "before" || item.candidateSha === sha) && HASH.test(item.sha256 || "") &&
      bytesHash(readFileSync(evidencePath(evidenceRoot, item.file))) === item.sha256, "Review 原始证据已变化或候选不一致");
  }
  const recomputed = coverage(c.policy, c.evidence, Object.fromEntries(c.dimensions.map((d) => [d.id, d.note])));
  assert(equal(recomputed, c.dimensions), "Review 九维覆盖与实际证据不一致");
  assert(c.dimensions.every((d) => !d.applicable || d.status === "evidence-ready"), "适用 Review 维度仍缺证据，不能批准");
  assert(Array.isArray(c.unresolvedBlocking) && !c.unresolvedBlocking.length, "Review 阻断问题未全部处置");
  for (const key of ["project", "candidateSha", "authorId", "source", "target", "sourceSha", "targetBeforeSha", "unresolvedBlocking"])
    assert(equal(record[key], c[key]), `Review ${key} 与正文不一致`);
  const report = c.evidence.filter((item) => item.type === "gate-summary" && item.role === "current");
  assert(report.length === 1, "正式 Review 必须核验唯一的当前 Gate 报告");
  const currentSummary = summary(evidencePath(evidenceRoot, report[0].file), project, sha);
  assert(machineReviewBlocking(currentSummary).every((issue) => c.unresolvedBlocking.includes(issue)), "Review 正文遗漏原始报告阻断问题");
  const before = c.evidence.filter((item) => item.type === "gate-summary" && item.role === "before");
  assert(before.length <= 1, "Review 修前证据不唯一");
  const actualComparison = before.length ? compareReviewSummaries(summary(evidencePath(evidenceRoot, before[0].file), project, before[0].candidateSha), currentSummary) : null;
  assert(equal(actualComparison, c.comparison), "Review 前后对比与原始报告不一致");
  return { currentSummary, content: c };
}

export function validateReviewAuthorization(authorization, record, { reviewerId, authorId, project, sha,
  authorizationPublicKeyFile, expectAuthorizationIssuer, now = new Date(), maxAgeMinutes = 1440 }) {
  assert(authorizationPublicKeyFile && expectAuthorizationIssuer, "Review 缺少固定的身份授权方公钥/issuer，拒绝自报身份授权");
  const key = createPublicKey(readFileSync(authorizationPublicKeyFile));
  const { signature, ...payload } = authorization || {};
  assert(key.asymmetricKeyType === "ed25519" && signature?.algorithm === "Ed25519" &&
    /^[A-Za-z0-9+/]{86}==$/.test(signature.value || "") &&
    verify(null, Buffer.from(stableStringify(payload)), key, Buffer.from(signature.value, "base64")), "Review 身份授权receipt签名无效");
  assert(authorization.issuer === expectAuthorizationIssuer, "Review 身份授权issuer不匹配");
  assert(reviewerId && authorId && reviewerId !== authorId && authorId === record.content.authorId, "Review 必须由认证的非作者复核人确认");
  assert(authorization?.schemaVersion === 1 && authorization.kind === "review-authorization" && authorization.scope === "review-publish" &&
    authorization.decision === "approved" && authorization.actorId === reviewerId && authorization.authorId === authorId &&
    authorization.project === project && authorization.candidateSha === sha, "Review 未获独立认证身份的明确发布授权");
  for (const key of ["reviewDigest", "bodyDigest", "evidenceDigest"]) assert(HASH.test(authorization[key] || "") && authorization[key] === record[key], "Review 授权未绑定当前正文/证据摘要");
  assert(typeof authorization.authorizationId === "string" && authorization.authorizationId && typeof authorization.identitySource === "string" &&
    authorization.identitySource && typeof authorization.reason === "string" && authorization.reason.trim(), "Review 授权必须保留编号、身份来源及复核结论");
  const at = Date.parse(authorization.createdAt), expires = Date.parse(authorization.expiresAt), instant = now.getTime();
  assert(Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0 && Number.isFinite(at) && Number.isFinite(expires) &&
    at <= instant + 30000 && instant - at <= maxAgeMinutes * 60000 && expires > instant && expires > at &&
    expires - at <= maxAgeMinutes * 60000, "Review 授权已过期、来自未来或有效期无效");
  assert(Array.isArray(authorization.dimensionDecisions) && authorization.dimensionDecisions.length === 9 &&
    new Set(authorization.dimensionDecisions.map((d) => d.id)).size === 9, "Review 授权须逐维确认九项结论");
  for (const dimension of record.content.dimensions) {
    const approval = authorization.dimensionDecisions.find((item) => item.id === dimension.id);
    assert(approval && approval.decision === (dimension.applicable ? "approved" : "not-applicable") &&
      typeof approval.reason === "string" && approval.reason.trim(), `${dimension.id} 尚未确认或 N/A 未批准`);
  }
  assert(record.repairAuthorized === false && record.promotionAuthorized === false && record.deploymentAuthorized === false && record.closureAuthorized === false,
    "Review 发布授权不能扩展为修复、晋级、部署或关闭授权");
  return authorization;
}
