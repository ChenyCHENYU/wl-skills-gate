import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, realpathSync, chmodSync, symlinkSync, renameSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { planWorkspaceInitialization, applyWorkspaceInitialization } from "../../lib/workspace-init.js";
import { planOnboarding, applyOnboarding } from "../../lib/onboard.js";
import { gateRuntimeHash } from "../../lib/jenkins-integration.js";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"))).version;
const REGISTRY = "https://registry.example.invalid/";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const put = (root, relative, content) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n"); };
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (root) => { git(root, "add", "."); git(root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture: committed adoption"); };

function fixture(t, kind = "frontend") {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-workspace-init-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q"); git(root, "config", "user.name", "fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  const prefix = kind === "backend" ? "quality-tools/" : "";
  put(root, `${prefix}package.json`, { name: "adopted-fixture", private: true,
    ...(kind === "frontend" ? { dependencies: { vue: "3.5.0" }, packageManager: "pnpm@10.34.5" } : {}),
    devDependencies: { "@agile-team/wl-skills-gate": VERSION, ...(kind === "backend" ? { "@agile-team/wl-skills-bd": "0.41.1" }
      : { "@agile-team/wl-skills-kit": "2.33.1", "@agile-team/wl-skills-ui": "1.22.1", "vue-tsc": "3.0.0" }) } });
  put(root, kind === "backend" ? "quality-tools/package-lock.json" : "pnpm-lock.yaml", kind === "backend" ? { lockfileVersion: 3, packages: {} } : "lockfileVersion: '9.0'\n");
  put(root, ".gitignore", "node_modules/\nquality-reports/\n.husky/_/\n.quality-workspace.lock\n.quality-onboarding-backups/\n");
  put(root, "src/fixture.js", "export const fixture = true;\n");
  // This project-approved custom policy intentionally differs from the default onboarding assets.
  put(root, "quality/policy.yml", ["# project-approved custom scope; initialization must preserve every byte", "schemaVersion: 1", "project: workspace-fixture", "releaseRequires: [CUSTOM]", "checks:",
    "  - id: CUSTOM", "    dimension: 编码规范", "    tool: raw-json", "    command: node scripts/quality/producer.mjs", "    file: quality-reports/native/custom.json", "    versionCommand: node scripts/quality/producer.mjs --version", "    profiles: [standard, release]", ""].join("\n"));
  put(root, "quality/rules.lock.json", { lockVersion: 1, "wl-skills-gate": VERSION, tools: { CUSTOM: "fixture-tool-1" } });
  put(root, "scripts/quality/producer.mjs", "import {mkdirSync,writeFileSync} from 'node:fs'; if(process.argv.includes('--version')) console.log('fixture-tool-1'); else {mkdirSync('quality-reports/native',{recursive:true});writeFileSync('quality-reports/native/custom.json',JSON.stringify({toolVersion:'fixture-tool-1',findings:[]}));}\n");
  put(root, kind === "frontend" ? ".wl-skills/copilot-instructions-full.md" : ".wl-skills-bd/capabilities.json", kind === "frontend" ? "project-approved native assets\n" : {});
  if (kind === "backend") put(root, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><profiles><profile><id>wl-quality-audit</id></profile><profile><id>wl-quality-unit</id></profile></profiles></project>\n");
  const hooks = kind === "frontend" ? ["pre-commit", "pre-push", "commit-msg"] : ["pre-push", "commit-msg"];
  for (const name of hooks) {
    const gate = `${prefix}node_modules/@agile-team/wl-skills-gate/bin/wl-skills-gate.js`;
    put(root, `.githooks/${name}`, name === "pre-commit" ? "#!/bin/sh\nexit 0\n" : `#!/bin/sh\nroot="$(git rev-parse --show-toplevel)"\nnode "$root/${gate}" ${name === "pre-push" ? 'run --root "$root" --profile standard' : 'commit-message "$1" --root "$root"'}\n`);
    chmodSync(path.join(root, `.githooks/${name}`), 0o755);
  }
  put(root, "quality/workspace.json", { schemaVersion: 1, kind: "wl-quality-workspace", projectKind: kind, gateVersion: VERSION, registry: REGISTRY,
    dependencyDirectory: kind === "backend" ? "quality-tools" : ".", packageManager: kind === "backend" ? "npm" : "pnpm@10.34.5", hooksPath: ".githooks",
    hookFiles: hooks.map((name) => ({ path: `.githooks/${name}`, sha256: hash(readFileSync(path.join(root, `.githooks/${name}`))) })) });
  put(root, "scripts/quality/workspace-setup.mjs", readFileSync(path.join(PACKAGE, "templates/onboarding/automation/workspace-setup.mjs"), "utf8"));
  commit(root); return root;
}

function installFixedFixtureTools(root, kind) {
  // Only the package-manager operation is stubbed. Git dispatch and the Gate checker below are real.
  const prefix = kind === "backend" ? "quality-tools/" : "", modules = path.join(root, prefix, "node_modules/@agile-team");
  const gate = path.join(modules, "wl-skills-gate"); mkdirSync(gate, { recursive: true });
  for (const entry of ["package.json", "npm-shrinkwrap.json", "bin", "lib", "schemas", "templates", "assets", "scripts"]) cpSync(path.join(PACKAGE, entry), path.join(gate, entry), { recursive: true });
  for (const [name, version] of kind === "backend" ? [["bd", "0.41.1"]] : [["kit", "2.33.1"], ["ui", "1.22.1"]]) put(modules, `wl-skills-${name}/package.json`, { name: `@agile-team/wl-skills-${name}`, version });
}

function fixtureRunner(root, kind, calls = [], { failInstall = false, mode = null } = {}) {
  return (executable, args, options) => {
    calls.push({ executable, args });
    if (args[0] === "config") return { status: 0, stdout: JSON.stringify({ registry: REGISTRY, "@agile-team:registry": "https://old.example.invalid/", userAgent: "pnpm/10.34.5 npm/? node/v22", "//old.example.invalid/:_authToken": "must-not-be-exposed" }), stderr: "" };
    if (["ci", "install"].includes(args[0])) {
      if (!failInstall) installFixedFixtureTools(root, kind);
      return { status: failInstall ? 17 : 0, stdout: "isolated package-manager stub; not a real network install", stderr: failInstall ? "fixture registry unavailable" : "" };
    }
    if (args[0] === "hook" && args.includes("pre-push") && mode === "stale") return { status: 0, stdout: "fixture: no new report", stderr: "" };
    if (args[0] === "hook" && args.some((arg) => arg.endsWith("-invalid.txt")) && mode === "negative-executor-error") return { status: 2, stdout: "", stderr: "fixture executor unavailable" };
    const result = spawnSync(executable, args, options);
    if (args[0] === "hook" && args.includes("pre-push")) {
      if (mode === "mutates-source") put(root, "src/fixture.js", "// unexpected mutation\n");
      if (["forged-empty", "forged-project"].includes(mode)) {
        const file = path.join(root, "quality-reports/quality-summary.json"), report = JSON.parse(readFileSync(file));
        if (mode === "forged-project") report.run.project = "wrong-project";
        else { report.checks = []; report.policy.requiredCheckIds = []; report.policy.checksSelected = 0; }
        put(root, "quality-reports/quality-summary.json", report);
      }
    }
    return result;
  };
}

function apply(root, runner, plan = planWorkspaceInitialization({ root, runner })) {
  return applyWorkspaceInitialization({ root, runner, planHash: plan.planHash, confirm: true });
}

test("前后端真实新克隆恢复固定Hook；自定义策略/POM保持原字节，真实Gate首扫与提交说明正反通过", async (t) => {
  for (const kind of ["frontend", "backend"]) await t.test(kind, (sub) => {
    const source = fixture(sub, kind), parent = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-workspace-clone-")), root = path.join(parent, "clone");
    sub.after(() => rmSync(parent, { recursive: true, force: true }));
    git(source, "config", "core.hooksPath", ".githooks");
    execFileSync("git", ["clone", "--no-local", "-q", source, root]);
    assert.equal(spawnSync("git", ["-C", root, "config", "--local", "--get", "core.hooksPath"]).status, 1);
    const policy = readFileSync(path.join(root, "quality/policy.yml"), "utf8"), pom = kind === "backend" ? readFileSync(path.join(root, "pom.xml"), "utf8") : null;
    const calls = [], runner = fixtureRunner(root, kind, calls), first = planWorkspaceInitialization({ root, runner });
    assert.equal(first.runtimeFingerprint, gateRuntimeHash(), "工作区审批须绑定传递实现的完整Gate运行时");
    assert.deepEqual(first.blockers, []); assert.equal(first.status, "workspace-planned");
    assert.ok(first.installation.args.includes("--ignore-scripts"));
    assert.ok(first.installation.args.includes(kind === "backend" ? "ci" : "--frozen-lockfile"));
    assert.equal(existsSync(path.join(root, kind === "backend" ? "quality-tools/node_modules" : "node_modules")), false);
    assert.doesNotMatch(JSON.stringify(first), /must-not-be-exposed/);
    const installed = apply(root, runner, first); assert.equal(installed.status, "workspace-approval-required"); assert.equal(installed.localValidated, false);
    const second = planWorkspaceInitialization({ root, runner }); assert.equal(second.installation, null, JSON.stringify(second));
    const result = apply(root, runner, second);
    assert.equal(result.status, "local-validated-awaiting-remote-acceptance", JSON.stringify(result));
    assert.equal(result.localValidated, true); assert.equal(result.remoteValidated, false); assert.equal(result.businessClosureValidated, false);
    assert.match(result.reportSha256, /^[a-f0-9]{64}$/);
    assert.ok(result.stages.some((stage) => stage.id === "git-commit-message-positive" && stage.exitCode === 0));
    assert.ok(result.stages.some((stage) => stage.id === "git-commit-message-negative" && stage.exitCode === 1 && /\[commit-message\]/.test(stage.stderr)));
    assert.equal(git(root, "config", "--local", "--get", "core.hooksPath"), ".githooks");
    assert.equal(readFileSync(path.join(root, "quality/policy.yml"), "utf8"), policy);
    if (kind === "backend") assert.equal(readFileSync(path.join(root, "pom.xml"), "utf8"), pom);
    assert.equal(git(root, "status", "--porcelain"), ""); assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
    assert.equal(planWorkspaceInitialization({ root, runner }).installation, null);
    assert.equal(calls.filter((call) => ["ci", "install"].includes(call.args[0])).length, 1);
  });
});

test("取消无写入；未经确认、源码漂移或清单/锁临时更改不得应用旧计划", (t) => {
  const root = fixture(t), runner = fixtureRunner(root, "frontend"), plan = planWorkspaceInitialization({ root, runner });
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.throws(() => applyWorkspaceInitialization({ root, runner, planHash: plan.planHash }), /显式 confirm/);
  put(root, "src/fixture.js", "// changed after preview\n"); assert.throws(() => apply(root, runner, plan), /零写入/);
  assert.equal(existsSync(path.join(root, "node_modules")), false);
  put(root, "pnpm-lock.yaml", "lockfileVersion: 'changed'\n");
  assert.equal(planWorkspaceInitialization({ root, runner }).status, "workspace-blocked");
});

test("清单篡改、Hook丢失/漂移、冲突路径、无锁、项目外链接和聚合根均在安装前阻断", async (t) => {
  for (const mode of ["manifest-uncommitted", "hook-missing", "hook-drift", "conflict", "missing-lock", "link", "subdirectory", "uncommitted-package"]) await t.test(mode, (sub) => {
    const root = fixture(sub), calls = [], runner = fixtureRunner(root, "frontend", calls);
    if (mode === "manifest-uncommitted") put(root, "quality/workspace.json", {});
    if (mode === "hook-missing") rmSync(path.join(root, ".githooks/pre-push"));
    if (mode === "hook-drift") put(root, ".githooks/pre-push", "#!/bin/sh\nexit 0\n");
    if (mode === "conflict") git(root, "config", "core.hooksPath", ".other-hooks");
    if (mode === "missing-lock") rmSync(path.join(root, "pnpm-lock.yaml"));
    if (mode === "link") { rmSync(path.join(root, ".githooks/pre-push")); symlinkSync(path.join(PACKAGE, "package.json"), path.join(root, ".githooks/pre-push")); }
    if (mode === "uncommitted-package") { const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); pkg.devDependencies["@agile-team/wl-skills-gate"] = "99.0.0"; put(root, "package.json", pkg); }
    if (mode === "subdirectory") assert.throws(() => planWorkspaceInitialization({ root: path.join(root, "src"), runner }), /实际业务 Git 根/);
    else { const plan = planWorkspaceInitialization({ root, runner }); assert.equal(plan.status, "workspace-blocked"); const result = apply(root, runner, plan); assert.equal(result.localValidated, false); }
    assert.equal(calls.some((call) => ["ci", "install"].includes(call.args[0])), false);
  });
});

test("固定安装失败留逐阶段回执，恢复后只安装一次且不直接登记成功", (t) => {
  const root = fixture(t, "backend"), failed = fixtureRunner(root, "backend", [], { failInstall: true });
  const result = apply(root, failed); assert.equal(result.status, "workspace-initialization-blocked"); assert.match(result.failure, /退出17/);
  assert.equal(result.stages.find(stage=>stage.id==="dependencies-install").exitCode, 17); assert(existsSync(result.executionReceipt));
  const recovered = apply(root, fixtureRunner(root, "backend")); assert.equal(recovered.status, "workspace-approval-required"); assert.equal(recovered.localValidated, false);
});

test("真实Hook旧报告、伪造项目/空检查、检查时改源码、负例执行失效均不能算初始化通过", async (t) => {
  for (const mode of ["stale", "forged-project", "forged-empty", "mutates-source", "negative-executor-error"]) await t.test(mode, (sub) => {
    const root = fixture(sub), normal = fixtureRunner(root, "frontend"); apply(root, normal);
    if (mode === "stale") put(root, "quality-reports/quality-summary.json", { decision: { status: "passed" }, run: { eventId: "old-green" } });
    const result = apply(root, fixtureRunner(root, "frontend", [], { mode }));
    assert.equal(result.status, "workspace-initialization-blocked"); assert.equal(result.localValidated, false);
    assert.match(result.failure, mode === "stale" ? /未生成新报告/ : mode === "mutates-source" ? /修改了项目源码/ : mode === "forged-empty" ? /遗漏|篡改/ : mode === "forged-project" ? /项目/ : /执行器异常/);
    assert.equal(result.remoteValidated, false);
  });
});

test("folderOpen只读check缺本地Gate时无网络安装，非TTY首次init也不联网", (t) => {
  const root = fixture(t), script = path.join(root, "scripts/quality/workspace-setup.mjs");
  for (const action of ["check", "init"]) {
    const result = spawnSync(process.execPath, [script, action], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2); assert.match(result.stderr, action === "check" ? /不联网、不安装/ : /未授权，不联网、不安装/);
    assert.equal(existsSync(path.join(root, "node_modules")), false); assert.equal(git(root, "status", "--porcelain"), "");
  }
});

test("Husky新克隆使用已锁本地9.x包生成实际dispatcher，保留.husky源码并做真实Git正反验证", (t) => {
  const root = fixture(t); renameSync(path.join(root, ".githooks"), path.join(root, ".husky"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); pkg.devDependencies.husky = "9.1.7"; pkg.scripts = { prepare: "husky" }; put(root, "package.json", pkg);
  const manifest = JSON.parse(readFileSync(path.join(root, "quality/workspace.json"))); manifest.hooksPath = ".husky/_";
  manifest.hookFiles = manifest.hookFiles.map((file) => ({ ...file, path: file.path.replace(".githooks/", ".husky/") })); put(root, "quality/workspace.json", manifest); commit(root);
  const fixedHook = readFileSync(path.join(root, ".husky/pre-push"), "utf8"), normal = fixtureRunner(root, "frontend");
  const runner = (executable, args, options) => {
    const result = normal(executable, args, options);
    if (["ci", "install"].includes(args[0])) {
      // Isolated fixed Husky-shaped package; it exercises real activation and Git dispatch without a network install.
      put(root, "node_modules/husky/package.json", { name: "husky", version: "9.1.7", type: "module" });
      put(root, "node_modules/husky/husky", '#!/bin/sh\nn="$(basename "$0")"\ns="$(dirname "$(dirname "$0")")/$n"\nsh -e "$s" "$@"\n');
      put(root, "node_modules/husky/bin.js", `import {mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';import {spawnSync} from 'node:child_process';mkdirSync('.husky/_',{recursive:true});writeFileSync('.husky/_/h',readFileSync(new URL('./husky',import.meta.url)));writeFileSync('.husky/_/.gitignore','*');for(const name of ['pre-commit','pre-push','commit-msg']){const file='.husky/_/'+name;writeFileSync(file,'#!/usr/bin/env sh\\n. "$(dirname "$0")/h"');chmodSync(file,0o755)}spawnSync('git',['config','--local','core.hooksPath','.husky/_']);\n`);
    }
    return result;
  };
  const first = planWorkspaceInitialization({ root, runner }); assert.deepEqual(first.blockers, []); assert.equal(first.husky.status, "pending-installation");
  assert.equal(apply(root, runner, first).status, "workspace-approval-required");
  const second = planWorkspaceInitialization({ root, runner }); assert.equal(second.husky.status, "activation-planned");
  const result = apply(root, runner, second); assert.equal(result.status, "local-validated-awaiting-remote-acceptance", JSON.stringify(result));
  assert.equal(git(root, "config", "--local", "--get", "core.hooksPath"), ".husky/_");
  assert.equal(readFileSync(path.join(root, ".husky/pre-push"), "utf8"), fixedHook);
  assert.ok(result.stages.some((stage) => stage.id === "husky-explicit-activation" && stage.exitCode === 0));
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("包管理器版本错位、未批准锁源、未知生命周期和只读预检写源码均在安装前阻断", async (t) => {
  for (const mode of ["manager-version", "lock-origin", "unknown-lifecycle", "preflight-mutates-source"]) await t.test(mode, (sub) => {
    const root = fixture(sub), calls = [], normal = fixtureRunner(root, "frontend", calls);
    if (mode === "lock-origin") { put(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nresolution: {tarball: https://unapproved.example.invalid/a.tgz}\n"); commit(root); }
    if (mode === "unknown-lifecycle") { const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); pkg.scripts = { postinstall: "node arbitrary.js" }; put(root, "package.json", pkg); commit(root); }
    const runner = (executable, args, options) => {
      if (args[0] === "config" && mode === "manager-version") return { status: 0, stdout: JSON.stringify({ registry: REGISTRY, userAgent: "pnpm/11.0.0 node/v24" }), stderr: "" };
      const result = normal(executable, args, options);
      if (args[0] === "config" && mode === "preflight-mutates-source") put(root, "src/fixture.js", "// unexpected preflight write\n");
      return result;
    };
    const plan = planWorkspaceInitialization({ root, runner }); assert.equal(plan.status, "workspace-blocked", JSON.stringify(plan));
    assert.equal(calls.some((call) => ["ci", "install"].includes(call.args[0])), false);
  });
});

test("前端已核对依赖准备在安装后展示真实补丁并二次确认，缺失依赖可恢复而不改项目规则", (t) => {
  const root = fixture(t), pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  pkg.dependencies["@jhlc/common-core"] = "3.1.0-prod.14";
  pkg.scripts = { preinstall: "node scripts/enforce-pnpm.mjs", postinstall: "node scripts/patch-common-core-dts.mjs" };
  put(root, "package.json", pkg);
  for (const [from, to] of [["frontend-enforce-pnpm.mjs", "enforce-pnpm.mjs"], ["frontend-common-core-postinstall.mjs", "patch-common-core-dts.mjs"]]) put(root, `scripts/${to}`, readFileSync(path.join(PACKAGE, "templates/onboarding/legacy", from), "utf8"));
  commit(root);
  const normal = fixtureRunner(root, "frontend"), runner = (executable, args, options) => {
    const result = normal(executable, args, options);
    if (["ci", "install"].includes(args[0])) {
      put(root, "node_modules/@jhlc/common-core/package.json", { name: "@jhlc/common-core", version: "3.1.0-prod.14" });
      put(root, "node_modules/@jhlc/common-core/lib/fixture.d.ts", "type Fixture = EpPropFinalized<[StringConstructor], ,>;\n");
      put(root, "node_modules/@jhlc/common-core/src/components/form/common/type.ts", 'export type defaultValueType =\n  "currentDept" | "fixture";\n');
    }
    return result;
  };
  const first = planWorkspaceInitialization({ root, runner }); assert.equal(first.lifecycle.patches[0].status, "pending-installation");
  assert.equal(apply(root, runner, first).status, "workspace-approval-required");
  const second = planWorkspaceInitialization({ root, runner }); assert.equal(second.lifecycle.patches[0].status, "patch-planned"); assert.equal(second.installation, null);
  const policy = readFileSync(path.join(root, "quality/policy.yml"), "utf8"), result = apply(root, runner, second);
  assert.equal(result.status, "local-validated-awaiting-remote-acceptance", JSON.stringify(result));
  assert.ok(result.stages.some((stage) => stage.id === "project-lifecycle-common-core-types" && stage.changed === 2 && stage.idempotent === true));
  assert.equal(readFileSync(path.join(root, "quality/policy.yml"), "utf8"), policy);
  rmSync(path.join(root, "node_modules/@jhlc/common-core"), { recursive: true });
  assert.equal(planWorkspaceInitialization({ root, runner }).installation.id, "dependencies-install");
});

test("真实首次onboard产出的清单/Hook摘要/忽略与IDE入口可直接供新clone工作区预检消费", (t) => {
  const parent = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-onboard-to-workspace-")), source = path.join(parent, "source"), root = path.join(parent, "clone");
  t.after(() => rmSync(parent, { recursive: true, force: true })); mkdirSync(source);
  git(source, "init", "-q"); git(source, "config", "user.name", "fixture"); git(source, "config", "user.email", "fixture@example.invalid");
  put(source, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId></project>\n");
  put(source, "wl-produce-pl/wl-produce-pl-service/pom.xml", "<project><modelVersion>4.0.0</modelVersion><artifactId>wl-produce-pl-service</artifactId></project>\n");
  commit(source);
  const options = { root: source, registry: REGISTRY }, initial = planOnboarding(options);
  assert.deepEqual(initial.hardConflicts, []); assert(initial.files.some((file) => file.path === "quality/workspace.json"));
  const configured = applyOnboarding({ ...options, planHash: initial.planHash, confirm: true }); assert.equal(configured.status, "configuration-applied");
  const manifest = JSON.parse(readFileSync(path.join(source, "quality/workspace.json")));
  assert.equal(manifest.projectKind, "backend"); assert.equal(manifest.registry, REGISTRY); assert.equal(manifest.dependencyDirectory, "quality-tools");
  for (const file of manifest.hookFiles) assert.equal(hash(readFileSync(path.join(source, file.path))), file.sha256);
  assert.match(readFileSync(path.join(source, ".gitignore"), "utf8"), /\/\.quality-workspace\.lock/);
  const tasks = JSON.parse(readFileSync(path.join(source, ".vscode/tasks.json")));
  assert(tasks.tasks.some((task) => task.runOptions?.runOn === "folderOpen" && task.args?.includes("check")));
  assert(tasks.tasks.some((task) => task.args?.includes("init")));
  assert.equal(readFileSync(path.join(source, "scripts/quality/workspace-setup.mjs"), "utf8"), readFileSync(path.join(PACKAGE, "templates/onboarding/automation/workspace-setup.mjs"), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(source, "quality-tools/package.json")));
  put(source, "quality-tools/package-lock.json", { lockfileVersion: 3, packages: { "": { name: pkg.name, devDependencies: pkg.devDependencies } } });
  const policyPath = path.join(source, "quality/policy.yml"); put(source, "quality/policy.yml", readFileSync(policyPath, "utf8") + "\n# project-approved additional scope follows independently\n");
  commit(source);
  execFileSync("git", ["clone", "--no-local", "-q", source, root]);
  const before = git(root, "status", "--porcelain"), calls = [], runner = fixtureRunner(root, "backend", calls), plan = planWorkspaceInitialization({ root, runner });
  assert.equal(plan.status, "workspace-planned", JSON.stringify(plan)); assert.deepEqual(plan.blockers, []);
  assert.equal(plan.hooks.path, manifest.hooksPath); assert.equal(plan.hooks.before, null); assert.equal(plan.hooks.activationRequired, true);
  assert.equal(plan.installation.args[0], "ci"); assert(plan.installation.args.includes("--ignore-scripts"));
  assert.equal(calls.some((call) => ["ci", "install"].includes(call.args[0])), false); assert.equal(git(root, "status", "--porcelain"), before);
  const check = spawnSync(process.execPath, [path.join(root, "scripts/quality/workspace-setup.mjs"), "check"], { cwd: root, encoding: "utf8" });
  assert.equal(check.status, 2); assert.match(check.stderr, /不联网、不安装/); assert.equal(existsSync(path.join(root, "quality-tools/node_modules")), false);
});
