import path from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, rmSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planWorkspaceInitialization } from "./workspace-init.js";
import { planLifecycle, applyLifecycle } from "./onboard-lifecycle.js";
import { verifyLockOrigins } from "./onboard-registry.js";
import { safePath, snapshotSource, artifactDigest, git } from "./source-state.js";
import { stableStringify } from "./util.js";
import { redactLog } from "./exec.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const EXCLUDE = [".quality-workspace.lock", ".quality-onboarding-backups"];
const assert = (ok, message) => { if (!ok) throw new Error(message); };

// Use the same committed adoption contract as local initialization. CI prepares
// dependencies only: it never changes hooks, native rules, POM or project code.
export function planCiPreparation({ root = ".", runner = spawnSync } = {}) {
  const workspace = planWorkspaceInitialization({ root, runner });
  const blockers = [...workspace.blockers];
  if (workspace.source?.dirty) blockers.push({ id: "CI-CHECKOUT-DIRTY", reason: "CI必须使用干净、已提交的真实checkout；准备任务不替项目提交、清理或修复源码" });
  let installation = null;
  if (!blockers.length) {
    const args = workspace.projectKind === "backend" ? ["ci", "--prefix", "quality-tools", "--include=dev", "--ignore-scripts", "--registry", workspace.registry]
      : ["install", "--frozen-lockfile", "--prod=false", "--ignore-scripts", "--registry", workspace.registry];
    args.push(...workspace.registryEvidence.scopedRegistryOverrides, ...workspace.registryEvidence.packageManagerFlags);
    installation = { id: "dependencies-install", executable: workspace.manager.executable, executableSha256: workspace.manager.executableSha256, args };
  }
  const plan = { schemaVersion: 1, kind: "ci-dependency-preparation", status: blockers.length ? "blocked" : "preview", root: workspace.root,
    projectKind: workspace.projectKind, workspaceHash: workspace.manifest?.sha256, lockHash: workspace.lock?.sha256,
    blockers, installation, lifecycle: workspace.lifecycle, workspace,
    implementation: digest(readFileSync(path.join(ROOT, "lib/ci-prepare.js"))),
    boundaries: ["不执行项目/依赖生命周期脚本", "只应用随固定Gate交付的已核对依赖准备适配", "不安装Hook或运行重复首扫", "不修业务代码、不升级规则、不批准Review或发布"] };
  plan.planHash = digest(stableStringify(plan));
  return plan;
}

export function prepareCiDependencies({ root = ".", confirm = false, expectWorkspaceHash, expectLockHash, runner = spawnSync } = {}) {
  assert(confirm === true && HASH.test(expectWorkspaceHash || "") && HASH.test(expectLockHash || ""), "CI执行要求显式确认和中央批准的工作副本清单/依赖锁两个摘要");
  let plan = planCiPreparation({ root, runner });
  if (plan.blockers.length) return plan;
  assert(plan.workspaceHash === expectWorkspaceHash && plan.lockHash === expectLockHash, "工作副本清单或依赖锁不在中央批准摘要内；未安装，先审阅接入/升级并登记新摘要");
  root = plan.root;
  const lockPath = safePath(root, ".quality-workspace.lock");
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new Error("本工作区已有安装任务；CI不与本机初始化并发修改依赖"); }
  const result = { schemaVersion: 1, kind: plan.kind, runId: randomUUID(), status: "blocked", root, planHash: plan.planHash,
    workspaceHash: expectWorkspaceHash, lockHash: expectLockHash, stages: [], installationExecuted: false,
    hooksChanged: false, projectSourceChanged: false, qualityPassed: false, releaseApproved: false };
  try {
    const current = planCiPreparation({ root, runner });
    assert(current.planHash === plan.planHash && !current.blockers.length, "取得锁后准备计划变化，未执行安装");
    plan = current;
    const task = plan.installation;
    assert(digest(readFileSync(task.executable)) === task.executableSha256, "批准包管理器执行器发生变化");
    result.installationExecuted = true;
    const installed = runner(task.executable, task.args, { cwd: root, shell: false, encoding: "utf8", timeout: 1200000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: "true", HUSKY: "0" } });
    const execution = { ...task, exitCode: Number.isInteger(installed.status) ? installed.status : 2,
      stdout: redactLog(installed.stdout || ""), stderr: redactLog(installed.stderr || installed.error?.message || installed.signal || "") };
    result.stages.push(execution); assert(execution.exitCode === 0, `固定安装失败，退出${execution.exitCode}；停止质量检查，不沿用旧报告`);
    const origin = verifyLockOrigins(root, plan.projectKind, plan.workspace.registry);
    assert(origin.present && origin.sha256 === expectLockHash, "安装改变或丢失批准依赖锁，停止后续检查");
    for (const dependency of plan.workspace.dependencies) {
      const directory = realpathSync(path.join(root, plan.workspace.dependencyDirectory, "node_modules", dependency.name));
      assert(directory.startsWith(root + path.sep), "安装工具越出项目");
      const pkg = JSON.parse(readFileSync(safePath(directory, "package.json")));
      assert(pkg.name === dependency.name && pkg.version === dependency.version, "安装工具身份/版本与批准清单不一致");
      result.stages.push({ id: "fixed-tool-verified", name: dependency.name, version: dependency.version, sha256: artifactDigest(directory) });
    }
    assert(snapshotSource(root, { exclude: EXCLUDE }).digest === plan.workspace.source.digest, "依赖安装修改了项目源码或配置，停止后续检查");
    const lifecycle = planLifecycle({ root, kind: plan.projectKind });
    assert(!lifecycle.blockers.length && !lifecycle.patches.some((patch) => patch.status === "pending-installation"), "安装后依赖准备缺失或出现未知生命周期适配，禁止运行任意prepare/postinstall");
    result.stages.push(...applyLifecycle(root, lifecycle, plan.planHash));
    assert(snapshotSource(root, { exclude: EXCLUDE }).digest === plan.workspace.source.digest, "依赖准备修改了项目源码或配置");
    const actualHooks = spawnSync("git", ["config", "--path", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    assert((actualHooks.status === 0 ? actualHooks.stdout.trim() : null) === plan.workspace.hooks.before, "CI准备改变了本机Hook路径，拒绝继续");
    result.status = "dependencies-prepared";
    result.nextAction = "继续本轮真实质量检查及Review；本结果只证明依赖准备，不表示质量或发布通过";
  } catch (error) { result.failure = error.message; result.nextAction = "查看本轮失败记录，修复执行环境/接入配置；不运行后续构建、不使用旧绿报告"; }
  finally { closeSync(lock); rmSync(lockPath); }
  const relative = `quality-reports/ci-preparation/${result.runId}.json`;
  assert(!git(["ls-files", "--", relative], root), "CI回执不得覆盖跟踪源码");
  const file = safePath(root, relative); mkdirSync(path.dirname(file), { recursive: true });
  result.executionReceipt = file;
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return result;
}
