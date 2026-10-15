import path from "node:path";
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { safePath, artifactDigest } from "./source-state.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const approvedScript = (name) => hash(readFileSync(path.join(PACKAGE_ROOT, `templates/onboarding/legacy/${name}`)));
const hooks = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
const SCRIPT = "scripts/patch-common-core-dts.mjs";
const COMMON = "node_modules/@jhlc/common-core";
const TYPE_FILE = "src/components/form/common/type.ts";

function transformed(relative, source) {
  return relative === TYPE_FILE ? source.replace(/(export type defaultValueType =\r?\n)\s*"currentDept"\s*\|/, '$1  | "currentDept"')
    : source.replace(/EpPropFinalized<\s*\[StringConstructor\],\s*,/g, "EpPropFinalized<[StringConstructor], unknown,")
      .replace(/EpPropFinalized<\s*\[,\s*StringConstructor\],/g, "EpPropFinalized<[StringConstructor],");
}

function readKnownScript(root, relative, approved) {
  const file = safePath(root, relative);
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`已声明生命周期脚本缺失：${relative}`);
  const sha256 = hash(readFileSync(file));
  if (sha256 !== approvedScript(approved)) throw new Error(`生命周期脚本 ${relative} 不在已核对摘要内；先由工具维护者提供固定目录、精确差异与幂等验证适配，不能自动执行`);
  return { path: relative, sha256 };
}

function commonRoot(root) {
  const entry = path.join(root, COMMON);
  if (!existsSync(entry)) return null;
  const actual = realpathSync(entry), modules = realpathSync(path.join(root, "node_modules"));
  if (!modules.startsWith(root + path.sep) || !actual.startsWith(modules + path.sep) || !lstatSync(actual).isDirectory())
    throw new Error("common-core 只允许项目内 node_modules 安装（含项目内 pnpm 存储），拒绝外部链接");
  const metadata = safePath(actual, "package.json"), pkg = JSON.parse(readFileSync(metadata));
  if (pkg.name !== "@jhlc/common-core" || pkg.version !== "3.1.0-prod.14") throw new Error("common-core postinstall 适配仅核对过 @jhlc/common-core@3.1.0-prod.14");
  return actual;
}

function commonPatch(root) {
  const directory = commonRoot(root);
  if (!directory) return { id: "common-core-types", status: "pending-installation", package: "@jhlc/common-core@3.1.0-prod.14", files: [] };
  const lib = safePath(directory, "lib");
  if (!existsSync(lib) || !lstatSync(lib).isDirectory()) throw new Error("common-core 缺少已核对 lib 目录");
  const declarationFiles = readdirSync(lib).filter((name) => name.endsWith(".d.ts")).sort().map((name) => `lib/${name}`);
  if (!declarationFiles.length) throw new Error("common-core 未见声明文件，不把无操作计为准备成功");
  const files = [...declarationFiles, TYPE_FILE].map((relative) => {
    const file = safePath(directory, relative);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).size > 8 * 1024 * 1024) throw new Error(`common-core 目标不是已核对的普通文件：${relative}`);
    const beforeContent = readFileSync(file, "utf8"), afterContent = transformed(relative, beforeContent);
    if (transformed(relative, afterContent) !== afterContent) throw new Error("内置 common-core patch 非幂等，拒绝应用");
    return { path: relative, beforeHash: hash(beforeContent), afterHash: hash(afterContent), afterContent,
      action: beforeContent === afterContent ? "unchanged" : "patch" };
  });
  return { id: "common-core-types", status: files.some((file) => file.action === "patch") ? "patch-planned" : "unchanged",
    package: "@jhlc/common-core@3.1.0-prod.14", packageRoot: directory, packageSha256: artifactDigest(directory), files,
    allowedPaths: ["lib/*.d.ts", TYPE_FILE], executesProjectScript: false, verification: "全部目标 afterHash 匹配且再次转换零差异；只调整此固定依赖的类型声明" };
}

