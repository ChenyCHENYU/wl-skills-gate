import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync, realpathSync, openSync, closeSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { artifactDigest, safePath, snapshotSource } from "./source-state.js";
import { loadConfig } from "./config.js";
import { parseXml } from "./xml.js";
import { redactLog } from "./exec.js";
import { doctor } from "./doctor.js";
import { validateReportFile } from "./validate-report.js";
import { validatePassingSummary } from "./evidence.js";
import { registryInstallationEvidence, verifyLockOrigins } from "./onboard-registry.js";
import { onboardingEnvironment } from "./onboard-environment.js";
import { planLifecycle, applyLifecycle } from "./onboard-lifecycle.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const fixedVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;

function registry(value) {
  if (!value) throw new Error("--complete 需要 --registry <已批准HTTPS安装源>，不能隐式使用未知 npmrc 源");
  let url; try { url = new URL(value); } catch { throw new Error("安装源 URL 无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("安装源必须是无凭据/查询参数的 HTTPS URL；认证通过受控环境注入");
  return url.href;
}
function commandPath(name) {
  if (path.isAbsolute(name)) return realpathSync(name);
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return realpathSync(candidate);
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) return realpathSync(candidate);
  }
  throw new Error(`批准环境缺少执行器 ${name}，不会自行下载或使用 npx latest`);
}
function invoke(executable, args, root, runner = spawnSync) {
  const result = runner(executable, args, { cwd: root, shell: false, encoding: "utf8", timeout: 1200000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "true" } });
  return { exitCode: Number.isInteger(result.status) ? result.status : 2, stdout: redactLog(result.stdout || ""),
    stderr: redactLog(result.stderr || result.error?.message || result.signal || "") };
}
function tool(root, kind, name) {
  const directory = path.join(root, kind === "backend" ? "quality-tools/node_modules" : "node_modules", `@agile-team/wl-skills-${name}`);
  const real = realpathSync(directory);
  if (!real.startsWith(root + path.sep)) throw new Error("原生工具实际路径在项目外，不执行");
  const pkg = JSON.parse(readFileSync(path.join(real, "package.json")));
  const expected = { gate: fixedVersion, kit: "2.33.0", ui: "1.22.0", bd: "0.41.0" }[name];
  if (pkg.name !== `@agile-team/wl-skills-${name}` || pkg.version !== expected) throw new Error(`原生工具 ${name} 版本不匹配`);
  return { root: real, sha256: artifactDigest(real), version: pkg.version };
}
function stageCommand(id, executable, args) {
  return { id, executable, args, executableSha256: hash(readFileSync(executable)) };
}
function verifyHuskyDispatcher(root, packageRoot) {
  const output = safePath(root, ".husky/_/h"), source = path.join(packageRoot, "husky");
  if (!existsSync(source) || !lstatSync(source).isFile() || !existsSync(output) || !lstatSync(output).isFile() || hash(readFileSync(source)) !== hash(readFileSync(output)))
    throw new Error("Husky转发器不是固定本地包的实际h脚本，不凭存在性登记成功");
  for (const hook of ["pre-commit", "pre-push", "commit-msg"]) {
    const file = safePath(root, `.husky/_/${hook}`), expected = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';
    if (!existsSync(file) || !lstatSync(file).isFile() || !(lstatSync(file).mode & 0o111) || readFileSync(file, "utf8").trim() !== expected)
      throw new Error(`Husky ${hook} 实际可执行转发器未正确安装`);
  }
  const configured = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
  if (configured.status !== 0 || configured.stdout.trim().replaceAll(path.sep, "/") !== ".husky/_") throw new Error("Husky激活后实际hooksPath不匹配");
}
function nativePlan(root, kind, name, runner) {
  const source = tool(root, kind, name);
  const cli = path.join(source.root, `bin/${name === "kit" ? "wl-skills" : name === "ui" ? "wl-ui" : "wl-skills-bd"}.js`);
  const args = name === "bd" ? [cli, "update", "--target", root, "--json"]
    : name === "ui" ? [cli, "update", "--project", root, "--dry-run"] : [cli, "update", "--dry-run"];
  const preview = invoke(process.execPath, args, root, runner);
  let nativeHash = null;
  if (name === "bd" && preview.exitCode === 0) {
    try { nativeHash = JSON.parse(preview.stdout).planHash; } catch { throw new Error("BD 未返回可解析的实际更新计划"); }
    if (!/^[a-f0-9]{64}$/.test(nativeHash || "")) throw new Error("BD 实际更新计划缺少 planHash");
  }
  const applyArgs = name === "bd" ? [cli, "update", "--target", root, "--plan-hash", nativeHash, "--confirm", "--json"]
    : args.filter((arg) => arg !== "--dry-run");
  return { id: `native-${name}`, source, preview: { ...stageCommand(`native-${name}-preview`, process.execPath, args), ...preview },
    previewHash: hash(json(preview)), apply: stageCommand(`native-${name}-apply`, process.execPath, applyArgs) };
}
function pomPatch(root) {
  const file = safePath(root, "pom.xml"), beforeContent = readFileSync(file, "utf8"), tree = parseXml(beforeContent);
  if (tree.name !== "project") throw new Error("POM 使用了不支持的根/命名空间前缀，需后端负责人提供精确合并方案");
  const containers = tree.children.filter((node) => node.name === "profiles");
  if (containers.length > 1) throw new Error("根 POM 有重复 profiles，拒绝自动合并");
  const ids = (containers[0]?.children || []).filter((n) => n.name === "profile").map((n) => n.children.find((x) => x.name === "id")?.text.trim());
  if (new Set(ids).size !== ids.length) throw new Error("根 POM profile 身份重复，拒绝自动合并");
  let profiles = "";
  for (const name of ["audit", "unit"]) {
    if (ids.includes(`wl-quality-${name}`)) continue;
    const relative = `.github/java-quality/maven-snippets/quality-${name}-profile.xml`;
    const sourceFile = safePath(root, relative);
    if (!existsSync(sourceFile)) return { status: "pending-native-assets", required: relative };
    let snippet = readFileSync(sourceFile, "utf8");
    if (parseXml(snippet).name !== "profiles") throw new Error("BD Maven 模板根无效");
    snippet = snippet.match(/<profile>[\s\S]*<\/profile>/)?.[0];
    if (!snippet) throw new Error("BD Maven 模板没有唯一可合并 profile");
    if (name === "unit") snippet = snippet.replace("</includes>", [
      "  <include>com/jhict/produce/pl/common/ProductFormCodeTest.java</include>",
      "  <include>com/jhict/produce/pl/common/support/StableBusinessIdTest.java</include>",
      "  <include>com/jhict/produce/pl/performance/ActualHeatNumberTest.java</include>",
      "</includes>",
    ].join("\n"));
    profiles += `\n${snippet}\n`;
  }
  let afterContent = beforeContent;
  if (profiles) afterContent = containers.length ? beforeContent.replace(/<\/profiles>\s*(?=[\s\S]*<\/project>\s*$)/, `${profiles}</profiles>`)
    : beforeContent.replace(/<\/project>\s*$/, `\n<profiles>${profiles}</profiles>\n</project>\n`);
  const verified = parseXml(afterContent), final = verified.children.filter((n) => n.name === "profiles").flatMap((n) => n.children).filter((n) => n.name === "profile").map((n) => n.children.find((x) => x.name === "id")?.text.trim());
  if (!["wl-quality-audit", "wl-quality-unit"].every((id) => final.includes(id))) throw new Error("POM patch 未能添加明确 profile，拒绝应用");
  return { status: beforeContent === afterContent ? "unchanged" : "patch-planned", path: "pom.xml", beforeHash: hash(beforeContent), afterHash: hash(afterContent), beforeContent, afterContent,
    acceptance: "只合并缺失profile与已核对PL测试；已有profile保持。有效继承、插件执行、测试及覆盖率必须由真实首扫验证" };
}
function lockPlan(root, kind, runner) {
  const { policy } = loadConfig(root); const tools = {}, queries = [], seen = new Map();
  for (const check of policy.checks.filter((c) => c.required !== false)) {
    const command = check.versionCommand;
    if (typeof command !== "string") throw new Error(`${check.id} 缺少版本查询`);
    if (!seen.has(command)) {
      const tokens = command.trim().split(/\s+/); let executable, args;
      if (tokens.length === 2 && tokens[0] === "mvn" && tokens[1] === "-version") { executable = commandPath("mvn"); args = ["-version"]; }
      else if (tokens.length === 3 && tokens[0] === "node" && /^\S+\/bin\/[\w-]+\.js$/.test(tokens[1]) && tokens[2] === "--version") {
        const approved = Object.fromEntries((kind === "backend" ? [["bd", "wl-skills-bd"]] : [["kit", "wl-skills"], ["ui", "wl-ui"]])
          .map(([name, bin]) => [`${kind === "backend" ? "quality-tools/" : ""}node_modules/@agile-team/wl-skills-${name}/bin/${bin}.js`, name]));
        const relative = tokens[1], name = approved[relative];
        if (!name) throw new Error("版本查询不在固定argv白名单，不能只按目录前缀批准项目脚本");
        const native = tool(root, kind, name);
        executable = process.execPath; args = [safePath(native.root, `bin/${name === "bd" ? "wl-skills-bd" : name === "kit" ? "wl-skills" : "wl-ui"}.js`), "--version"];
      } else if (tokens.length === 2 && /^node_modules\/\.bin\/(?:eslint|vue-tsc)$/.test(tokens[0]) && tokens[1] === "--version") {
        executable = path.join(root, tokens[0]); args = ["--version"];
      } else throw new Error(`${check.id} 的 versionCommand 不在固定argv白名单；不得通过接入入口执行任意shell命令`);
      const result = invoke(executable, args, root, runner);
      if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(`${check.id} 实际版本查询失败：${result.stderr}`);
      seen.set(command, result.stdout.trim()); queries.push({ ...stageCommand(check.id, executable, args), ...result });
    }
    tools[check.id] = seen.get(command);
  }
  const relative = "quality/rules.lock.json", file = safePath(root, relative), beforeContent = existsSync(file) ? readFileSync(file, "utf8") : null;
  const afterContent = json({ lockVersion: 1, "wl-skills-gate": fixedVersion, tools });
  return { status: beforeContent === afterContent ? "unchanged" : "patch-planned", path: relative, beforeHash: beforeContent === null ? null : hash(beforeContent),
    afterHash: hash(afterContent), beforeContent, afterContent, queries, acceptance: "实际版本锁候选；中央批准登记与正式发布仍须独立审批" };
}
export function planCompleteOnboarding(base, options = {}) {
  const root = base.root, kind = base.projectKind, installRegistry = registry(options.registry);
  const manifestContent = base.files.find((file) => file.path === (kind === "backend" ? "quality-tools/package.json" : "package.json"))?.afterContent;
  const environment = onboardingEnvironment({ root, kind, manifestContent });
  const lifecycle = planLifecycle({ root, kind, manifestContent });
  const configurationChanges = base.files.some((f) => f.action !== "unchanged") || !!base.hooks.activation;
  let failedInstallation = false;
  const lastReceipt = safePath(root, "quality-reports/onboarding/execution.json");
  if (existsSync(lastReceipt)) {
    try { const previous = JSON.parse(readFileSync(lastReceipt)); failedInstallation = previous.stages?.some((stage) => stage.id === "dependencies-install" && stage.exitCode !== 0) === true; }
    catch { failedInstallation = true; }
  }
  const installRequired = failedInstallation || lifecycle.patches.some((patch) => patch.status === "pending-installation")
    || base.gaps.some((gap) => gap.id === "DEPENDENCY-INSTALL-REQUIRED" || gap.id === "LOCK-VERIFICATION-REQUIRED" && /(?:pnpm-lock|package-lock)/.test(gap.reason));
  const state = snapshotSource(root, { exclude: [".quality-onboarding-backups", ".quality-onboarding.lock", ".quality-onboarding-execution.lock"] });
  if (environment.blockers.length || lifecycle.blockers.length) return { schemaVersion: 1, status: "complete-preflight-blocked", registry: installRegistry,
    sourceDigest: state.digest, environment, lifecycle, installation: null, native: [], pom: null, lock: null, husky: null,
    blockers: [...environment.blockers, ...lifecycle.blockers], remainingStages: ["approved-environment-and-project-preparation"],
    remoteAcceptanceRequired: ["受保护分支与可信CI", "独立九维Review", "构建/部署证明", "飞书分类通知与授权关闭"] };
  let installation = null;
  if (installRequired) {
    const name = kind === "backend" ? "npm" : "pnpm", executable = commandPath(name);
    const args = kind === "backend" ? ["install", "--prefix", "quality-tools", "--include=dev", "--ignore-scripts", "--registry", installRegistry]
      : ["install", "--prod=false", "--ignore-scripts", "--registry", installRegistry];
    const sourceEvidence = registryInstallationEvidence({ root, kind, approved: installRegistry, executable, manager: name, manifestContent: base.files.find((file) => file.path === (kind === "backend" ? "quality-tools/package.json" : "package.json"))?.afterContent, runner: options.runner });
    args.push(...sourceEvidence.scopedRegistryOverrides, ...sourceEvidence.packageManagerFlags);
    installation = { ...stageCommand("dependencies-install", executable, args), registry: installRegistry, sourceEvidence,
      lifecycleScripts: false, acceptance: "安装固定清单并生成实际锁；不能代替原生资产、检查或项目整体验收" };
  }
  let commitType = "chore", commitScope = "quality";
  const catalogFile = safePath(root, ".wl-skills-bd/catalog.config.json");
  if (kind === "backend" && existsSync(catalogFile)) {
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    const scopes = Object.keys(catalog.modules || {}).filter((value) => /^[a-z][a-zA-Z0-9-]*$/.test(value));
    const types = (catalog.commit?.types || []).filter((value) => /^[a-z][a-z0-9-]*$/.test(value));
    if (!scopes.length || !types.length) throw new Error("BD模块/提交类型目录无效，不能编造合法提交正例");
    commitScope = scopes[0]; commitType = types.includes("chore") ? "chore" : types[0];
  }
  const plan = { schemaVersion: 1, status: configurationChanges || installRequired ? "bootstrap-approval-required" : "native-approval-required", registry: installRegistry,
    sourceDigest: state.digest, environment, lifecycle, installation, native: [], pom: null, lock: null, husky: null, blockers: [],
    hookSamples: { valid: `${commitType}(${commitScope}): 接入验收-验证提交流程\n`, invalid: "quality onboarding invalid subject\n" },
    remainingStages: ["approved-project-lifecycle-adapters", "native-preview-and-approved-sync", ...(kind === "backend" ? ["pom-exact-patch"] : []), "actual-version-lock", "doctor", "git-hook-first-scan", "negative-positive-commit-message"],
    remoteAcceptanceRequired: ["受保护分支与可信CI", "独立九维Review", "构建/部署证明", "飞书分类通知与授权关闭"] };
  const manager = installation?.sourceEvidence.packageManager;
  if (manager?.observed && manager.expected && manager.observed !== manager.expected) {
    plan.blockers.push({ id: "PACKAGE-MANAGER-VERSION", reason: `执行环境为${manager.observed}，项目固定${manager.expected}；使用批准的固定版本环境后重试，预览不下载或切换包管理器`, nextOwner: "运维/工程工具维护者" });
    plan.status = "complete-preflight-blocked";
  }
  if (configurationChanges || installRequired || base.hardConflicts.length) return plan;
  try {
    if (kind === "frontend" && base.hooks.configuredPath?.replaceAll(path.sep, "/") === ".husky/_") {
      const directory = realpathSync(path.join(root, "node_modules/husky"));
      if (!directory.startsWith(root + path.sep)) throw new Error("Husky必须使用项目内固定安装，不能调用全局工具");
      const pkg = JSON.parse(readFileSync(path.join(directory, "package.json")));
      if (pkg.name !== "husky" || !/^9\.\d+\.\d+$/.test(pkg.version)) throw new Error("Husky显式激活适配要求项目已安装9.x，其他版本需现有项目适配");
      const cli = path.join(directory, "bin.js");
      plan.husky = { ...stageCommand("husky-explicit-activation", process.execPath, [cli, ".husky"]), packageRoot: directory, packageSha256: artifactDigest(directory), version: pkg.version };
    }
    for (const name of kind === "backend" ? ["bd"] : ["kit", "ui"]) {
      const native = nativePlan(root, kind, name, options.runner); plan.native.push(native);
      if (native.preview.exitCode !== 0) plan.blockers.push({ id: native.id, reason: native.preview.stderr || native.preview.stdout, nextOwner: "工程工具维护者" });
    }
    if (kind === "backend") plan.pom = base.preset === "wl-produce-pl" ? pomPatch(root) : { status: "project-specific-review-required", reason: "非PL项目需提供经过审阅的POM patch，不套用PL的测试includes" };
    plan.lock = lockPlan(root, kind, options.runner);
    if (snapshotSource(root, { exclude: [".quality-onboarding-backups", ".quality-onboarding.lock", ".quality-onboarding-execution.lock"] }).digest !== state.digest)
      throw new Error("只读原生预览或版本查询改变了项目文件，拒绝批准");
  } catch (error) { plan.blockers.push({ id: "COMPLETE-PREFLIGHT", reason: error.message, nextOwner: "技术经理/工程工具维护者" }); }
  if (plan.blockers.length) plan.status = "complete-preflight-blocked";
  return plan;
}
function writeEvidence(root, relative, value, immutable = false) {
  const file = safePath(root, relative);
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root, encoding: "utf8" });
  if (tracked.status === 0) throw new Error("接入执行回执不能覆盖跟踪输入");
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, json(value), { mode: 0o600, ...(immutable ? { flag: "wx" } : {}) });
}
function applyPatch(root, patch, planHash) {
  if (patch.status === "unchanged") return;
  if (patch.status !== "patch-planned") throw new Error(`缺少可审阅的精确${patch.path || "POM"}方案`);
  const file = safePath(root, patch.path), current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if ((current === null ? null : hash(current)) !== patch.beforeHash) throw new Error(`${patch.path} 在确认后变化，拒绝覆盖`);
  if (current !== null) {
    const backup = safePath(root, `.quality-onboarding-backups/${planHash}/${patch.path}.complete`);
    mkdirSync(path.dirname(backup), { recursive: true });
    if (existsSync(backup) && readFileSync(backup, "utf8") !== current) throw new Error("接入patch备份冲突");
    if (!existsSync(backup)) writeFileSync(backup, current, { flag: "wx", mode: 0o600 });
  }
  const temp = safePath(root, `${patch.path}.onboard-${planHash.slice(0, 12)}.tmp`);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(temp, patch.afterContent, { flag: "wx", mode: 0o644 }); renameSync(temp, file);
}
export function executeCompleteOnboarding(plan, configurationResult, options = {}) {
  const root = plan.root, complete = plan.complete, records = [], receipt = { schemaVersion: 1, kind: "onboarding-execution", root,
    projectKind: plan.projectKind, planHash: plan.planHash, runId: randomUUID(), startedAt: new Date().toISOString(), stages: records,
    status: "running", localValidated: false, remoteValidated: false, businessClosureValidated: false };
  const finish = (status, extra = {}) => {
    Object.assign(receipt, extra, { status, completedAt: new Date().toISOString() });
    const relative = `quality-reports/onboarding/executions/${receipt.runId}.json`;
    writeEvidence(root, relative, receipt, true);
    writeEvidence(root, "quality-reports/onboarding/execution.json", { ...receipt, immutableReceipt: relative });
    return { ...configurationResult, status, complete: receipt, executionReceipt: path.join(root, relative),
      acceptance: "只报告实际阶段；localValidated也不代表远端接线、九维Review或业务关闭已验收" };
  };
  const run = (task) => {
    if (hash(readFileSync(task.executable)) !== task.executableSha256) throw new Error(`${task.id}执行器已变化`);
    const result = invoke(task.executable, task.args, root, options.runner); records.push({ ...task, ...result });
    if (result.exitCode !== 0) throw new Error(`${task.id} 退出${result.exitCode}；停止后续阶段`);
    return result;
  };
  const executionLock = safePath(root, ".quality-onboarding-execution.lock"); let lock;
  try { lock = openSync(executionLock, "wx", 0o600); }
  catch { return { ...configurationResult, status: "onboarding-execution-blocked", complete: { ...receipt, status: "not-started", failure: "已有接入执行锁，拒绝并发安装/资产/POM修改；核对原执行后处理", localValidated: false } }; }
  try {
    if (complete.blockers.length) return finish("complete-preflight-blocked", { blockers: complete.blockers });
    const environment = onboardingEnvironment({ root, kind: plan.projectKind });
    if (environment.blockers.length || environment.executable !== complete.environment.executable || environment.executableSha256 !== complete.environment.executableSha256 || environment.nodeVersion !== complete.environment.nodeVersion)
      throw new Error("Node执行环境确认后变化或不满足范围，拒绝执行接入");
    if (complete.installation) { run(complete.installation); const installedLock = verifyLockOrigins(root, plan.projectKind, complete.registry);
      if (!installedLock.present) throw new Error("安装器退出0但没有生成实际依赖锁，不记安装成功");
      for (const name of plan.projectKind === "backend" ? ["gate", "bd"] : ["gate", "kit", "ui"]) tool(root, plan.projectKind, name);
      records.push({ id: "installed-lock-origins", evidence: installedLock }); return finish("native-approval-required", { nextAction: "同一onboard --complete重新预览实际已安装工具差异，再确认其新planHash；无需拼装安装/update命令" }); }
    if (configurationResult.files.length || complete.status === "bootstrap-approval-required")
      return finish("native-approval-required", { nextAction: "本地配置已落定；同一入口重新预览并确认原生实际差异" });
    records.push(...applyLifecycle(root, complete.lifecycle, plan.planHash));
    for (const native of complete.native) {
      if (artifactDigest(native.source.root) !== native.source.sha256) throw new Error(`${native.id}原生包已变化`);
      const current = invoke(native.preview.executable, native.preview.args, root, options.runner);
      if (hash(json(current)) !== native.previewHash) return finish("native-approval-required", { nextAction: `${native.id}实际差异变化，重新预览；此前已完成阶段保留回执` });
      records.push({ id: native.id, packageVersion: native.source.version, packageSha256: native.source.sha256, previewHash: native.previewHash });
      run(native.apply);
    }
    if (complete.husky) {
      if (artifactDigest(complete.husky.packageRoot) !== complete.husky.packageSha256) throw new Error("Husky执行资产已变化，拒绝旧激活计划");
      run(complete.husky);
      verifyHuskyDispatcher(root, complete.husky.packageRoot);
    }
    if (complete.pom) {
      if (!["unchanged", "patch-planned"].includes(complete.pom.status)) return finish("pom-approval-required", { nextAction: "BD资产已同步；同一入口生成并确认实际POM before/after补丁，复杂POM由后端负责人审阅" });
      applyPatch(root, complete.pom, plan.planHash); records.push({ id: "pom-patch", status: complete.pom.status, beforeHash: complete.pom.beforeHash, afterHash: complete.pom.afterHash });
    }
    if (!complete.lock) return finish("lock-approval-required", { nextAction: "同一入口采集实际工具版本并审阅版本锁候选" });
    const actualLock = lockPlan(root, plan.projectKind, options.runner);
    if (actualLock.afterHash !== complete.lock.afterHash) throw new Error("确认后实际工具版本变化，拒绝写入旧锁");
    applyPatch(root, complete.lock, plan.planHash); records.push({ id: "actual-version-lock", status: complete.lock.status, afterHash: complete.lock.afterHash, actualVersionQueries: actualLock.queries });
    const readiness = doctor({ root, kind: plan.projectKind }); records.push({ id: "doctor", result: readiness });
    if (readiness.status !== "ready-for-local-validation") return finish("local-readiness-blocked", { gaps: readiness.checks.filter((c) => c.status !== "passed") });
    const legacy = plan.gaps.filter((g) => ["LEGACY-SILENT-REPAIR", "LEGACY-DUPLICATE-CHECK", ...(complete.husky ? [] : ["HUSKY-DISPATCHER-REQUIRED"])].includes(g.id));
    if (legacy.length) return finish("local-readiness-blocked", { gaps: legacy });
    // Actual Git dispatch, no commit/push, no remote write. The existing approved Hook is retained.
    const gitPath = commandPath("git"), scan = stageCommand("git-pre-push-first-scan", gitPath, ["hook", "run", "pre-push"]);
    const before = safePath(root, "quality-reports/quality-summary.json"), oldHash = existsSync(before) ? hash(readFileSync(before)) : null;
    const scanSource = snapshotSource(root, { exclude: [".quality-onboarding-backups", ".quality-onboarding.lock", ".quality-onboarding-execution.lock"] });
    run(scan);
    if (!existsSync(before) || hash(readFileSync(before)) === oldHash) throw new Error("实际Hook未生成新报告，不能登记首扫通过");
    const reportValidity = validateReportFile(before);
    if (!reportValidity.ok) throw new Error("首扫报告结构或检查证据无效，不能登记通过：" + reportValidity.errors.join("; "));
    const report = JSON.parse(readFileSync(before));
    const source = snapshotSource(root, { exclude: [".quality-onboarding-backups", ".quality-onboarding.lock", ".quality-onboarding-execution.lock"] });
    if (source.digest !== scanSource.digest) throw new Error("实际Hook检查期间或其后修改了项目源码；拒绝登记只读验收通过");
    const configured = loadConfig(root), selected = configured.policy.checks.filter((check) => check.profiles.includes("standard"));
    const requiredIds = selected.filter((check) => check.required !== false).map((check) => check.id).sort();
    const equalIds = (left, right) => Array.isArray(left) && left.length === right.length && [...left].sort().every((id, i) => id === right[i]);
    if (!equalIds(report.policy?.requiredCheckIds, requiredIds) || !equalIds(report.checks?.map((check) => check.checkId), selected.map((check) => check.id).sort()))
      throw new Error("首扫报告遗漏/篡改实际策略必需检查，不能按报告自报清单验收");
    if (selected.some((check) => !report.checks.some((actual) => actual.checkId === check.id && actual.tool === check.tool && (check.required === false || actual.required === true)))
      || requiredIds.some((id) => report.policy?.lockedToolVersions?.[id] !== configured.ruleSet?.tools?.[id]))
      throw new Error("首扫实际检查身份/工具锁与项目策略不一致");
    const proofErrors = validatePassingSummary(report, { sha: source.sha, project: configured.policy.project, profile: "standard",
      expectPolicyHash: configured.policyHash, expectRulesHash: configured.ruleSetHash, expectBaselineHash: configured.baselineHash, expectWaiversHash: configured.waiversHash });
    // Local onboarding includes newly generated/uncommitted configuration. Preserve sourceBound=false;
    // only the immutable-checkout requirement is inapplicable locally, after exact source digest checks.
    const localErrors = report.run?.sourceBound === false && report.run?.sourceDigest === scanSource.digest
      ? proofErrors.filter((error) => error !== "报告未绑定不可变的真实 checkout") : proofErrors;
    if (report.run?.root !== root || report.run?.sourceDigest !== scanSource.digest || report.run?.scope || report.run?.base || report.run?.head || localErrors.length)
      throw new Error("首扫证据不符合项目、源码、四项摘要、实际工具与完整检查验收：" + localErrors.join("; "));
    records.push({ id: "passing-summary-validation", sourceDigest: source.digest, sourceBound: report.run.sourceBound, dirtyLocalCheckout: source.dirty,
      formalProofEligible: report.run.sourceBound === true && !source.dirty, requiredCheckIds: requiredIds });
    const positive = "quality-reports/onboarding/valid-commit.txt", negative = "quality-reports/onboarding/invalid-commit.txt";
    for (const [relative, text] of [[positive, complete.hookSamples.valid], [negative, complete.hookSamples.invalid]]) {
      if (spawnSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root }).status === 0) throw new Error("Hook验证输入不能覆盖跟踪文件");
      const file = safePath(root, relative); if (existsSync(file) && !lstatSync(file).isFile()) throw new Error("Hook验证输入非普通文件");
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 });
    }
    run(stageCommand("git-commit-message-positive", gitPath, ["hook", "run", "commit-msg", "--", positive]));
    const negativeTask = stageCommand("git-commit-message-negative", gitPath, ["hook", "run", "commit-msg", "--", negative]);
    const bad = invoke(negativeTask.executable, negativeTask.args, root, options.runner); records.push({ ...negativeTask, ...bad });
    if (bad.exitCode !== 1 || !/\[commit-message\]/.test(bad.stdout + bad.stderr)) throw new Error("违规提交说明未由实际Gate规则正常拦截；执行异常也不算验收通过");
    return finish("local-validated-awaiting-remote-acceptance", { localValidated: true, reportEventId: report.run.eventId, reportSha256: hash(readFileSync(before)), commitSha: source.sha });
  } catch (error) { return finish("onboarding-execution-blocked", { failure: error.message, nextAction: "保留实际已完成阶段和备份；修复明确失败后，用同一入口重新预览与确认，不自动重试未知副作用" }); }
  finally { if (lock !== undefined) { closeSync(lock); rmSync(executionLock); } }
}
