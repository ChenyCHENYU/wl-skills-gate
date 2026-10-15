import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadCiSourceConfig } from "./ci-source.js";
import { verifyReview, validateTime, signGateProof } from "./evidence.js";
import { renderReviewBody, validateReviewPolicy } from "./review.js";
import { stableStringify } from "./util.js";
import { writeReleaseJson } from "./release-set.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const HASH = /^[a-f0-9]{64}$/, SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const environments = ["dev", "sit", "uat", "pre", "prd"];
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
function local(root, file) {
  assert(typeof file === "string" && !path.isAbsolute(file) && !file.includes("\\") && file.split("/").every((v) => v && v !== "." && v !== ".."), "事实证据必须使用根目录内明确相对文件");
  let cursor = realpathSync(root);
  for (const part of file.split("/")) { cursor = path.join(cursor, part); assert(!lstatSync(cursor).isSymbolicLink(), "事实证据不能使用符号链接"); }
  assert(lstatSync(cursor).isFile(), "事实证据不是普通文件"); return cursor;
}
function source(configFile, sourceFile, sha, now) {
  const config = loadCiSourceConfig(configFile), value = read(sourceFile);
  assert(value.schemaVersion === 1 && value.kind === "verified-ci-observation" && value.system === config.system && value.project === config.project && value.scope === config.scope && value.ref === config.ref && value.configHash === digest(stableStringify(config)), "CI来源不是固定采集配置的核验结果");
  assert(SHA.test(sha || "") && value.sha === sha && ID.test(value.authorId || "") && ID.test(value.runId || "") && ID.test(value.jobId || "") && Number.isSafeInteger(value.sequence) && value.sequence > 0, "事实来源与实际候选/作业不匹配");
  validateTime(value.observedAt, { now: new Date(now) });
  for (const field of ["pipelineUrl", "jobUrl"]) { const u = new URL(value[field]); assert(u.origin === config.baseUrl && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash, "事实来源链接越界"); }
  assert(Array.isArray(value.responses) && value.responses.length && value.responses.every((r) => HASH.test(r.sha256 || "") && (r.raw === undefined ? r.rawOmitted === "controlled-job-configuration" && r.sha256 === config.jobConfigHash : digest(r.raw) === r.sha256)), "来源原始API响应摘要不一致");
  assert(Array.isArray(value.requiredJobs) && value.requiredJobs.length === config.requiredJobs.length && new Set(value.requiredJobs.map((j) => j.name)).size === config.requiredJobs.length && config.requiredJobs.every((name) => value.requiredJobs.some((j) => j.name === name)), "事实来源缺少实际必需作业");
  assert(value.status === (value.requiredJobs.every((j) => j.status === "success") ? "success" : "not-passed"), "事实来源汇总状态与实际必需作业矛盾");
  const raw = value.responses.filter((r) => r.raw).map((r) => { try { return JSON.parse(r.raw); } catch { throw new Error("来源原始API不是JSON"); } });
  if (config.system === "gitlab") {
    assert(value.requiredJobsSnapshot === "final-required-jobs", "事实来源缺少显式末次必需作业快照");
    const pipeline = raw.find((r) => r && !Array.isArray(r) && String(r.id) === value.runId && r.project_id !== undefined);
    assert(pipeline && String(pipeline.project_id) === String(config.projectId) && pipeline.sha === sha && pipeline.ref === config.ref, "来源原始GitLab流水线身份不匹配");
    const jobs = value.responses.filter((r) => r.snapshot === value.requiredJobsSnapshot).map((r) => JSON.parse(r.raw)).flat();
    for (const entry of value.requiredJobs) {
      const matches = jobs.filter((r) => String(r.id) === entry.id && r.name === entry.name); assert(matches.length === 1, "来源原始GitLab必需作业缺失或重复");
      const job = matches[0]; assert(job.status === entry.status && job.commit?.id === sha && String(job.pipeline?.id) === value.runId && job.ref === config.ref && job.allow_failure === false && (!["success", "failed"].includes(job.status) || config.trustedRunnerIds.map(String).includes(String(job.runner?.id))), "来源原始GitLab作业状态/版本/Runner不匹配");
    }
    const exact = raw.findLast((r) => r && !Array.isArray(r) && String(r.id) === value.jobId && r.name === config.artifacts.job);
    const listed = value.requiredJobs.find((j) => j.name === config.artifacts.job);
    assert(exact && listed.id === value.jobId && exact.status === value.jobStatus && listed.status === value.jobStatus && exact.commit?.id === sha && String(exact.pipeline?.id) === value.runId && exact.ref === config.ref && exact.allow_failure === false && !exact.erased_at, "来源原始GitLab工件作业与观察值不一致");
  } else {
    assert(value.requiredJobsSnapshot === "final-build", "事实来源缺少显式末次构建快照");
    const build = value.responses.filter((r) => r.snapshot === value.requiredJobsSnapshot).map((r) => JSON.parse(r.raw)).findLast((r) => r && !Array.isArray(r) && String(r.number) === value.runId && typeof r.building === "boolean");
    const revisions = [...new Set((build?.actions || []).map((a) => a.lastBuiltRevision?.SHA1).filter(Boolean))];
    const branches = (build?.actions || []).flatMap((a) => a.lastBuiltRevision?.branch || []).filter((b) => b.SHA1 === sha).map((b) => b.name);
    const actualStatus = build?.building ? "running" : ({ SUCCESS: "success", FAILURE: "failed", UNSTABLE: "failed", ABORTED: "canceled", NOT_BUILT: "skipped" })[build?.result];
    assert(build && revisions.length === 1 && revisions[0] === sha && branches.includes(config.ref) && actualStatus === value.jobStatus && value.requiredJobs[0].status === actualStatus && value.requiredJobs[0].id === value.jobId, "来源原始Jenkins实际SCM/状态与观察值不一致");
  }
  assert(Array.isArray(value.artifacts) && new Set(value.artifacts.map((a) => a.path)).size === value.artifacts.length && value.artifacts.every((a) => config.artifacts.paths.includes(a.path) && HASH.test(a.sha256 || "") && Number.isSafeInteger(a.bytes) && a.bytes >= 0), "事实来源工件清单无效");
  assert(Array.isArray(value.missingArtifacts) && new Set(value.missingArtifacts.map((a) => a.path)).size === value.missingArtifacts.length && value.missingArtifacts.every((a) => config.artifacts.paths.includes(a.path) && !value.artifacts.some((present) => present.path === a.path) && (a.reason === "optional-unavailable" ? (config.artifacts.optionalPaths || []).includes(a.path) && a.path !== config.qualitySummary : value.jobStatus === "failed" && ["not-archived", "download-unavailable"].includes(a.reason))), "事实来源缺失工件记录与实际作业不一致");
  return { config, value };
}
export function inspectCiObservation({ configFile, sourceFile, sha, now = Date.now() }) {
  return source(configFile, sourceFile, sha, now);
}
function writeEvent(outDir, event, sourceFile) {
  assert(typeof outDir === "string" && outDir, "必须指定新的事实输出目录"); const output = path.resolve(outDir);
  let cursor = path.parse(output).root;
  for (const part of output.slice(cursor.length).split(path.sep)) { cursor = path.join(cursor, part); if (existsSync(cursor)) assert(!lstatSync(cursor).isSymbolicLink(), "事实输出路径不能含符号链接"); }
  assert(!existsSync(output), "事实输出目录已存在；不得覆盖原始事件");
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(output, { mode: 0o700 }); const eventFile = path.join(output, "lifecycle-event.json");
  try { writeFileSync(eventFile, json(event), { flag: "wx", mode: 0o600 }); } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  return { status: event.status, category: event.category, signed: false, eventFile, sourceFile: path.resolve(sourceFile), sourceHash: event.source.recordHash };
}
function sourceArtifact(sourceFile, observation, relative) {
  const entry = observation.artifacts.find((a) => a.path === relative); assert(entry, `制品未由固定来源采集: ${relative}`);
  const file = local(path.join(path.dirname(sourceFile), "artifacts"), relative), bytes = readFileSync(file);
  assert(bytes.byteLength === entry.bytes && digest(bytes) === entry.sha256, `已下载原始工件发生变化: ${relative}`);
  return { entry, file, bytes };
}
function artifactUrl(config, observation, relative) {
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  if (config.system === "gitlab") return `${config.baseUrl}/api/v4/projects/${config.projectId}/jobs/${observation.jobId}/artifacts/${encoded}`;
  return `${observation.jobUrl.replace(/\/$/, "")}/artifact/${encoded}`;
}
function eventBase(value, sourceFile, category, status, now) {
  const sourceHash = digest(readFileSync(sourceFile));
  return { schemaVersion: 1, kind: "lifecycle-event", eventId: `${category}:${digest(`${value.project}:${value.scope}:${value.runId}:${value.jobId}:${value.sequence}:${status}:${sourceHash}`).slice(0, 48)}`,
    project: value.project, scope: value.scope, category, lane: `ref-${digest(value.ref).slice(0, 24)}`, status,
    sha: value.sha, authorId: value.authorId, sequence: value.sequence, pipelineId: value.runId, jobId: value.jobId,
    // The collector's observation time is explicit. Where available the actual
    // source start/finish time replaces it; no guessed elapsed time is shown.
    occurredAt: value.observedAt, reportUrl: value.jobUrl, pipelineUrl: value.pipelineUrl,
    source: { system: value.system, recordId: value.jobId, recordHash: sourceHash, observedAt: new Date(now).toISOString(), url: value.jobUrl } };
}

