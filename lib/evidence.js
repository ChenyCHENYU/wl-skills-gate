import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readJson, sha256, stableStringify, nowIso } from "./util.js";
import { DEFAULT_SCHEMA_FILE, validateSummaryAgainstSchema } from "./validate-report.js";
import { blockingFinding } from "./risk.js";
import { SHA_PATTERN, snapshotSource, safePath, artifactDigest } from "./source-state.js";

const HASH = /^[a-f0-9]{64}$/;
export const ENVIRONMENTS = ["dev", "sit", "uat", "pre", "prd"];

export function validatePassingSummary(summary, expected) {
  const errors = validateSummaryAgainstSchema(summary, readJson(DEFAULT_SCHEMA_FILE));
  if (errors.length) return errors;
  const run = summary.run;
  if (summary.decision.status !== "passed") errors.push("报告未通过");
  if (!SHA_PATTERN.test(expected.sha || "") || run.commitSha !== expected.sha) errors.push("报告 SHA 与受控期望不一致");
  if (!expected.project || run.project !== expected.project) errors.push("报告项目归属不一致");
  if (!["standard", "release"].includes(expected.profile) || run.profile !== expected.profile) errors.push("检查档位不满足放行要求");
  if (run.sourceBound !== true || !HASH.test(run.sourceDigest || "")) errors.push("报告未绑定不可变的真实 checkout");
  if (expected.profile === "release" && (!ENVIRONMENTS.includes(expected.env) || run.targetEnv !== expected.env)) errors.push("发布环境不一致");
  if (expected.profile === "release" && (run.scope || run.base || run.head)) errors.push("release 证据必须来自全量检查，不能使用增量范围");
  if (!HASH.test(expected.expectPolicyHash || "") || summary.policy?.policyHash !== expected.expectPolicyHash) errors.push("policyHash 缺失或不一致");
  if (!HASH.test(expected.expectRulesHash || "") || summary.policy?.ruleSetHash !== expected.expectRulesHash) errors.push("ruleSetHash 缺失或不一致");
  if (summary.policy?.baselineHash !== (expected.expectBaselineHash || sha256("absent"))) errors.push("baselineHash 未经批准或不一致");
  if (summary.policy?.waiversHash !== (expected.expectWaiversHash || sha256("absent"))) errors.push("waiversHash 未经批准或不一致");
  const ids = summary.checks.map((c) => c.checkId);
  if (new Set(ids).size !== ids.length || !ids.length) errors.push("检查为空或 id 重复");
  const required = summary.policy?.requiredCheckIds;
  if (!Array.isArray(required) || !required.length || new Set(required).size !== required.length) errors.push("必需检查清单缺失或重复");
  else if (required.some((id) => !summary.checks.some((c) => c.checkId === id && c.status === "ok" && c.required === true))) errors.push("必需检查未完整执行");
  if (summary.checks.some((c) => c.required !== false && (!c.toolVersionVerified || !summary.policy?.lockedToolVersions?.[c.checkId] || summary.policy.lockedToolVersions[c.checkId] !== c.toolVersion))) errors.push("必需工具没有通过实际版本核验");
  for (const c of summary.checks.filter((c) => c.tool === "eslint" && c.required !== false)) {
    const coverage = c.coverage;
    const mode = run.scope === "staged" ? "staged" : run.base && run.head ? "range" : "full";
    if (!coverage || coverage.complete !== true || coverage.mode !== mode || !Number.isInteger(coverage.scannedFileCount) || coverage.scannedFileCount < 0 ||
      !Array.isArray(coverage.scannedFiles) || coverage.scannedFiles.length !== coverage.scannedFileCount ||
      (coverage.scannedFileCount === 0 && !(mode !== "full" && coverage.noApplicableFiles === true && Array.isArray(coverage.requestedFiles) && coverage.requestedFiles.length === 0))) {
      errors.push(`ESLint 检查 ${c.checkId} 缺少完整、范围匹配的实际扫描证据`);
    } else if (new Set(coverage.scannedFiles).size !== coverage.scannedFiles.length ||
      coverage.scannedFiles.some((file) => typeof file !== "string" || !file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) ||
      (mode !== "full" && (!Array.isArray(coverage.requestedFiles) || new Set(coverage.requestedFiles).size !== coverage.requestedFiles.length ||
        coverage.requestedFiles.some((file) => !coverage.scannedFiles.includes(file))))) {
      errors.push(`ESLint 检查 ${c.checkId} 的实际扫描清单重复、越界或遗漏请求文件`);
    }
  }
  if (summary.policy?.checksSelected !== summary.checks.length) errors.push("声明检查数与实际不一致");
  if (summary.checks.some((c) => c.status === "invalid" || (c.required !== false && c.status !== "ok"))) errors.push("报告仍有失效检查");
  if (summary.findings.some((f) => blockingFinding(f, !!summary.policy?.enforceWarnings))) errors.push("报告仍有未处置阻断问题");
  if (summary.waivers?.invalidRecords?.length) errors.push("存在无效豁免，不能签发正式证明");
  return errors;
}

