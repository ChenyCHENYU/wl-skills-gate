import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyProof, signRecord, verifyRecord, validateTime, ENVIRONMENTS } from "./evidence.js";
import { safePath, artifactDigest } from "./source-state.js";
import { stableStringify } from "./util.js";
import { parseXml } from "./xml.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, HASH = /^[a-f0-9]{64}$/;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const releaseDigest = (value) => createHash("sha256").update(value).digest("hex");
export const releaseJson = (file) => JSON.parse(readFileSync(file, "utf8"));
export function controlledPath(file) {
  const absolute = path.resolve(file); let cursor = path.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor)) assert(!lstatSync(cursor).isSymbolicLink(), "受控路径不能含符号链接");
    else { try { lstatSync(cursor); throw new Error("受控路径含断开的符号链接"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }
  return absolute;
}
export function writeReleaseJson(file, value) {
  file = controlledPath(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return file;
}

function componentShape(c) {
  assert(c && ID.test(c.project || "") && ID.test(c.scope || "") && ID.test(c.authorId || "") && ["frontend", "backend", "service"].includes(c.role) && SHA.test(c.sha || ""), "组合发布组件项目/范围/角色/作者/SHA无效");
  for (const field of ["artifactHash", "manifestHash", "sourceDigest", "proofHash"]) assert(HASH.test(c[field] || ""), `组合发布组件缺少 ${field}`);
  assert(c.manifest?.project === c.project && c.manifest.commitSha === c.sha && c.manifest.sourceDigest === c.sourceDigest && releaseDigest(stableStringify(c.manifest)) === c.manifestHash, "组合发布组件清单摘要/源码不一致");
}

function compatibilityShape(value, projects) {
  assert(value && value.api && ["contract", "compatibility-test"].includes(value.api.type) && ID.test(value.api.version || ""), "发布必须明确API契约/兼容性验证及版本");
  assert(value.database && ["none", "migrate"].includes(value.database.mode), "发布必须显式声明数据库无变更或迁移");
  const db = value.database;
  if (db.mode === "none") assert(typeof db.reason === "string" && db.reason.trim() && ID.test(db.schemaVersion || ""), "数据库无变更必须说明原因和实际schema版本");
  else assert(ID.test(db.fromSchema || "") && ID.test(db.toSchema || "") && db.fromSchema !== db.toSchema && typeof db.backwardCompatible === "boolean" && Array.isArray(db.migrations) && db.migrations.length > 0, "数据库迁移必须绑定前后schema、实际迁移文件和兼容性判断");
  assert(Array.isArray(value.deploymentOrder) && value.deploymentOrder.length === projects.length && new Set(value.deploymentOrder).size === projects.length && projects.every((p) => value.deploymentOrder.includes(p)), "发布顺序必须为完整组件排列");
  assert(value.rollback && ["compatible", "requires-approved-recovery"].includes(value.rollback.mode) && typeof value.rollback.reason === "string" && value.rollback.reason.trim(), "发布必须明确回退约束和依据");
  if (db.mode === "migrate" && !db.backwardCompatible) assert(value.rollback.mode === "requires-approved-recovery", "非向后兼容迁移必须要求显式批准的恢复方案");
  const evidence = [value.api.evidence, value.api.reviewEvidence, db.reviewEvidence, value.rollback.reviewEvidence, ...(db.migrations || [])];
  if (value.rollback.mode === "requires-approved-recovery") evidence.push(value.rollback.recoveryEvidence);
  for (const entry of evidence) assert(entry && typeof entry.file === "string" && !path.isAbsolute(entry.file) && !entry.file.includes("\\") && entry.file.split("/").every((v) => v && v !== "." && v !== "..") && HASH.test(entry.sha256 || ""), "API/数据库/回退缺少明确的原始证据文件和SHA256");
  return evidence;
}

function collectCompatibility(value, components, root) {
  const evidence = compatibilityShape(value, components.map((c) => c.project));
  const archive = {};
  for (const entry of evidence) {
    const file = controlledPath(safePath(root, entry.file)), stat = lstatSync(file);
    assert(stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024, "兼容性原始证据必须为非空普通文件且不超过4MiB");
    const bytes = readFileSync(file); assert(releaseDigest(bytes) === entry.sha256, `兼容性原始证据/迁移文件发生变化: ${entry.file}`);
    const saved = archive[entry.file]; assert(!saved || saved.sha256 === entry.sha256, "同一兼容性证据文件不能绑定不同摘要");
    archive[entry.file] = { sha256: entry.sha256, bytes: bytes.length, base64: bytes.toString("base64") };
  }
  return { declaration: value, evidence: archive, componentShas: Object.fromEntries(components.map((c) => [c.project, c.sha])) };
}

export function verifyReleaseCompatibility(compatibility, components) {
  assert(compatibility && compatibility.declaration && compatibility.evidence && compatibility.componentShas, "组合发布缺少已归档的API/数据库/发布顺序/回退证据");
  const references = compatibilityShape(compatibility.declaration, components.map((c) => c.project));
  assert(stableStringify(compatibility.componentShas) === stableStringify(Object.fromEntries(components.map((c) => [c.project, c.sha]))), "兼容性证据未绑定当前全部组件SHA");
  const requiredFiles = new Set(references.map((r) => r.file));
  assert(Object.keys(compatibility.evidence).length === requiredFiles.size, "兼容性原始证据归档缺失/多出文件");
  for (const entry of references) {
    const saved = Object.hasOwn(compatibility.evidence, entry.file) && compatibility.evidence[entry.file];
    assert(saved && saved.sha256 === entry.sha256 && Number.isSafeInteger(saved.bytes) && saved.bytes > 0 && saved.bytes <= 4 * 1024 * 1024 && typeof saved.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(saved.base64), "兼容性原始文件归档结构无效");
    const bytes = Buffer.from(saved.base64, "base64"); assert(bytes.toString("base64") === saved.base64 && bytes.length === saved.bytes && releaseDigest(bytes) === entry.sha256, `兼容性归档原始字节/摘要不一致: ${entry.file}`);
  }
  assert(Object.values(compatibility.evidence).reduce((n, e) => n + e.bytes, 0) <= 16 * 1024 * 1024, "兼容性原始证据总量超过16MiB");
  const api = compatibility.declaration.api, rawApi = Buffer.from(compatibility.evidence[api.evidence.file].base64, "base64").toString("utf8");
  if (api.type === "contract") {
    const spec = JSON.parse(rawApi);
    assert(spec && (/^3\./.test(spec.openapi || "") || spec.swagger === "2.0") && spec.info?.version === api.version && spec.paths && typeof spec.paths === "object" && !Array.isArray(spec.paths) && Object.keys(spec.paths).some((key) => key.startsWith("/")), "API契约必须是当前版本的实际OpenAPI JSON及路径定义");
  } else {
    const xml = parseXml(rawApi); assert(["testsuite", "testsuites"].includes(xml.name), "API兼容性验证必须提供实际JUnit XML");
    const names = new Set();
    const count = (node) => {
      if (node.name === "testcase") {
        const key = `${node.attrs.classname || ""}#${node.attrs.name || ""}`;
        assert(node.attrs.name && !names.has(key) && node.children.every((c) => ["system-out", "system-err", "properties"].includes(c.name)), "API兼容性原始测试失败/跳过/重复或缺少用例身份"); names.add(key); return 1;
      }
      assert(node.children.every((child) => ["testsuite", "testsuites", "testcase", "properties", "system-out", "system-err"].includes(child.name)), "API兼容性原始报告包含不合法结果结构");
      const total = node.children.filter((n) => ["testsuite", "testsuites", "testcase"].includes(n.name)).reduce((n, child) => n + count(child), 0);
      if (node.attrs.tests !== undefined) assert(/^\d+$/.test(node.attrs.tests) && Number(node.attrs.tests) === total, "API兼容性原始测试声明数与实际用例不一致");
      for (const field of ["failures", "errors", "skipped"]) if (node.attrs[field] !== undefined) assert(node.attrs[field] === "0", "API兼容性原始测试仍有失败/错误/跳过");
      return total;
    };
    assert(count(xml) > 0, "API兼容性原始测试为零用例");
  }
  return { compatibilityHash: releaseDigest(stableStringify(compatibility)), apiContractHash: compatibility.declaration.api.evidence.sha256, schemaVersion: compatibility.declaration.database.mode === "none" ? compatibility.declaration.database.schemaVersion : compatibility.declaration.database.toSchema, deploymentOrder: compatibility.declaration.deploymentOrder };
}

// Each component is checked against its own real release report and signed
// proof. The combined record fixes the exact front/back artifact/config pair.
export function createReleaseSet({ inputFile, evidenceRoot = path.dirname(inputFile), expectInputHash, privateKeyFile, issuer, outFile, now = new Date() }) {
  const bytes = readFileSync(controlledPath(inputFile));
  assert(HASH.test(expectInputHash || "") && releaseDigest(bytes) === expectInputHash, "组合发布输入不是批准的固定摘要");
  const input = JSON.parse(bytes);
  assert(input.schemaVersion === 1 && input.kind === "release-set-input" && ID.test(input.releaseSetId || "") && ENVIRONMENTS.includes(input.environment) && ID.test(issuer || ""), "组合发布输入身份/环境无效");
  assert(Array.isArray(input.components) && input.components.length > 0 && input.components.length <= 50 && new Set(input.components.map((c) => c.project)).size === input.components.length, "组合发布组件为空、重复或过多");
  controlledPath(evidenceRoot);
  const components = input.components.map((entry) => {
    assert(ID.test(entry.project || "") && ID.test(entry.scope || "") && ID.test(entry.authorId || "") && SHA.test(entry.sha || ""), "组合发布输入组件身份无效");
    const file = (relative) => controlledPath(safePath(evidenceRoot, relative));
    const options = { ...entry, profile: "release", env: input.environment, now, attestationFile: file(entry.proofFile), summaryFile: file(entry.summaryFile), publicKeyFile: file(entry.publicKeyFile) };
    const verified = verifyProof(options); assert(verified.ok, `组件 ${entry.project} 发布证据无效: ${verified.errors.join("; ")}`);
    const manifest = releaseJson(file(entry.manifestFile));
    assert(manifest.schemaVersion === 1 && manifest.project === entry.project && manifest.commitSha === entry.sha && manifest.targetEnv === input.environment && manifest.sourceDigest === verified.summary.run.sourceDigest && Array.isArray(manifest.artifacts) && manifest.artifacts.length && Array.isArray(manifest.configFiles), "组件manifest项目/环境/源码不匹配");
    validateTime(manifest.createdAt, { now });
    const manifestHash = releaseDigest(stableStringify(manifest));
    assert(verified.proof.artifactManifestDigest === manifestHash, "组件发布签名未绑定当前制品清单");
    const entries = [...manifest.artifacts, ...manifest.configFiles];
    assert(new Set(entries.map((a) => a.path)).size === entries.length, "组件制品/配置路径重复");
    const artifactRoot = file(entry.artifactRoot);
    for (const artifact of entries) assert(HASH.test(artifact.sha256 || "") && artifactDigest(controlledPath(safePath(artifactRoot, artifact.path))) === artifact.sha256, `组件实际制品/配置变化: ${artifact.path}`);
    const artifactHash = manifest.artifacts.length === 1 ? manifest.artifacts[0].sha256 : releaseDigest(stableStringify([...manifest.artifacts].sort((a, b) => a.path.localeCompare(b.path))));
    const component = { project: entry.project, scope: entry.scope, role: entry.role, authorId: entry.authorId, sha: entry.sha, artifactHash, manifestHash, manifest, sourceDigest: manifest.sourceDigest, proofHash: releaseDigest(stableStringify(verified.proof)) };
    componentShape(component); return component;
  }).sort((a, b) => a.project.localeCompare(b.project));
  const compatibility = collectCompatibility(input.compatibility, components, evidenceRoot), contract = verifyReleaseCompatibility(compatibility, components);
  const record = signRecord({ schemaVersion: 1, kind: "release-set", releaseSetId: input.releaseSetId, environment: input.environment, issuer, inputHash: expectInputHash, createdAt: now.toISOString(), components, compatibility, compatibilityHash: contract.compatibilityHash }, privateKeyFile);
  writeReleaseJson(outFile, record);
  return { status: "created", signed: true, releaseSetFile: path.resolve(outFile), releaseSetHash: releaseDigest(stableStringify(record)), components: components.map(({ project, sha }) => ({ project, sha })) };
}

export function verifyReleaseSet({ releaseSetFile, publicKeyFile, expectIssuer, expectReleaseSetHash, env, now = new Date(), maxAgeMinutes = 1440 }) {
  const record = releaseJson(controlledPath(releaseSetFile)); verifyRecord(record, controlledPath(publicKeyFile));
  assert(record.schemaVersion === 1 && record.kind === "release-set" && ID.test(record.releaseSetId || "") && ID.test(expectIssuer || "") && record.issuer === expectIssuer && ENVIRONMENTS.includes(env) && record.environment === env, "组合发布签名身份/目标环境不匹配");
  assert(HASH.test(expectReleaseSetHash || "") && releaseDigest(stableStringify(record)) === expectReleaseSetHash, "组合发布不是本次授权固定摘要");
  validateTime(record.createdAt, { now, maxAgeMinutes });
  assert(Array.isArray(record.components) && record.components.length > 0 && record.components.length <= 50 && new Set(record.components.map((c) => c.project)).size === record.components.length, "组合发布组件为空/重复");
  for (const component of record.components) { componentShape(component); assert(component.manifest.targetEnv === env, "组件清单环境不匹配"); }
  const compatibility = verifyReleaseCompatibility(record.compatibility, record.components); assert(record.compatibilityHash === compatibility.compatibilityHash, "组合发布兼容性摘要不一致");
  return { ok: true, releaseSet: record, releaseSetHash: expectReleaseSetHash };
}