export function createBuildLifecycle({ configFile, sourceFile, manifestPath, env, sha, outDir, now = Date.now() }) {
  const { config, value } = source(configFile, sourceFile, sha, now);
  assert(environments.includes(env), "构建事实必须指定批准目标环境");
  const allPassed = value.requiredJobs.every((j) => j.status === "success");
  const status = value.jobStatus === "success" ? allPassed && value.status === "success" ? "success" : "failed" : value.jobStatus === "failed" ? "failed" : value.jobStatus === "canceled" ? "canceled" : ["running", "preparing", "canceling"].includes(value.jobStatus) ? "running" : "not-run";
  assert(["success", "failed", "canceled", "skipped", "manual", "pending", "running", "created", "preparing", "scheduled", "waiting_for_resource", "canceling"].includes(value.jobStatus), "未知实际作业状态");
  const event = { ...eventBase(value, sourceFile, "build", status, now), environment: env };
  const actualJob = value.responses.filter((r) => r.raw).map((r) => { try { return JSON.parse(r.raw); } catch { return null; } }).findLast((j) => j && !Array.isArray(j) && String(j.id ?? j.number) === value.jobId && (config.system === "gitlab" ? j.name === config.artifacts.job : typeof j.building === "boolean"));
  if (actualJob) {
    const time = config.system === "gitlab" ? (actualJob.finished_at || actualJob.started_at) : Number.isFinite(actualJob.timestamp) ? new Date(actualJob.timestamp + (actualJob.building ? 0 : actualJob.duration || 0)).toISOString() : null;
    if (time) { validateTime(time, { now: new Date(now) }); event.occurredAt = time; }
  }
  if (status === "success") {
    assert(config.artifacts.paths.includes(manifestPath), "构建成功必须配置固定制品manifest工件");
    const original = sourceArtifact(sourceFile, value, manifestPath), manifest = JSON.parse(original.bytes);
    assert(manifest.schemaVersion === 1 && manifest.project === config.project && manifest.commitSha === sha && manifest.targetEnv === env && HASH.test(manifest.sourceDigest || ""), "构建manifest项目/SHA/目标环境/源码摘要不匹配");
    validateTime(manifest.createdAt, { now: new Date(now) });
    assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length && Array.isArray(manifest.configFiles), "构建manifest必须列出真实制品和配置清单");
    const entries = [...manifest.artifacts, ...manifest.configFiles];
    assert(new Set(entries.map((a) => a.path)).size === entries.length && entries.every((a) => HASH.test(a.sha256 || "") && a.path !== manifestPath), "构建manifest文件重复或摘要无效");
    for (const entry of entries) assert(sourceArtifact(sourceFile, value, entry.path).entry.sha256 === entry.sha256, `实际制品/配置与manifest摘要不匹配: ${entry.path}`);
    if (config.qualitySummary) {
      const summary = JSON.parse(sourceArtifact(sourceFile, value, config.qualitySummary).bytes);
      assert(summary.run?.project === config.project && summary.run.commitSha === sha && summary.run.sourceDigest === manifest.sourceDigest && summary.decision?.status === "passed", "构建manifest源码与实际质量报告不一致");
    }
    event.artifactHash = manifest.artifacts.length === 1 ? manifest.artifacts[0].sha256 : digest(stableStringify([...manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path))));
    event.manifestHash = original.entry.sha256; event.artifactUrl = artifactUrl(config, value, manifestPath); event.reportUrl = event.artifactUrl;
    event.artifactCount = manifest.artifacts.length; event.configCount = manifest.configFiles.length;
  }
  return writeEvent(outDir, event, sourceFile);
}