export function planLifecycle({ root, kind, manifestContent }) {
  const file = safePath(root, kind === "backend" ? "quality-tools/package.json" : "package.json");
  const pkg = JSON.parse(manifestContent || (existsSync(file) ? readFileSync(file, "utf8") : "{}"));
  const plan = { scripts: [], patches: [], blockers: [], arbitraryLifecycleExecution: false };
  for (const id of hooks) {
    const command = pkg.scripts?.[id];
    if (command === undefined) continue;
    try {
      if (kind === "frontend" && id === "preinstall" && command === "node scripts/enforce-pnpm.mjs") {
        plan.scripts.push({ id, command, ...readKnownScript(root, "scripts/enforce-pnpm.mjs", "frontend-enforce-pnpm.mjs"), adapter: "fixed-pnpm-preflight", executesProjectScript: false });
      } else if (kind === "frontend" && id === "prepare" && command === "husky") {
        plan.scripts.push({ id, command, adapter: "explicit-local-husky9-or-controlled-dispatcher", executesProjectScript: false });
      } else if (kind === "frontend" && id === "postinstall" && command === `node ${SCRIPT}`) {
        const declared = pkg.dependencies?.["@jhlc/common-core"] || pkg.devDependencies?.["@jhlc/common-core"];
        if (declared !== "3.1.0-prod.14") throw new Error("postinstall 声明的 common-core 版本不在固定适配范围");
        plan.scripts.push({ id, command, ...readKnownScript(root, SCRIPT, "frontend-common-core-postinstall.mjs"), adapter: "common-core-types", executesProjectScript: false });
        plan.patches.push(commonPatch(root));
      } else throw new Error(`未适配的 ${id}: ${String(command)}；关闭生命周期不能静默漏掉项目准备，请提供固定脚本摘要/允许目录/幂等结果核验后再接入`);
    } catch (error) { plan.blockers.push({ id: "PROJECT-LIFECYCLE-ADAPTER", lifecycle: id, reason: error.message, nextOwner: "工程工具维护者/项目负责人" }); }
  }
  return plan;
}

export function applyLifecycle(root, approved, planHash) {
  const records = [];
  for (const script of approved.scripts) if (script.path) {
    const file = safePath(root, script.path);
    if (hash(readFileSync(file)) !== script.sha256) throw new Error("生命周期脚本确认后变化，拒绝旧适配计划");
  }
  for (const patch of approved.patches) {
    if (!["patch-planned", "unchanged"].includes(patch.status)) throw new Error("项目依赖准备尚无实际安装差异，重新预览并确认");
    const directory = commonRoot(root);
    if (directory !== patch.packageRoot || artifactDigest(directory) !== patch.packageSha256) throw new Error("common-core 安装内容确认后变化，拒绝旧适配计划");
    // Validate all files before the first write, and never execute the project lifecycle script.
    for (const file of patch.files) if (hash(readFileSync(safePath(directory, file.path))) !== file.beforeHash || hash(file.afterContent) !== file.afterHash || transformed(file.path, file.afterContent) !== file.afterContent)
      throw new Error("common-core 精确补丁输入/幂等结果不匹配");
    const written = [], temporary = [];
    try {
      for (const file of patch.files.filter((item) => item.action === "patch")) {
        const target = safePath(directory, file.path), original = readFileSync(target), mode = lstatSync(target).mode & 0o777;
        const relative = `.quality-onboarding-backups/${planHash}/lifecycle/common-core/${file.path}`;
        const backup = safePath(root, relative); mkdirSync(path.dirname(backup), { recursive: true });
        if (existsSync(backup) && hash(readFileSync(backup)) !== file.beforeHash) throw new Error("common-core 补丁备份冲突");
        if (!existsSync(backup)) writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
        const temp = safePath(directory, `${file.path}.onboard-${planHash.slice(0, 12)}.tmp`);
        writeFileSync(temp, file.afterContent, { flag: "wx", mode }); temporary.push({ path: temp, sha256: file.afterHash }); renameSync(temp, target); written.push({ target, original, mode });
      }
      for (const file of patch.files) {
        const actual = readFileSync(safePath(directory, file.path), "utf8");
        if (hash(actual) !== file.afterHash || transformed(file.path, actual) !== actual) throw new Error("common-core 适配结果或二次幂等核验失败");
      }
    } catch (error) { for (const file of written.reverse()) writeFileSync(file.target, file.original, { mode: file.mode }); throw error; }
    finally { for (const temp of temporary) if (existsSync(temp.path) && lstatSync(temp.path).isFile() && !lstatSync(temp.path).isSymbolicLink() && hash(readFileSync(temp.path)) === temp.sha256) rmSync(temp.path); }
    records.push({ id: "project-lifecycle-common-core-types", status: "verified", package: patch.package, changed: written.length,
      executesProjectScript: false, idempotent: true, files: patch.files.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })) });
  }
  return records;
}
