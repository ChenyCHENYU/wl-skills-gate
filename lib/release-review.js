import path from "node:path";
import { existsSync, readdirSync, lstatSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { verifyReview } from "./evidence.js";
import { safePath } from "./source-state.js";
import { stableStringify } from "./util.js";
import { verifyLiveCiReview } from "./review-live.js";
import { loadReviewCollectorConfig } from "./review-collect.js";
import { loadCiSourceConfig } from "./ci-source.js";
import {collectorFiles,resolveAdditionalCollectors,assertCollectorApproved} from "./review-collectors.js";
import {managerReviewSatisfied} from "./review-responsibility.js";
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (v) => createHash("sha256").update(v).digest("hex"), HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_FILES = 512;
function controlled(file) {
  assert(typeof file === "string" && file, "发布 Review 缺少固定受控配置/原件路径");
  const full = path.resolve(file); let cursor = path.parse(full).root;
  for (const part of full.slice(cursor.length).split(path.sep)) { cursor = path.join(cursor, part); try { assert(!lstatSync(cursor).isSymbolicLink(), "发布 Review 路径不得包含符号链接"); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  return full;
}
function bytes(file, limit = MAX_FILE) { file = controlled(file); const stat = lstatSync(file); assert(stat.isFile() && stat.size > 0 && stat.size <= limit, "发布 Review 原件必须为非空普通文件且不超过4MiB"); return readFileSync(file); }
function relative(v) { return typeof v === "string" && v && !path.isAbsolute(v) && !/[\\\u0000-\u001f]/.test(v) && v.split("/").every((p) => p && p !== "." && p !== ".."); }
export function loadReleaseReviewTrust(configFile, project) {
  configFile = controlled(configFile); const raw = bytes(configFile), c = JSON.parse(raw);
  assert(c.schemaVersion === 1 && c.kind === "release-review-trust" && c.projects && typeof c.projects === "object" && !Array.isArray(c.projects) && Object.hasOwn(c.projects, project), "请在中央 release-review-trust.json 登记本项目的正式 Review 信任配置");
  const p = structuredClone(c.projects[project]); assert(ID.test(project) && p && Array.isArray(p.reviewers) && p.reviewers.length && p.reviewers.every((v) => ID.test(v)) && new Set(p.reviewers).size === p.reviewers.length && ID.test(p.authorizationIssuer || ""), "发布 Review 必须固定复核人名单和身份授权 issuer");
  if(p.requireTechnicalManagerReview!==undefined)assert(typeof p.requireTechnicalManagerReview==="boolean","发布Review经理确认策略须为布尔值");
  if(p.requireTechnicalManagerReview===true)assert(ID.test(p.technicalManager || "") && p.reviewers.includes(p.technicalManager),"发布Review缺少批准技术经理身份");
  for (const key of ["reviewPolicyHash", "policyHash", "rulesHash", "baselineHash", "waiversHash"]) assert(HASH.test(p[key] || ""), `发布 Review 信任配置缺少批准摘要 ${key}`);
  for (const key of ["publicKeyFile", "authorizationPublicKeyFile"]) { assert(typeof p[key] === "string" && p[key], `发布 Review 信任配置缺少 ${key}`); p[key] = controlled(path.resolve(path.dirname(configFile), p[key])); }
  if (p.evidenceRoots !== undefined) { assert(Array.isArray(p.evidenceRoots) && p.evidenceRoots.length && p.evidenceRoots.every((v) => typeof v === "string" && v), "发布 Review 批准证据根目录无效"); p.evidenceRoots = p.evidenceRoots.map((v) => controlled(path.resolve(path.dirname(configFile), v))); }
  for (const field of ["collectorConfigFile", "controlCatalogFile"]) if (p[field] !== undefined) p[field] = controlled(path.resolve(path.dirname(configFile), p[field]));
  resolveAdditionalCollectors(p,path.dirname(configFile));
  if(p.additionalCollectorConfigFiles?.length) assert(typeof p.scope === "string" && ID.test(p.scope),"多分支发布Review必须固定scope，禁止按同SHA选择其他分支审批");
  if(p.scope!==undefined) assert(ID.test(p.scope),"发布Review scope无效");
  p.profile ??= "standard"; p.maxAgeMinutes ??= 1440;
  assert(["standard", "release"].includes(p.profile) && (p.profile !== "release" || ["dev", "sit", "uat", "pre", "prd"].includes(p.env)) && Number.isSafeInteger(p.maxAgeMinutes) && p.maxAgeMinutes > 0 && p.maxAgeMinutes <= 1440, "发布 Review 档位/环境/时效预算无效");
  const publicKey = bytes(p.publicKeyFile), authorizationKey = bytes(p.authorizationPublicKeyFile);
  const der = (v) => createPublicKey(v).export({ type: "spki", format: "der" });
  assert(createPublicKey(publicKey).asymmetricKeyType === "ed25519" && createPublicKey(authorizationKey).asymmetricKeyType === "ed25519" && !der(publicKey).equals(der(authorizationKey)), "发布 Review 公钥必须为独立的 Ed25519 Review/身份授权公钥");
  const binding = { ...p, publicKeyFile: undefined, authorizationPublicKeyFile: undefined, publicKeyHash: hash(der(publicKey)), authorizationPublicKeyHash: hash(der(authorizationKey)) };
  return { ...p, configFile, configHash: hash(raw), trustHash: hash(stableStringify(binding)) };
}
function pins(trust, project, sha, now) { return { project, sha, now, profile: trust.profile, env: trust.env, maxAgeMinutes: trust.maxAgeMinutes, publicKeyFile: trust.publicKeyFile, authorizationPublicKeyFile: trust.authorizationPublicKeyFile, expectAuthorizationIssuer: trust.authorizationIssuer, expectReviewPolicyHash: trust.reviewPolicyHash, expectPolicyHash: trust.policyHash, expectRulesHash: trust.rulesHash, expectBaselineHash: trust.baselineHash, expectWaiversHash: trust.waiversHash }; }
export function verifyReleaseReview({ configFile, project, sha, recordFile, evidenceRoot = path.dirname(recordFile), now = new Date(), allowHistoricalReview = false }) {
  const trust = loadReleaseReviewTrust(configFile, project), raw = bytes(recordFile), record = verifyReview({ ...pins(trust, project, sha, now), recordFile: controlled(recordFile), evidenceRoot: controlled(evidenceRoot) });
  assert(trust.reviewers.includes(record.reviewerId), "正式 Review 复核人未在中央批准名单，禁止构建/发布");
  assert(managerReviewSatisfied(trust,record),"正式Review缺少当前批准的技术经理责任确认，禁止构建/发布");
  if (!allowHistoricalReview && (trust.controlCatalogFile || trust.collectorConfigFile)) {
    assert(trust.controlCatalogFile && trust.collectorConfigFile && trust.evidenceRoots?.length, "当前发布 Review 须完整配置中央目录、采集器和批准证据根，不能降级跳过");
    const candidates=collectorFiles(trust).map(file=>{const collector=loadReviewCollectorConfig(file);return {collector,ci:loadCiSourceConfig(collector.ciConfigFile)};}).filter(value=>trust.scope===undefined || value.ci.scope===trust.scope);
    assert(candidates.length===1,"发布Review必须匹配唯一批准分支范围");
    const {collector,ci}=candidates[0];
    assert(collector.project === project && ci.project === project && collector.reviewPolicyHash === trust.reviewPolicyHash, "当前发布 Review 采集器/九维策略与中央信任不一致");
    const catalog = JSON.parse(bytes(trust.controlCatalogFile)), current = catalog.latest?.[`${project}:${ci.scope}:${sha}`], currentId = typeof current === "string" ? current : current?.reviewId, entry = catalog.reviews?.[currentId];
    assert(catalog.schemaVersion === 1 && currentId && entry && entry.project === project && trust.evidenceRoots.some((root) => contained(root, entry.recordFile)), "本 SHA 缺少中央当前正式 Review 版本，旧目录须重新采集登记");
    const original = bytes(entry.recordFile), draft = JSON.parse(original);
    assert(hash(original) === entry.recordHash && (!current.recordHash || current.recordHash === entry.recordHash) && draft.project === project && draft.candidateSha === sha && draft.reviewDigest === record.reviewDigest && draft.bodyDigest === record.bodyDigest && draft.evidenceDigest === record.evidenceDigest, "本 SHA 当前 Review 已变化或待重新确认，旧正式 Review 不能构建/发布/部署");
  }
  const current = record.content.evidence.find((e) => e.type === "gate-summary" && e.role === "current"), summary = JSON.parse(bytes(safePath(evidenceRoot, current.file)));
  assert(loadReleaseReviewTrust(configFile, project).configHash === trust.configHash, "发布 Review 核验期间中央信任配置发生变化");
  assert(hash(bytes(recordFile)) === hash(raw), "发布 Review 核验期间正式记录发生变化");
  return { status: "verified", approved: true, project, sha, reviewId: record.reviewId, reviewerId: record.reviewerId, authorId: record.authorId, recordHash: hash(raw), reviewDigest: record.reviewDigest, bodyDigest: record.bodyDigest, evidenceDigest: record.evidenceDigest, sourceDigest: summary.run.sourceDigest, trustHash: trust.trustHash, record, trust };
}
export function archiveReleaseReview(options) {
  const verified = verifyReleaseReview(options), files = Object.create(null); let total = 0;
  const add = (name) => { assert(relative(name), "发布 Review 归档引用不得越界"); if (Object.hasOwn(files, name)) return; const raw = bytes(safePath(options.evidenceRoot || path.dirname(options.recordFile), name)); total += raw.length; assert(total <= MAX_TOTAL && Object.keys(files).length < MAX_FILES, "发布 Review 原始证据归档超过16MiB/512文件预算"); files[name] = { bytes: raw.length, sha256: hash(raw), base64: raw.toString("base64") }; };
  const gather = (record, depth = 0) => { assert(depth <= 8, "发布 Review 原件父链超过八层"); add(record.bodyFile); for (const e of record.content.evidence) add(e.file); const parent = record.content.derivedFrom?.recordFile; if (parent) { add(parent); gather(JSON.parse(Buffer.from(files[parent].base64, "base64")), depth + 1); } };
  gather(verified.record);
  const archive = { schemaVersion: 1, kind: "release-review-evidence", project: options.project, candidateSha: options.sha, trustHash: verified.trustHash, record: verified.record, recordHash: hash(stableStringify(verified.record)), files };
  // Validate the archive itself, not just the original directory, before it is signed.
  verifyArchivedReleaseReview({ archive, configFile: options.configFile, project: options.project, sha: options.sha, now: options.now });
  const again = verifyReleaseReview(options); assert(again.recordHash === verified.recordHash && again.trust.configHash === verified.trust.configHash, "发布 Review 归档期间正式记录发生变化");
  return { archive, verified };
}
export function verifyArchivedReleaseReview({ archive, configFile, project, sha, now = new Date(), allowHistoricalReview = false }) {
  const trust = loadReleaseReviewTrust(configFile, project);
  assert(archive?.schemaVersion === 1 && archive.kind === "release-review-evidence" && archive.project === project && archive.candidateSha === sha && archive.trustHash === trust.trustHash && archive.record && archive.recordHash === hash(stableStringify(archive.record)) && archive.files && typeof archive.files === "object" && !Array.isArray(archive.files), "组合发布缺少同候选正式 Review 原件/固定信任，旧组合须重新生成");
  const entries = Object.entries(archive.files); assert(entries.length > 0 && entries.length <= MAX_FILES, "发布 Review 归档文件数无效"); let total = 0;
  const temporary = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-release-review-"));
  try {
    const recordFile = path.join(temporary, "__release-review-record__.json");
    for (const [name, entry] of entries) { assert(relative(name) && name !== "__release-review-record__.json" && entry && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= MAX_FILE && HASH.test(entry.sha256 || "") && typeof entry.base64 === "string" && entry.base64.length <= Math.ceil(MAX_FILE / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64), "发布 Review 归档路径/原始文件预算无效"); const raw = Buffer.from(entry.base64, "base64"); total += raw.length; assert(total <= MAX_TOTAL && raw.length === entry.bytes && raw.toString("base64") === entry.base64 && hash(raw) === entry.sha256, "发布 Review 归档原始字节/摘要不一致"); const file = safePath(temporary, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, raw, { flag: "wx", mode: 0o600 }); }
    const required = new Set();
    const collect = (record, depth = 0) => { assert(depth <= 8 && record?.content && Array.isArray(record.content.evidence), "发布 Review 归档父链无效或过深"); for (const name of [record.bodyFile, ...record.content.evidence.map((e) => e.file)]) { assert(relative(name), "发布 Review 归档原件引用越界"); required.add(name); } const parent = record.content.derivedFrom?.recordFile; if (parent) { assert(relative(parent), "发布 Review 归档父链引用越界"); required.add(parent); collect(JSON.parse(bytes(safePath(temporary, parent))), depth + 1); } };
    collect(archive.record); assert(required.size === entries.length && entries.every(([name]) => required.has(name)), "发布 Review 归档遗漏或夹带非本次核验必需的原件");
    writeFileSync(recordFile, JSON.stringify(archive.record), { flag: "wx", mode: 0o600 });
    return verifyReleaseReview({ configFile, project, sha, recordFile, evidenceRoot: temporary, now, allowHistoricalReview });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function contained(root, file) { const rel = path.relative(controlled(root), controlled(file)); return rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel); }
// Central configuration supplies a fixed publication directory. Build jobs supply only
// their actual checked-out SHA; nobody copies a changing formal-record filename.
export function findReleaseReviewPublication({ configFile, project, sha, publicationDir, now = new Date() }) {
  const trust = loadReleaseReviewTrust(configFile, project);
  assert(trust.evidenceRoots?.length && trust.collectorConfigFile && trust.controlCatalogFile, "自动选择 Review 需在中央信任配置固定 evidenceRoots、collectorConfigFile、controlCatalogFile");
  publicationDir = controlled(publicationDir); assert(lstatSync(publicationDir).isDirectory(), "中央正式 Review 交付目录不存在");
  const names = readdirSync(publicationDir).filter((v) => v.endsWith(".json")).sort(); assert(names.length <= 10000, "正式 Review 交付目录超过10000条预算");
  const catalog = JSON.parse(bytes(trust.controlCatalogFile)); assert(catalog.schemaVersion === 1 && catalog.reviews, "中央 Review 目录记录无效");
  const found = [];
  for (const name of names) {
    const manifestFile = controlled(path.join(publicationDir, name)); let manifest;
    try { manifest = JSON.parse(bytes(manifestFile)); } catch { continue; }
    if (manifest.kind !== "published-review-manifest" || manifest.project !== project || manifest.candidateSha !== sha || trust.scope!==undefined && manifest.scope!==trust.scope) continue;
    assert(trust.evidenceRoots.some((root) => contained(root, manifest.recordFile) && (controlled(root) === controlled(manifest.evidenceRoot) || contained(root, manifest.evidenceRoot))), "正式 Review 交付记录越出中央批准证据根");
    assert(contained(manifest.evidenceRoot, manifest.recordFile) && contained(manifest.evidenceRoot, manifest.draftRecordFile) && contained(manifest.evidenceRoot, manifest.provenanceFile), "正式 Review 记录/草稿/来源不在同一批准证据根");
    const current = catalog.latest?.[`${project}:${manifest.scope}:${sha}`], latestId = typeof current === "string" ? current : current?.reviewId;
    if (!latestId || latestId !== manifest.registrationId) continue;
    const entry = catalog.reviews[manifest.registrationId]; assert(entry && entry.recordFile === manifest.draftRecordFile && entry.provenanceFile === manifest.provenanceFile && entry.evidenceRoot === manifest.evidenceRoot, "正式 Review 交付未匹配中央当前版本目录");
    assert(hash(bytes(manifest.recordFile)) === manifest.recordHash, "正式 Review 交付记录字节发生变化");
    assertCollectorApproved(trust,manifest.collectorConfigFile);
    const collector=loadReviewCollectorConfig(manifest.collectorConfigFile),ci=loadCiSourceConfig(collector.ciConfigFile);
    assert(ci.project===project && ci.scope===manifest.scope,"正式Review采集器与实际项目/分支范围不一致");
    assert(hash(bytes(manifest.draftRecordFile)) === entry.recordHash && hash(bytes(manifest.provenanceFile)) === entry.provenanceHash && manifest.provenanceHash === entry.provenanceHash, "正式 Review 交付草稿/来源与中央目录摘要不一致");
    const verified = verifyReleaseReview({ configFile, project, sha, recordFile: manifest.recordFile, evidenceRoot: manifest.evidenceRoot, now });
    const draft = JSON.parse(bytes(manifest.draftRecordFile)); assert(draft.reviewDigest === verified.reviewDigest && draft.bodyDigest === verified.bodyDigest && draft.evidenceDigest === verified.evidenceDigest, "正式 Review 与本次CI复验草稿不是同一证据版本");
    assert(verified.reviewerId === manifest.reviewerId && verified.authorId === manifest.authorId, "正式 Review 交付身份与原签名不一致");
    found.push({ manifestFile, manifestHash: hash(bytes(manifestFile)), manifest, ...verified });
  }
  assert(found.length, "本次实际 SHA 尚无当前有效的正式九维 Review；等待独立确认与自动签发，禁止构建");
  found.sort((a, b) => Date.parse(b.record.signedAt) - Date.parse(a.record.signedAt));
  assert(found.length === 1 || found[0].record.signedAt !== found[1].record.signedAt || found[0].reviewDigest === found[1].reviewDigest, "同 SHA 存在冲突正式 Review，需中央核对版本");
  return found[0];
}
export async function selectReleaseReview({ configFile, project, sha, publicationDir, outDir = path.resolve("quality-reports", "release-review-live"), now = new Date(), env = process.env, fetchImpl = fetch }) {
  const selected = findReleaseReviewPublication({ configFile, project, sha, publicationDir, now });
  const live = await verifyLiveCiReview({ configFile: selected.manifest.collectorConfigFile, recordFile: selected.manifest.draftRecordFile, evidenceRoot: selected.manifest.evidenceRoot, provenanceFile: selected.manifest.provenanceFile, outDir: path.join(controlled(outDir), randomUUID()), now: now.getTime(), env, fetchImpl });
  assert(hash(bytes(selected.manifestFile)) === selected.manifestHash, "构建前复验期间正式 Review 交付记录发生变化");
  const latest = findReleaseReviewPublication({ configFile, project, sha, publicationDir, now }); assert(latest.reviewDigest === selected.reviewDigest && latest.recordHash === selected.recordHash, "构建前复验期间中央正式 Review 版本发生变化");
  return { ...selected, liveSourceFile: live.sourceFile, liveCheckDirectory: live.outDir, liveVerified: true, recordFile: selected.manifest.recordFile, evidenceRoot: selected.manifest.evidenceRoot };
}
