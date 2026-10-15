import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { safePath, snapshotSource, artifactDigest } from "./source-state.js";
import { stableStringify } from "./util.js";
import { onboardingEnvironment } from "./onboard-environment.js";
import { registryInstallationEvidence, verifyLockOrigins } from "./onboard-registry.js";
import { planLifecycle, applyLifecycle } from "./onboard-lifecycle.js";
import { doctor } from "./doctor.js";
import { loadConfig } from "./config.js";
import { validateReportFile } from "./validate-report.js";
import { validatePassingSummary } from "./evidence.js";
import { redactLog } from "./exec.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"))).version;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const EXCLUDE = [".quality-workspace.lock", ".quality-onboarding-backups", ".quality-onboarding.lock", ".quality-onboarding-execution.lock"];
const RECEIPT = "quality-reports/onboarding/workspace-execution.json";
const NAME = "quality/workspace.json";
const semver = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function git(root, args, optional = false) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error(`Git 核验失败：${args[0]}`);
  }
  return result.stdout.trim();
}

function projectRoot(value) {
  const supplied = path.resolve(value);
  if (!existsSync(supplied) || !lstatSync(supplied).isDirectory() || lstatSync(supplied).isSymbolicLink()) throw new Error("工作区必须是实际项目目录，不能是符号链接");
  const root = realpathSync(supplied);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("工作区初始化必须指向实际业务 Git 根，不能指向聚合根或子目录");
  return root;
}

function committed(root, relative) {
  const file = safePath(root, relative);
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`缺少已接入文件：${relative}`);
  const result = spawnSync("git", ["-C", root, "show", `HEAD:${relative}`], { shell: false });
  if (result.status !== 0 || hash(result.stdout) !== hash(readFileSync(file))) throw new Error(`${relative} 必须已提交且与 HEAD 一致；先审阅提交接入配置，不能在初始化时批准临时替换`);
  return { path: relative, sha256: hash(readFileSync(file)) };
}

function commandPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    const file = path.join(directory, name);
    if (existsSync(file) && (lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) return realpathSync(file);
  }
  throw new Error(`缺少批准执行器 ${name}；不会通过 npx/Corepack 下载或切换包管理器`);
}

function command(id, executable, args) {
  return { id, executable, executableSha256: hash(readFileSync(executable)), args };
}