export function signRecord(record, privateKeyFile) {
  const { signature: ignored, ...payload } = record;
  const key = createPrivateKey(readFileSync(privateKeyFile));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("签发仅支持 Ed25519 私钥");
  return { ...payload, signature: { algorithm: "Ed25519", value: sign(null, Buffer.from(stableStringify(payload)), key).toString("base64") } };
}

export function verifyRecord(record, publicKeyFile) {
  if (!publicKeyFile) throw new Error("缺少由平台固定的 public-key，拒收未认证证明");
  if (!record?.signature || record.signature.algorithm !== "Ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.signature.value || "")) throw new Error("证明缺少合法 Ed25519 签名");
  const { signature, ...payload } = record;
  const key = createPublicKey(readFileSync(publicKeyFile));
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(stableStringify(payload)), key, Buffer.from(signature.value, "base64"))) throw new Error("证明签名不匹配");
  return payload;
}

export function validateTime(createdAt, { now = new Date(), maxAgeMinutes = 1440 } = {}) {
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) throw new Error("证明有效期必须为正数，不能关闭时效核验");
  const time = Date.parse(createdAt);
  if (!createdAt || !Number.isFinite(time)) throw new Error("证明缺少合法 createdAt");
  const age = now.getTime() - time;
  if (!Number.isFinite(age) || age < -30000 || age > maxAgeMinutes * 60000) throw new Error("证明来自未来或已经过期");
}

