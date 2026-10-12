import { verifyProof, validateTime } from "./evidence.js";
import { readJson, sha256, stableStringify } from "./util.js";
import { safePath, artifactDigest } from "./source-state.js";

export function verifyArtifact(options) {
  const result = verifyProof({ ...options, profile: "release" });
  if (!result.ok) return result;
  try {
    if (!options.manifestFile || !options.artifactRoot) throw new Error("必须提供 manifest 和 artifact-root，核对实际部署制品");
    const manifest = readJson(options.manifestFile);
    if (manifest.schemaVersion !== 1 || manifest.project !== options.project || manifest.commitSha !== options.sha || manifest.targetEnv !== options.env) throw new Error("制品清单项目/SHA/环境不匹配");
    if (manifest.sourceDigest !== result.summary.run.sourceDigest) throw new Error("制品与门禁源码快照不一致");
    validateTime(manifest.createdAt, options);
    if (sha256(stableStringify(manifest)) !== result.proof.artifactManifestDigest) throw new Error("制品清单未被该证明签名绑定");
    if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error("制品列表为空");
    const paths = new Set();
    for (const item of [...manifest.artifacts, ...(manifest.configFiles || [])]) {
      if (paths.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 || "")) throw new Error("制品路径重复或摘要非法");
      paths.add(item.path);
      if (artifactDigest(safePath(options.artifactRoot, item.path)) !== item.sha256) throw new Error(`实际制品/配置摘要不匹配: ${item.path}`);
    }
  } catch (e) { result.errors.push(e.message); }
  return { ...result, ok: result.errors.length === 0, exitCode: result.errors.length ? 2 : 0 };
}