function approvedRegistry(value) {
  let url; try { url = new URL(value); } catch { throw new Error("工作区清单缺少有效批准安装源"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("工作区安装源必须是无凭据、查询参数的 HTTPS URL");
  return url.href;
}

function declaration(pkg, name) {
  const buckets = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].filter((bucket) => pkg[bucket]?.[name] !== undefined);
  if (buckets.length !== 1 || !semver.test(pkg[buckets[0]]?.[name] || "")) throw new Error(`${name} 必须在唯一依赖类别声明明确固定版本`);
  return pkg[buckets[0]][name];
}

function installedTools(root, directory, dependencies) {
  return dependencies.map(({ name, version }) => {
    try {
      const source = path.join(root, directory, "node_modules", name), actual = realpathSync(source);
      if (!actual.startsWith(root + path.sep)) throw new Error("安装路径在项目外");
      const pkg = JSON.parse(readFileSync(safePath(actual, "package.json")));
      if (pkg.name !== name || pkg.version !== version) throw new Error("安装身份或版本不同");
      return { name, version, root: actual, sha256: artifactDigest(actual), installed: true };
    } catch (error) { return { name, version, installed: false, reason: error.message }; }
  });
}

function huskyPlan(root, hooksPath, installation) {
  if (hooksPath !== ".husky/_") return null;
  try {
    const location = path.join(root, "node_modules/husky");
    if (!existsSync(location)) {
      if (installation) return { status: "pending-installation" };
      throw new Error("Husky 激活必须使用项目内固定安装，不能调用全局工具");
    }
    const directory = realpathSync(location);
    if (!directory.startsWith(root + path.sep)) throw new Error("Husky 安装位于项目外");
    const pkg = JSON.parse(readFileSync(safePath(directory, "package.json")));
    if (pkg.name !== "husky" || !/^9\.\d+\.\d+$/.test(pkg.version)) throw new Error("工作区仅支持已核对的本地 Husky 9 激活，其他版本需固定适配");
    return { status: "activation-planned", packageRoot: directory, packageSha256: artifactDigest(directory), version: pkg.version,
      ...command("husky-explicit-activation", process.execPath, [safePath(directory, "bin.js"), ".husky"]) };
  } catch (error) {
    if (installation) return { status: "pending-installation", reason: error.message };
    throw error;
  }
}

function verifyHusky(root, approved) {
  const h = safePath(root, ".husky/_/h"), source = safePath(approved.packageRoot, "husky");
  if (!existsSync(h) || !lstatSync(h).isFile() || hash(readFileSync(h)) !== hash(readFileSync(source))) throw new Error("Husky 转发器不等于固定本地包资产");
  for (const name of ["pre-commit", "pre-push", "commit-msg"]) {
    const file = safePath(root, `.husky/_/${name}`);
    if (!existsSync(file) || !lstatSync(file).isFile() || !(lstatSync(file).mode & 0o111) || readFileSync(file, "utf8").trim() !== '#!/usr/bin/env sh\n. "$(dirname "$0")/h"')
      throw new Error(`Husky ${name} 真实转发器未正确安装`);
  }
}

function initializationInputs(plan, tools, husky = plan.husky) {
  return { manifest: plan.manifest.sha256, package: plan.package.sha256, lock: plan.lock.sha256, environment: plan.environment,
    manager: { executable: plan.manager.executable, executableSha256: plan.manager.executableSha256 }, tools,
    husky: husky?.status === "activation-planned" ? { packageRoot: husky.packageRoot, packageSha256: husky.packageSha256, version: husky.version } : null };
}

/** Read-only plan for an already adopted clone. Never regenerates project rules, POMs or native assets. */
export function planWorkspaceInitialization({ root: requestedRoot = ".", runner = spawnSync } = {}) {
  const root = projectRoot(requestedRoot), plan = { schemaVersion: 1, kind: "workspace-initialization", root,
    status: "workspace-planned", blockers: [], installation: null, lifecycle: null, husky: null,
    localValidated: false, remoteValidated: false, businessClosureValidated: false,
    excludedActions: ["重写项目规则/POM/策略", "原生包 update", "业务代码修复", "远端操作", "发布/通知/问题关闭"] };
  try {
    const initialSource = snapshotSource(root, { exclude: EXCLUDE });
    if (git(root, ["check-ignore", "--", ".quality-workspace.lock"], true) === null) throw new Error("已接配置缺少工作区锁忽略规则 /.quality-workspace.lock；由接入负责人补入批准配置后提交，初始化不改 .gitignore");
    plan.manifest = committed(root, NAME);
    const manifest = JSON.parse(readFileSync(safePath(root, NAME), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.kind !== "wl-quality-workspace" || !["frontend", "backend"].includes(manifest.projectKind)) throw new Error("已提交工作区清单版本、类型或项目范围无效");
    const kind = manifest.projectKind, directory = kind === "backend" ? "quality-tools" : ".";
    if (manifest.gateVersion !== VERSION) throw new Error(`工作区要求 Gate ${manifest.gateVersion}，当前执行 ${VERSION}；使用批准固定版本后重试`);
    if (manifest.dependencyDirectory !== directory) throw new Error("依赖目录与已接项目类型不一致；不在聚合根或其他项目安装工具");
    if (typeof manifest.hooksPath !== "string" || !manifest.hooksPath || path.isAbsolute(manifest.hooksPath) || manifest.hooksPath.includes("\\") || manifest.hooksPath.split("/").some((part) => ["", ".", "..", ".git", "node_modules"].includes(part))) throw new Error("清单 Hook 路径必须是项目内明确相对目录");
    safePath(root, `${manifest.hooksPath}/.workspace-hook-probe`);
    plan.projectKind = kind; plan.registry = approvedRegistry(manifest.registry); plan.dependencyDirectory = directory;
    const packagePath = kind === "backend" ? "quality-tools/package.json" : "package.json";
    plan.package = committed(root, packagePath);
    const pkg = JSON.parse(readFileSync(safePath(root, packagePath), "utf8"));
    if (kind === "frontend" && (!pkg.dependencies?.vue && !pkg.devDependencies?.vue || existsSync(path.join(root, "pages.json"))
      || Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).some((name) => /^(?:@dcloudio\/|@tarojs\/|uni-app$|mpvue$|wepy$|react$|react-dom$|react-native$|miniprogram-api-typings$)/.test(name))
      || Object.values(pkg.scripts || {}).some((value) => typeof value === "string" && /(?:\buni\b|mp-weixin|mp-alipay|build:mp-)/.test(value)))) throw new Error("工作区清单不能把移动/小程序/其他技术栈声明为 PC Vue 配套");
    if (kind === "backend" && !existsSync(safePath(root, "pom.xml"))) throw new Error("后端工作区缺少 Maven 根 POM");
    const managerName = kind === "frontend" ? "pnpm" : "npm";
    if (kind === "frontend" ? !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager || "") || pkg.packageManager !== manifest.packageManager : manifest.packageManager !== "npm") throw new Error("工作区清单包管理器与固定项目声明不一致");
    plan.dependencies = (kind === "backend" ? ["gate", "bd"] : ["gate", "kit", "ui"]).map((key) => {
      const name = `@agile-team/wl-skills-${key}`; return { name, version: declaration(pkg, name) };
    });
    if (plan.dependencies[0].version !== manifest.gateVersion) throw new Error("工作区清单 Gate 版本与已提交依赖声明不同");
    plan.lock = committed(root, kind === "backend" ? "quality-tools/package-lock.json" : "pnpm-lock.yaml");
    const executable = commandPath(managerName);
    plan.manager = command("dependency-manager", executable, []);
    plan.git = command("git-dispatch", commandPath("git"), []);
    plan.environment = onboardingEnvironment({ root, kind });
    if (plan.environment.blockers.length) plan.blockers.push(...plan.environment.blockers);
    const sourceEvidence = registryInstallationEvidence({ root, kind, approved: plan.registry, executable, manager: managerName, runner });
    if (!sourceEvidence.lock.present) throw new Error("已接工作区缺少依赖锁，不能降级为首次 install 生成锁");
    if (kind === "frontend" && sourceEvidence.packageManager.observed !== manifest.packageManager) throw new Error(`实际包管理器 ${sourceEvidence.packageManager.observed || "无法核验"} 与 ${manifest.packageManager} 不同；使用批准环境，不自动下载切换`);
    plan.registryEvidence = sourceEvidence;
    const sourceDirectory = manifest.hooksPath === ".husky/_" ? ".husky" : manifest.hooksPath;
    const requiredHooks = kind === "frontend" ? ["pre-commit", "pre-push", "commit-msg"] : ["pre-push", "commit-msg"];
    if (!Array.isArray(manifest.hookFiles) || manifest.hookFiles.length !== requiredHooks.length || new Set(manifest.hookFiles.map((file) => file?.path)).size !== requiredHooks.length) throw new Error("工作区清单 Hook 文件缺失、重复或范围不匹配");
    plan.hooks = { path: manifest.hooksPath, before: git(root, ["config", "--path", "--get", "core.hooksPath"], true),
      localBefore: git(root, ["config", "--local", "--get", "core.hooksPath"], true), files: [] };
    if (plan.hooks.before !== null && plan.hooks.before.replaceAll(path.sep, "/") !== manifest.hooksPath) throw new Error(`当前 core.hooksPath=${plan.hooks.before} 与批准路径 ${manifest.hooksPath} 不同；先人工审阅冲突，不替换`);
    for (const name of requiredHooks) {
      const relative = `${sourceDirectory}/${name}`, declared = manifest.hookFiles.find((file) => file?.path === relative), actual = committed(root, relative);
      if (!declared || !/^[a-f0-9]{64}$/.test(declared.sha256 || "") || declared.sha256 !== actual.sha256) throw new Error(`批准 Hook 文件缺失或内容漂移：${relative}`);
      if (!(lstatSync(safePath(root, relative)).mode & 0o111)) throw new Error(`批准 Hook 不可执行：${relative}；在接入资产中修正，不在新克隆静默改规则`);
      plan.hooks.files.push(actual);
    }
    plan.hooks.activationRequired = plan.hooks.localBefore === null;
    plan.tools = installedTools(root, directory, plan.dependencies);
    plan.husky = huskyPlan(root, manifest.hooksPath, true);
    plan.lifecycle = planLifecycle({ root, kind });
    plan.blockers.push(...plan.lifecycle.blockers);
    let previous;
    if (existsSync(safePath(root, RECEIPT))) { try { previous = JSON.parse(readFileSync(safePath(root, RECEIPT), "utf8")); } catch { /* A broken receipt cannot authorize skipping installation. */ } }
    const inputs = initializationInputs(plan, plan.tools);
    const installationCurrent = plan.tools.every((tool) => tool.installed) && previous?.installationState
      && stableStringify(inputs) === stableStringify(previous.installationState)
      && !plan.lifecycle.patches.some((patch) => patch.status === "pending-installation")
      && !previous.stages?.some((stage) => stage.id === "dependencies-install" && stage.exitCode !== 0);
    if (!installationCurrent) {
      const args = kind === "backend" ? ["ci", "--prefix", "quality-tools", "--include=dev", "--ignore-scripts", "--registry", plan.registry]
        : ["install", "--frozen-lockfile", "--prod=false", "--ignore-scripts", "--registry", plan.registry];
      args.push(...sourceEvidence.scopedRegistryOverrides, ...sourceEvidence.packageManagerFlags);
      plan.installation = { ...command("dependencies-install", executable, args), lifecycleScripts: false };
    }
    if (!plan.installation && plan.husky?.status === "pending-installation") throw new Error("已锁 Husky 不完整，不能跳过固定安装");
    plan.source = snapshotSource(root, { exclude: EXCLUDE });
    if (plan.source.digest !== initialSource.digest || plan.source.sha !== initialSource.sha) throw new Error("只读工作区预检改变了项目源码，拒绝批准");
    plan.implementation = ["lib/workspace-init.js", "lib/onboard-registry.js", "lib/onboard-environment.js", "lib/onboard-lifecycle.js", "lib/source-state.js", "lib/doctor.js", "lib/evidence.js", "lib/validate-report.js"].map((relative) => ({ path: relative, sha256: hash(readFileSync(path.join(PACKAGE_ROOT, relative))) }));
  } catch (error) { plan.blockers.push({ id: "WORKSPACE-PREFLIGHT", reason: error.message, nextOwner: "工程工具维护者/项目负责人" }); }
  if (plan.blockers.length) plan.status = "workspace-blocked";
  plan.planHash = hash(stableStringify(plan));
  return plan;
}