export function signCollectedReleaseProof(options) {
  const { configFile, sourceFile, manifestPath, env, sha, outFile, now = Date.now() } = options;
  const { config, value } = source(configFile, sourceFile, sha, now);
  assert(environments.includes(env) && value.status === "success" && value.jobStatus === "success" && value.requiredJobs.every((j) => j.status === "success"), "签发必须来自实际成功的完整必需作业集");
  assert(config.qualitySummary && config.artifacts.paths.includes(manifestPath), "签发必须固定原始质量报告和制品清单路径");
  const summary = sourceArtifact(sourceFile, value, config.qualitySummary), manifest = sourceArtifact(sourceFile, value, manifestPath), body = JSON.parse(manifest.bytes);
  assert(body.schemaVersion === 1 && body.project === config.project && body.commitSha === sha && body.targetEnv === env && Array.isArray(body.artifacts) && body.artifacts.length && Array.isArray(body.configFiles), "签发原始清单项目/候选/环境无效");
  const entries = [...body.artifacts, ...body.configFiles];
  assert(new Set(entries.map((entry) => entry.path)).size === entries.length, "签发制品/配置重复");
  for (const entry of entries) assert(HASH.test(entry.sha256 || "") && sourceArtifact(sourceFile, value, entry.path).entry.sha256 === entry.sha256, "签发时实际制品/配置摘要与原清单不符");
  const proof = signGateProof({ ...options, project: config.project, profile: "release", summaryFile: summary.file, manifestFile: manifest.file, pipelineId: value.runId, jobId: value.jobId, now: new Date(now) });
  writeReleaseJson(outFile, proof);
  return { status: "signed", project: config.project, sha, proofFile: path.resolve(outFile), sourceFile: path.resolve(sourceFile), sourceHash: digest(readFileSync(sourceFile)), pipelineId: value.runId, jobId: value.jobId };
}

