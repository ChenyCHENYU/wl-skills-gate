import path from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { ENVIRONMENTS } from "./evidence.js";
import { inspectCiObservation } from "./lifecycle-source.js";
import { controlledPath, releaseDigest, validateReleaseSetInput, writeReleaseJson } from "./release-set.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, HASH = /^[a-f0-9]{64}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const relative = (value) => typeof value === "string" && value.length < 1024 && !path.isAbsolute(value) && !/[\\\u0000-\u001f]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
function local(root, file) {
  assert(relative(file), `发布输入必须使用受控根目录内的明确相对路径: ${file}`);
  return controlledPath(path.join(root, file));
}
function original(file, limit = 16 * 1024 * 1024) {
  file = controlledPath(file); const stat = lstatSync(file);
  assert(stat.isFile() && stat.size >= 0 && stat.size <= limit, "发布输入原件必须为普通文件且不超过预算");
  const bytes = readFileSync(file); return { file, bytes, sha256: releaseDigest(bytes) };
}
function keys(value, allowed, message) {
  assert(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key)), message);
}

// This builder never fetches URLs, runs project code, signs a release, or grants
// approval. It only verifies centrally collected originals and prepares the
// exact bytes that a separate release approval/signing step will consume.
export function buildReleaseInputPlan({ configFile, now = new Date() }) {
  const configOriginal = original(configFile, 4 * 1024 * 1024), c = JSON.parse(configOriginal.bytes);
  keys(c, ["schemaVersion", "kind", "releaseSetId", "environment", "evidenceRoot", "outputFile", "components", "compatibilityFile"], "发布输入配置含未知字段；不能提供脚本/命令或覆盖参数");
  assert(c.schemaVersion === 1 && c.kind === "release-input-config" && ID.test(c.releaseSetId || "") && ENVIRONMENTS.includes(c.environment), "发布输入配置身份/环境无效");
  const evidenceRoot = local(path.dirname(configOriginal.file), c.evidenceRoot);
  assert(lstatSync(evidenceRoot).isDirectory(), "发布输入证据根目录不存在");
  const inputFile = local(evidenceRoot, c.outputFile);
  assert(!existsSync(inputFile), "发布输入输出文件已存在；不得覆盖已审阅的输入");
  assert(Array.isArray(c.components) && c.components.length > 0 && c.components.length <= 50 && new Set(c.components.map((v) => v.project)).size === c.components.length, "发布输入组件为空、重复或过多");
  const originals = new Map();
  const read = (file, limit) => {
    const saved = original(local(evidenceRoot, file), limit), previous = originals.get(file);
    assert(!previous || previous.sha256 === saved.sha256, `发布输入原件在检查期间发生变化: ${file}`);
    originals.set(file, { file, sha256: saved.sha256, bytes: saved.bytes.length }); return saved;
  };
  const components = c.components.map((entry) => {
    keys(entry, ["project", "scope", "role", "sha", "authorId", "sourceConfigFile", "sourceConfigHash", "sourceFile", "proofFile", "publicKeyFile", "publicKeyHash", "manifestFile", "summaryFile", "artifactRoot", "expectIssuer", "expectPolicyHash", "expectRulesHash", "expectBaselineHash", "expectWaiversHash"], "发布输入组件含未知字段或执行入口");
    assert(ID.test(entry.project || "") && ID.test(entry.scope || "") && ["frontend", "backend", "service"].includes(entry.role), "发布输入组件身份/范围/角色无效");
    // Existing collected observations carry an authenticated mapping supplied by
    // the central caller, not a signed author identity. Require that mapping to
    // be independently fixed in the approved config; never infer an author
    // from a Git commit name, email, report, or the CI trigger account.
    assert(ID.test(entry.authorId || ""), "作者不能猜测；必须在批准配置中固定已认证 authorId");
    assert(ID.test(entry.expectIssuer || ""), "组件必须固定批准的证明签发者");
    for (const field of ["sourceConfigHash", "publicKeyHash", "expectPolicyHash", "expectRulesHash", "expectBaselineHash", "expectWaiversHash"]) assert(HASH.test(entry[field] || ""), `发布输入组件必须固定 ${field}`);
    const sourceConfig = read(entry.sourceConfigFile), observation = read(entry.sourceFile);
    assert(sourceConfig.sha256 === entry.sourceConfigHash, "组件采集配置不是批准的原始摘要");
    const observed = JSON.parse(observation.bytes);
    assert(SHA.test(observed.sha || "") && (entry.sha === undefined || (SHA.test(entry.sha) && entry.sha === observed.sha)), "组件实际SHA与批准候选不一致");
    const { config: sourceConfigValue, value } = inspectCiObservation({ configFile: sourceConfig.file, sourceFile: observation.file, sha: observed.sha, now: now.getTime() });
    assert(value.project === entry.project && value.scope === entry.scope && value.authorId === entry.authorId, "组件实际项目/范围/作者与批准配置不一致");
    assert(value.status === "success" && value.jobStatus === "success" && value.requiredJobs.every((job) => job.status === "success"), "组件实际必需作业未全部成功");
    const expectedRoot = path.posix.join(path.posix.dirname(entry.sourceFile), "artifacts");
    assert(relative(entry.artifactRoot) && entry.artifactRoot === expectedRoot, "组件 artifactRoot 必须是实际采集目录的 artifacts");
    const collected = (file) => {
      const artifact = read(file, sourceConfigValue.maxArtifactBytes);
      const rootPrefix = entry.artifactRoot + "/";
      assert(file.startsWith(rootPrefix), "组件原件没有来自固定采集工件目录");
      const relativeFile = file.slice(rootPrefix.length), record = value.artifacts.find((item) => item.path === relativeFile);
      assert(record && record.bytes === artifact.bytes.length && record.sha256 === artifact.sha256 && sourceConfigValue.artifacts.paths.includes(relativeFile), `组件采集原件缺失或变化: ${relativeFile}`);
      return artifact;
    };
    assert(entry.summaryFile === `${entry.artifactRoot}/${sourceConfigValue.qualitySummary}`, "组件质量报告不是采集配置固定的原件");
    collected(entry.summaryFile);
    const manifest = JSON.parse(collected(entry.manifestFile).bytes);
    assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length && Array.isArray(manifest.configFiles), "组件清单缺少真实制品/配置");
    for (const artifact of [...manifest.artifacts, ...manifest.configFiles]) {
      assert(relative(artifact.path), "组件制品/配置路径无效");
      assert(collected(`${entry.artifactRoot}/${artifact.path}`).sha256 === artifact.sha256, `组件真实制品/配置与清单不符: ${artifact.path}`);
    }
    read(entry.proofFile);
    assert(read(entry.publicKeyFile).sha256 === entry.publicKeyHash, "组件证明公钥不是批准的原始摘要");
    return { project: entry.project, scope: entry.scope, role: entry.role, sha: value.sha, authorId: entry.authorId, summaryFile: entry.summaryFile, proofFile: entry.proofFile, manifestFile: entry.manifestFile, publicKeyFile: entry.publicKeyFile, artifactRoot: entry.artifactRoot, expectIssuer: entry.expectIssuer, expectPipelineId: value.runId, expectJobId: value.jobId, expectPolicyHash: entry.expectPolicyHash, expectRulesHash: entry.expectRulesHash, expectBaselineHash: entry.expectBaselineHash, expectWaiversHash: entry.expectWaiversHash };
  }).sort((a, b) => a.project.localeCompare(b.project));
  const declaration = JSON.parse(read(c.compatibilityFile, 4 * 1024 * 1024).bytes);
  // The release owner supplies the API/schema/order/recovery decisions. Only
  // raw-file digests are populated here; no compatibility decision is guessed.
  const reference = (entry) => {
    keys(entry, ["file", "sha256"], "兼容性引用必须固定原件文件，不能含推测或执行入口");
    const actual = read(entry.file, 4 * 1024 * 1024);
    assert(entry.sha256 === undefined || entry.sha256 === actual.sha256, `兼容性原件不是声明中的摘要: ${entry.file}`);
    entry.sha256 = actual.sha256;
  };
  reference(declaration.api?.evidence); reference(declaration.api?.reviewEvidence);
  reference(declaration.database?.reviewEvidence); reference(declaration.rollback?.reviewEvidence);
  if (declaration.database?.migrations !== undefined) {
    assert(Array.isArray(declaration.database.migrations), "数据库迁移必须是明确原件列表");
    declaration.database.migrations.forEach(reference);
  }
  if (declaration.rollback?.mode === "requires-approved-recovery") reference(declaration.rollback.recoveryEvidence);
  const input = { schemaVersion: 1, kind: "release-set-input", releaseSetId: c.releaseSetId, environment: c.environment, components, compatibility: declaration, inputProvenance: { schemaVersion: 1, kind: "release-input-originals", configHash: configOriginal.sha256, originals: [...originals.values()].sort((a, b) => a.file.localeCompare(b.file)) } };
  const { contract } = validateReleaseSetInput({ input, evidenceRoot, now });
  // Re-read every original before returning. A changing central archive cannot
  // produce a plan assembled from different instants of its inputs.
  for (const expected of originals.values()) assert(original(local(evidenceRoot, expected.file), Math.max(expected.bytes, 1)).sha256 === expected.sha256, `发布输入原件在检查期间发生变化: ${expected.file}`);
  assert(original(configOriginal.file, 4 * 1024 * 1024).sha256 === configOriginal.sha256, "发布输入配置在检查期间发生变化");
  return { status: "preview", written: false, signed: false, approved: false, configHash: configOriginal.sha256, inputHash: releaseDigest(json(input)), inputFile, evidenceRoot, input, summary: { releaseSetId: c.releaseSetId, environment: c.environment, components: components.map(({ project, role, sha, authorId, expectPipelineId, expectJobId }) => ({ project, role, sha, authorId, pipelineId: expectPipelineId, jobId: expectJobId })), deploymentOrder: contract.deploymentOrder, schemaVersion: contract.schemaVersion, apiContractHash: contract.apiContractHash, originalCount: originals.size } };
}

export function applyReleaseInputPlan({ configFile, expectConfigHash, expectInputHash, now = new Date() }) {
  assert(HASH.test(expectConfigHash || "") && HASH.test(expectInputHash || ""), "生成发布输入必须明确确认预览的 configHash 和 inputHash");
  const plan = buildReleaseInputPlan({ configFile, now });
  assert(plan.configHash === expectConfigHash, "发布输入配置已变化；旧 configHash 确认失效");
  assert(plan.inputHash === expectInputHash, "发布输入原件/组件已变化；旧 inputHash 确认失效");
  writeReleaseJson(plan.inputFile, plan.input);
  return { ...plan, status: "created", written: true };
}