function validateFirstScan(root, beforeDigest, source) {
  const file = safePath(root, "quality-reports/quality-summary.json");
  if (!existsSync(file) || hash(readFileSync(file)) === beforeDigest) throw new Error("实际 Hook 未生成新报告，不能使用历史绿报告登记初始化成功");
  const validation = validateReportFile(file);
  if (!validation.ok) throw new Error("首扫报告结构无效：" + validation.errors.join("; "));
  const report = JSON.parse(readFileSync(file)), after = snapshotSource(root, { exclude: EXCLUDE });
  if (after.digest !== source.digest || after.sha !== source.sha) throw new Error("实际 Hook 检查期间或其后修改了项目源码，不能登记只读验收通过");
  const configured = loadConfig(root), selected = configured.policy.checks.filter((check) => check.profiles.includes("standard"));
  const requiredIds = selected.filter((check) => check.required !== false).map((check) => check.id).sort();
  const equals = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((id, index) => id === b[index]);
  if (!equals(report.policy?.requiredCheckIds, requiredIds) || !equals(report.checks?.map((check) => check.checkId), selected.map((check) => check.id).sort())) throw new Error("首扫报告遗漏或篡改实际策略必需检查");
  if (selected.some((check) => !report.checks.some((actual) => actual.checkId === check.id && actual.tool === check.tool && (check.required === false || actual.required === true)))
    || requiredIds.some((id) => report.policy?.lockedToolVersions?.[id] !== configured.ruleSet?.tools?.[id])) throw new Error("首扫实际检查身份/工具锁与项目策略不一致");
  const errors = validatePassingSummary(report, { sha: after.sha, project: configured.policy.project, profile: "standard", expectPolicyHash: configured.policyHash,
    expectRulesHash: configured.ruleSetHash, expectBaselineHash: configured.baselineHash, expectWaiversHash: configured.waiversHash });
  const localErrors = report.run?.sourceBound === false && report.run?.sourceDigest === source.digest ? errors.filter((error) => error !== "报告未绑定不可变的真实 checkout") : errors;
  if (report.run?.root !== root || report.run?.sourceDigest !== source.digest || report.run?.scope || report.run?.base || report.run?.head || localErrors.length) throw new Error("首扫证据与项目、源码、策略或完整检查不一致：" + localErrors.join("; "));
  return { reportEventId: report.run.eventId, reportSha256: hash(readFileSync(file)), commitSha: after.sha, sourceDigest: source.digest,
    sourceBound: report.run.sourceBound, formalProofEligible: report.run.sourceBound === true && !after.dirty };
}