export function createArtifactManifest({ root, project, env, artifacts, configFiles = [], outFile }) {
  const source = snapshotSource(root, { exclude: [path.relative(root, path.dirname(outFile))] });
  const commitSha = source.sha;
  if (!SHA_PATTERN.test(commitSha) || !project || !ENVIRONMENTS.includes(env)) throw new Error("制品清单必须绑定真实 SHA、项目和环境");
  if (source.dirty) throw new Error("构建源码不是干净的已检查提交，拒绝生成发布清单");
  if (!Array.isArray(artifacts) || !artifacts.length || new Set(artifacts).size !== artifacts.length) throw new Error("制品列表为空或重复");
  const manifest = { schemaVersion: 1, project, commitSha, sourceDigest: source.digest, targetEnv: env, createdAt: nowIso(),
    artifacts: artifacts.map((p) => ({ path: p, sha256: artifactDigest(safePath(root, p)) })),
    configFiles: configFiles.map((p) => ({ path: p, sha256: artifactDigest(safePath(root, p)) })) };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function signGateProof(options) {
  const summary = readJson(options.summaryFile);
  const errors = validatePassingSummary(summary, options);
  if (errors.length) throw new Error(errors.join("; "));
  validateTime(summary.run.startedAt, options);
  if (!options.issuer || !options.pipelineId || !options.jobId) throw new Error("签发必须登记受控 issuer/pipelineId/jobId");
  const proof = { schemaVersion: 1, kind: "gate-proof", project: options.project, candidateSha: options.sha,
    profile: options.profile, targetEnv: options.env || null, eventId: summary.run.eventId,
    policyHash: options.expectPolicyHash, ruleSetHash: options.expectRulesHash,
    reportDigest: sha256(JSON.stringify(summary)), issuer: options.issuer,
    pipelineId: String(options.pipelineId), jobId: String(options.jobId), createdAt: nowIso(), decision: "passed" };
  if (!proof.eventId) throw new Error("报告缺少 eventId");
  if (options.manifestFile) {
    const m = readJson(options.manifestFile);
    if (m.project !== proof.project || m.commitSha !== proof.candidateSha || m.sourceDigest !== summary.run.sourceDigest || m.targetEnv !== proof.targetEnv || !m.artifacts?.length) throw new Error("制品清单与质量证据不一致");
    validateTime(m.createdAt, options);
    proof.artifactManifestDigest = sha256(stableStringify(m));
  } else if (options.profile === "release") throw new Error("发布证明必须关联制品清单");
  if (options.promotionRecordFile) {
    const p = readJson(options.promotionRecordFile);
    if (p.project !== options.project || p.candidateSha !== options.sha || p.decision !== "candidate-passed" || p.targetBeforeSha !== summary.run.base || summary.run.head !== options.sha) throw new Error("晋级记录与实际候选检查不一致");
    proof.promotionRecordDigest = sha256(stableStringify(p));
  }
  return signRecord(proof, options.privateKeyFile);
}

export function verifyProof(options) {
  const errors = [];
  let proof = null;
  let summary = null;
  try {
    proof = readJson(options.attestationFile);
    verifyRecord(proof, options.publicKeyFile);
    if (proof.kind !== "gate-proof" || proof.schemaVersion !== 1 || proof.decision !== "passed") throw new Error("证明类型或结论不正确");
    if (!options.expectIssuer || proof.issuer !== options.expectIssuer || !proof.pipelineId || !proof.jobId) throw new Error("签发作业身份不匹配");
    if (!options.expectPipelineId || !options.expectJobId || String(options.expectPipelineId) !== proof.pipelineId || String(options.expectJobId) !== proof.jobId) throw new Error("证明作业 ID 与平台查询结果不一致");
    validateTime(proof.createdAt, options);
    summary = readJson(options.summaryFile || path.join(path.dirname(options.attestationFile), "quality-summary.json"));
    errors.push(...validatePassingSummary(summary, options));
    if (sha256(JSON.stringify(summary)) !== proof.reportDigest) errors.push("报告摘要不匹配");
    const pairs = [["project", options.project], ["candidateSha", options.sha], ["profile", options.profile],
      ["policyHash", options.expectPolicyHash], ["ruleSetHash", options.expectRulesHash], ["eventId", summary.run?.eventId]];
    for (const [key, value] of pairs) if (!value || proof[key] !== value) errors.push(`证明 ${key} 与受控期望不一致`);
    if (options.profile === "release" && proof.targetEnv !== options.env) errors.push("证明环境不匹配");
    validateTime(summary.run?.startedAt, options);
  } catch (e) { errors.push(e.message); }
  return { ok: errors.length === 0, exitCode: errors.length ? 2 : 0, errors, proof, summary };
}

export function verifyReview({ recordFile, publicKeyFile, project, sha, now, maxAgeMinutes }) {
  const record = readJson(recordFile);
  verifyRecord(record, publicKeyFile);
  validateTime(record.createdAt, { now, maxAgeMinutes });
  if (record.kind !== "review-record" || record.project !== project || record.candidateSha !== sha || record.decision !== "approved") throw new Error("Review 结论未绑定该候选");
  if (!record.reviewerId || !record.authorId || record.reviewerId === record.authorId) throw new Error("Review 必须由非作者复核人完成");
  if (!Array.isArray(record.unresolvedBlocking) || record.unresolvedBlocking.length) throw new Error("Review 阻断问题未全部处置");
  return record;
}

export function signReviewRecord({ recordFile, privateKeyFile, reviewerId, authorId, project, sha }) {
  const record = readJson(recordFile);
  if (!reviewerId || !authorId || reviewerId === authorId || record.reviewerId !== reviewerId || record.authorId !== authorId) throw new Error("Review 身份与平台授权身份不一致或为自审");
  if (record.project !== project || record.candidateSha !== sha || !SHA_PATTERN.test(sha || "") || record.decision !== "approved" || !Array.isArray(record.unresolvedBlocking) || record.unresolvedBlocking.length) throw new Error("Review 未批准该候选或仍有阻断问题");
  return signRecord({ ...record, kind: "review-record", createdAt: nowIso() }, privateKeyFile);
}