export function createReviewLifecycle(options) {
  const { configFile, sourceFile, recordFile, evidenceRoot = path.dirname(recordFile), sha, reportUrl, outDir, sequence, now = Date.now() } = options;
  const { config, value } = source(configFile, sourceFile, sha, now), record = read(recordFile);
  assert(Number.isSafeInteger(sequence) && sequence > 0, "Review事实必须分配显式中央序号，不能从CI运行次数推算");
  assert(record.schemaVersion === 2 && record.project === value.project && record.candidateSha === sha && record.authorId === value.authorId && ID.test(record.reviewId || ""), "Review事实未绑定实际项目/候选/作者");
  const report = new URL(reportUrl); assert(report.protocol === "https:" && !report.username && !report.password && !report.hash && ![...report.searchParams.keys()].some((key) => /token|secret|password|key/i.test(key)), "Review报告必须使用无凭据认证链接");
  let status;
  if (record.kind === "review-record") {
    verifyReview({ ...options, recordFile, evidenceRoot, project: value.project, sha, now: new Date(now) }); status = "approved";
  } else {
    assert(record.kind === "review-draft" && record.decision === "pending-confirmation" && record.content?.project === value.project && record.content.candidateSha === sha && record.content.authorId === value.authorId, "Review草稿结构/候选无效");
    validateTime(record.createdAt, { now: new Date(now) }); validateReviewPolicy(record.content.policy, value.project);
    assert(HASH.test(options.expectReviewPolicyHash || "") && record.content.policyHash === options.expectReviewPolicyHash && digest(stableStringify(record.content.policy)) === options.expectReviewPolicyHash, "Review草稿适用策略不受信任");
    assert(record.reviewDigest === digest(stableStringify(record.content)) && record.evidenceDigest === digest(stableStringify(record.content.evidence)) && record.bodyDigest === digest(readFileSync(local(evidenceRoot, record.bodyFile))) && record.bodyDigest === digest(renderReviewBody(record.content)), "Review草稿正文/证据摘要不一致");
    for (const entry of record.content.evidence) assert(entry.sha256 === digest(readFileSync(local(evidenceRoot, entry.file))) && entry.project === value.project && (entry.role === "before" || entry.candidateSha === sha), "Review草稿原始证据变化或候选不一致");
    assert(["repairAuthorized", "promotionAuthorized", "deploymentAuthorized", "closureAuthorized"].every((key) => record[key] === false), "Review草稿不能携带额外写入权限");
    status = "draft";
  }
  const event = { ...eventBase({ ...value, sequence }, recordFile, "review", status, now), reviewId: record.reviewId, reportHash: record.bodyDigest, evidenceHash: record.evidenceDigest, reportUrl, occurredAt: status === "approved" ? record.signedAt : record.createdAt };
  event.source = { system: "review", recordId: record.reviewId, recordHash: digest(readFileSync(recordFile)), observedAt: new Date(now).toISOString(), url: reportUrl };
  if (status === "approved") { event.authorizationId = record.authorization.authorizationId; event.actorId = record.reviewerId; }
  return writeEvent(outDir, event, recordFile);
}