/** Apply only this reviewed local initialization plan. No implicit approval, repair, native update or remote access. */
export function applyWorkspaceInitialization({ root = ".", planHash, confirm, runner = spawnSync } = {}) {
  if (!confirm || !/^[a-f0-9]{64}$/.test(planHash || "")) throw new Error("初始化必须携带实际 planHash 与显式 confirm");
  let plan = planWorkspaceInitialization({ root, runner });
  if (plan.planHash !== planHash) throw new Error("工作区、清单、锁、工具或执行计划已变化，planHash 不一致，零写入");
  if (plan.blockers.length) return { ...plan, status: "workspace-initialization-blocked" };
  root = plan.root;
  const lockPath = safePath(root, ".quality-workspace.lock"); let lock;
  try { lock = openSync(lockPath, "wx", 0o600); } catch { return { ...plan, status: "workspace-initialization-blocked", failure: "已有工作区初始化执行锁，拒绝并发安装或切换 Hook" }; }
  const stages = [], receipt = { schemaVersion: 1, kind: "workspace-initialization-execution", root, projectKind: plan.projectKind,
    planHash, runId: randomUUID(), startedAt: new Date().toISOString(), stages, localValidated: false, remoteValidated: false, businessClosureValidated: false };
  const finish = (status, extra = {}) => {
    Object.assign(receipt, extra, { status, completedAt: new Date().toISOString() });
    const relative = `quality-reports/onboarding/workspaces/${receipt.runId}.json`;
    for (const [name, immutable] of [[relative, true], [RECEIPT, false]]) {
      if (git(root, ["ls-files", "--error-unmatch", "--", name], true) !== null) throw new Error("工作区回执不能覆盖已跟踪输入");
      const file = safePath(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, json(receipt), { mode: 0o600, ...(immutable ? { flag: "wx" } : {}) });
    }
    return { ...receipt, executionReceipt: path.join(root, relative), complete: receipt,
      acceptance: "仅本地工作区初始化与真实 Hook 验收；远端、Review、发布和业务关闭仍须独立验收" };
  };
  const run = (task, allowFailure = false) => {
    if (hash(readFileSync(task.executable)) !== task.executableSha256) throw new Error(`${task.id} 执行器在确认后变化`);
    const result = runner(task.executable, task.args, { cwd: root, shell: false, encoding: "utf8", timeout: 1200000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "true" } });
    const record = { ...task, exitCode: Number.isInteger(result.status) ? result.status : 2, stdout: redactLog(result.stdout || ""), stderr: redactLog(result.stderr || result.error?.message || result.signal || "") };
    stages.push(record);
    if (record.exitCode !== 0 && !allowFailure) throw new Error(`${task.id} 退出${record.exitCode}；停止后续阶段，查看实际日志与报告`);
    return record;
  };
  try {
    const latest = planWorkspaceInitialization({ root, runner });
    if (latest.planHash !== planHash || latest.blockers.length) throw new Error("取得执行锁后工作区计划变化，零写入");
    plan = latest;
    if (plan.installation) {
      run(plan.installation);
      const origins = verifyLockOrigins(root, plan.projectKind, plan.registry), tools = installedTools(root, plan.dependencyDirectory, plan.dependencies);
      if (!origins.present || origins.sha256 !== plan.lock.sha256 || tools.some((tool) => !tool.installed)) throw new Error("固定安装没有保留批准锁或完整安装声明工具，不记安装成功");
      if (snapshotSource(root, { exclude: EXCLUDE }).digest !== plan.source.digest) throw new Error("依赖安装修改了项目源码、规则或配置，停止初始化");
      receipt.installationState = initializationInputs(plan, tools, huskyPlan(root, plan.hooks.path, null));
      return finish("workspace-approval-required", { nextAction: "固定依赖已安装；同一入口重新展示实际依赖准备与 Hook 激活计划并确认，不自动批准安装后才出现的差异" });
    }
    receipt.installationState = initializationInputs(plan, plan.tools);
    stages.push(...applyLifecycle(root, plan.lifecycle, planHash));
    const beforeHooks = git(root, ["config", "--path", "--get", "core.hooksPath"], true);
    if (beforeHooks !== plan.hooks.before) throw new Error("确认后 core.hooksPath 变化，拒绝激活");
    if (plan.husky) {
      if (plan.husky.status !== "activation-planned" || artifactDigest(plan.husky.packageRoot) !== plan.husky.packageSha256) throw new Error("Husky 安装资产变化或尚未准备，重新预览");
      run(plan.husky); verifyHusky(root, plan.husky);
    } else if (plan.hooks.activationRequired) git(root, ["config", "--local", "core.hooksPath", plan.hooks.path]);
    if (git(root, ["config", "--local", "--get", "core.hooksPath"]) !== plan.hooks.path) throw new Error("本机实际 Hook 路径与批准清单不同");
    stages.push({ id: "approved-hook-activation", before: beforeHooks, after: plan.hooks.path, files: plan.hooks.files });
    if (snapshotSource(root, { exclude: EXCLUDE }).digest !== plan.source.digest) throw new Error("依赖准备或 Hook 激活修改了项目源码、规则或配置");
    const readiness = doctor({ root, kind: plan.projectKind }); stages.push({ id: "doctor", result: readiness });
    if (readiness.status !== "ready-for-local-validation") return finish("workspace-initialization-blocked", { gaps: readiness.checks.filter((check) => check.status !== "passed") });
    const reportFile = safePath(root, "quality-reports/quality-summary.json"), oldDigest = existsSync(reportFile) ? hash(readFileSync(reportFile)) : null;
    if (hash(readFileSync(plan.git.executable)) !== plan.git.executableSha256 || commandPath("git") !== plan.git.executable) throw new Error("确认后 Git 执行器变化，重新预览");
    const gitPath = plan.git.executable, source = snapshotSource(root, { exclude: EXCLUDE });
    run(command("git-pre-push-first-scan", gitPath, ["hook", "run", "pre-push"]));
    if (git(root, ["config", "--local", "--get", "core.hooksPath"]) !== plan.hooks.path) throw new Error("首扫 Hook 改变了本地 hooksPath，不能登记通过");
    const evidence = validateFirstScan(root, oldDigest, source);
    let type = "chore", scope = "quality";
    const catalogPath = safePath(root, ".wl-skills-bd/catalog.config.json");
    if (plan.projectKind === "backend" && existsSync(catalogPath)) {
      const catalog = JSON.parse(readFileSync(catalogPath)), types = (catalog.commit?.types || []).filter((value) => /^[a-z][a-z0-9-]*$/.test(value));
      const scopes = Object.keys(catalog.modules || {}).filter((value) => /^[a-z][a-zA-Z0-9-]*$/.test(value));
      if (!types.length || !scopes.length) throw new Error("BD 提交类型/模块目录无效，不能编造合法提交正例");
      type = types.includes("chore") ? "chore" : types[0]; scope = scopes[0];
    }
    const positive = `quality-reports/onboarding/workspace-${receipt.runId}-valid.txt`, negative = `quality-reports/onboarding/workspace-${receipt.runId}-invalid.txt`;
    for (const [relative, text] of [[positive, `${type}(${scope}): 初始化验收-验证提交流程\n`], [negative, "workspace invalid commit subject\n"]]) {
      if (git(root, ["ls-files", "--error-unmatch", "--", relative], true) !== null) throw new Error("Hook 样例不能覆盖跟踪输入");
      const file = safePath(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    }
    run(command("git-commit-message-positive", gitPath, ["hook", "run", "commit-msg", "--", positive]));
    const bad = run(command("git-commit-message-negative", gitPath, ["hook", "run", "commit-msg", "--", negative]), true);
    if (bad.exitCode !== 1 || !/\[commit-message\]/.test(bad.stdout + bad.stderr)) throw new Error("违规提交说明未被真实 Gate 正常拦截；执行器异常不算验证通过");
    const after = snapshotSource(root, { exclude: EXCLUDE });
    if (after.digest !== source.digest || after.sha !== source.sha) throw new Error("提交说明 Hook 改变源码，不能登记只读验收通过");
    if (git(root, ["config", "--local", "--get", "core.hooksPath"]) !== plan.hooks.path) throw new Error("提交说明 Hook 改变了本地 hooksPath，不能登记通过");
    return finish("local-validated-awaiting-remote-acceptance", { ...evidence, localValidated: true });
  } catch (error) { return finish("workspace-initialization-blocked", { failure: error.message, nextAction: "保留真实已完成阶段；修复实际失败后同一入口重新预览和确认，不自动降低规则或修改源码" }); }
  finally { closeSync(lock); rmSync(lockPath); }
}
