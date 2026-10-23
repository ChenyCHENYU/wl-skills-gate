import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync, realpathSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { planOnboarding, applyOnboarding } from "../../lib/onboard.js";
import { planCompleteOnboarding } from "../../lib/onboard-complete.js";
import { planLifecycle, applyLifecycle } from "../../lib/onboard-lifecycle.js";
import { nodeRangeSatisfied, onboardingEnvironment } from "../../lib/onboard-environment.js";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BD_FILES = path.resolve(PACKAGE, "fixtures/onboarding");
const REGISTRY = "https://registry.example.invalid/";
const PNPM_VERSION = execFileSync("pnpm", ["--version", "--config.manage-package-manager-versions=false"], { encoding: "utf8" }).trim();
const GATE_VERSION = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"))).version;
const put = (root, relative, content) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n"); };
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t, kind = "frontend") {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-onboard-complete-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q"); git(root, "config", "user.name", "fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  if (kind === "frontend") put(root, "package.json", { name: "fixture", packageManager: `pnpm@${PNPM_VERSION}`, dependencies: { vue: "3" }, devDependencies: { "@agile-team/wl-skills-kit": "2.33.1" } });
  else { put(root, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId><profiles><profile><id>business-existing</id></profile></profiles></project>\n"); put(root, "wl-produce-pl/wl-produce-pl-service/pom.xml", "<project><artifactId>fixture-module</artifactId></project>"); put(root, "wl-produce-pl/wl-produce-pl-service/src/main/java/Fixture.java", "class Fixture {}\n"); }
  git(root, "add", "."); git(root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture: seed"); return root;
}
function apply(options, plan) { options = { registry: REGISTRY, ...options }; plan ||= planOnboarding(options); return applyOnboarding({ ...options, planHash: plan.planHash, confirm: true }); }
function installIsolatedTools(root, kind) {
  const modules = path.join(root, kind === "backend" ? "quality-tools/node_modules" : "node_modules", "@agile-team");
  const gate = path.join(modules, "wl-skills-gate"); mkdirSync(gate, { recursive: true });
  for (const file of ["package.json", "npm-shrinkwrap.json", "lib", "bin", "schemas", "templates", "assets", "scripts"]) cpSync(path.join(PACKAGE, file), path.join(gate, file), { recursive: true });
  for (const [name, version] of kind === "backend" ? [["bd", "0.41.1"]] : [["kit", "2.33.1"], ["ui", "1.22.1"]]) {
    const directory = path.join(modules, `wl-skills-${name}`); put(directory, "package.json", { name: `@agile-team/wl-skills-${name}`, version });
    put(directory, `bin/${name === "kit" ? "wl-skills" : name === "ui" ? "wl-ui" : "wl-skills-bd"}.js`, `// isolated native version stub, not a business checker\nif (process.argv.includes("--version")) console.log("${version}");\n`);
  }
  put(root, kind === "backend" ? "quality-tools/package-lock.json" : "pnpm-lock.yaml", kind === "backend" ? "{}\n" : "lockfileVersion: '9.0'\n");
  if (kind === "frontend") {
    put(root, "node_modules/.bin/eslint", "#!/bin/sh\nexit 0\n"); put(root, "node_modules/.bin/vue-tsc", "#!/bin/sh\nexit 0\n");
    put(root, ".wl-skills/copilot-instructions-full.md", "fixture assets\n");
  } else put(root, ".wl-skills-bd/capabilities.json", "{}\n");
}
function fakeRunner(root, kind, calls, { failInstall = false, applyNative = false, drift = false } = {}) {
  return (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "config") return { status: 0, stdout: JSON.stringify({ registry: REGISTRY, "@agile-team:registry": "https://old.example.invalid/", "//old.example.invalid/:_authToken": "must-not-be-exposed" }), stderr: "" };
    if (args[0] === "install" && !failInstall) installIsolatedTools(root, kind);
    if (args[0] === "install") return { status: failInstall ? 17 : 0, stdout: "isolated installation result", stderr: failInstall ? "registry unavailable fixture" : "" };
    const script = args[0] || "";
    if (args.includes("--version") || args.includes("-version")) return { status: 0, stdout: script.includes("wl-skills-bd") ? "0.41.1\n" : script.includes("wl-skills.js") ? "2.33.1\n" : script.includes("wl-ui.js") ? "1.22.1\n" : "fixture-tool-1.0\n", stderr: "" };
    if (script.includes("wl-skills-bd.js") && args.includes("update")) {
      if (args.includes("--confirm") && applyNative) for (const name of ["audit", "unit"]) put(root, `.github/java-quality/maven-snippets/quality-${name}-profile.xml`, readFileSync(path.join(BD_FILES, `quality-${name}-profile.xml`), "utf8"));
      return { status: 0, stdout: JSON.stringify({ planHash: "a".repeat(64), note: drift ? "changed" : "isolated actual plan" }), stderr: "" };
    }
    if (args.includes("update")) return { status: 0, stdout: drift ? "changed preview" : "isolated readonly native preview\n", stderr: "" };
    throw new Error(`Test refused unexpected executor: ${executable} ${JSON.stringify(args)}`);
  };
}

test("complete 要求明确HTTPS源，计划安装argv关闭生命周期，预览不安装", (t) => {
  const root = fixture(t), options = { root, complete: true };
  assert.throws(() => planOnboarding(options), /--registry/);
  for (const source of ["http://example.invalid", "https://user:secret@example.invalid", "https://example.invalid?token=secret"]) assert.throws(() => planOnboarding({ ...options, registry: source }), /HTTPS/);
  const plan = planOnboarding({ ...options, registry: REGISTRY });
  assert.equal(plan.complete.status, "bootstrap-approval-required");
  assert.ok(plan.complete.installation.args.includes("--ignore-scripts"));
  assert.ok(plan.complete.installation.args.includes("--no-frozen-lockfile"), "首次已确认的依赖声明迁移须可更新pnpm锁，避免CI默认frozen导致安装无法恢复");
  assert.equal(plan.complete.installation.registry, REGISTRY);
  assert.equal(existsSync(path.join(root, "node_modules")), false);
  assert.equal(plan.complete.native.length, 0);
});

test("安装失败停止后续，留下真实阶段回执而非configured=ready", (t) => {
  const root = fixture(t), calls = [], options = { root, complete: true, registry: REGISTRY, runner: fakeRunner(root, "frontend", calls, { failInstall: true }) };
  const result = apply(options);
  assert.equal(result.status, "onboarding-execution-blocked");
  assert.equal(result.complete.localValidated, false); assert.equal(result.complete.remoteValidated, false);
  assert.match(result.complete.failure, /退出17/); assert.equal(calls.filter((call) => call.args[0] === "install").length, 1);
  const receipt = JSON.parse(readFileSync(result.executionReceipt)); assert.equal(receipt.stages[0].exitCode, 17);
  assert.equal(existsSync(path.join(root, "quality/rules.lock.json")), false);
  const resumed = JSON.parse(execFileSync(process.execPath, [path.join(PACKAGE, "bin/wl-quality.js"), "init", "--root", root, "--registry", REGISTRY, "--preview", "--json"], { encoding: "utf8" }));
  assert.equal(resumed.plan.kind, "project-onboarding", "真实CLI应在已写workspace清单但失败的首次安装后，继续project流程");
  assert.ok(resumed.plan.complete.installation, "同入口恢复必须保留未完成的真实依赖安装阶段");
});

test("安装成功只返回下一份实际资产审批，不隐式批准未知差异或首扫", (t) => {
  const root = fixture(t), calls = [], options = { root, complete: true, registry: REGISTRY, runner: fakeRunner(root, "frontend", calls) };
  const result = apply(options);
  assert.equal(result.status, "native-approval-required"); assert.equal(result.complete.localValidated, false);
  assert.equal(calls.filter((call) => call.args[0] === "install").length, 1); assert.equal(result.complete.stages[0].id, "dependencies-install");
});

test("已配置项目生成实际原生预览与锁候选，确认绑定全部source与argv", (t) => {
  const root = fixture(t); apply({ root }); installIsolatedTools(root, "frontend");
  const calls = [], options = { root, complete: true, registry: REGISTRY, runner: fakeRunner(root, "frontend", calls) };
  const plan = planOnboarding(options);
  assert.equal(plan.complete.blockers.length, 0, JSON.stringify(plan.complete.blockers));
  assert.equal(plan.complete.installation, null); assert.equal(plan.complete.native.length, 2);
  assert.equal(plan.complete.lock.status, "patch-planned"); assert.equal(JSON.parse(plan.complete.lock.afterContent)["wl-skills-gate"], GATE_VERSION);
  assert.ok(plan.complete.lock.queries.every((q) => Array.isArray(q.args) && q.executable || q.status === "fixed-native-distribution" && q.executed === false && q.expectedVersion));
  const drifted = { ...options, runner: fakeRunner(root, "frontend", [], { drift: true }) };
  assert.throws(() => apply(drifted, plan), /planHash 不一致/);
  assert.equal(existsSync(path.join(root, "quality/rules.lock.json")), false);
});

test("版本查询拒绝任意shell命令，不因policy可写就自动执行", (t) => {
  const root = fixture(t); apply({ root }); installIsolatedTools(root, "frontend");
  const file = path.join(root, "quality/policy.yml"); writeFileSync(file, readFileSync(file, "utf8").replace("node_modules/.bin/eslint --version", "touch /tmp/wl-onboard-must-not-execute"));
  const base = { ...planOnboarding({ root }), files: [], hardConflicts: [] }; const calls = [];
  const complete = planCompleteOnboarding(base, { registry: REGISTRY, runner: fakeRunner(root, "frontend", calls) });
  assert.equal(complete.status, "complete-preflight-blocked"); assert.match(complete.blockers[0].reason, /固定argv白名单/);
  assert.ok(calls.every((call) => !call.args.includes("touch")));
});

test("既有Husky在关闭生命周期后仍有单独批准的固定激活阶段，资产漂移拒旧确认", (t) => {
  const root = fixture(t); git(root, "config", "core.hooksPath", ".husky/_"); apply({ root }); installIsolatedTools(root, "frontend");
  put(root, "node_modules/husky/package.json", { name: "husky", version: "9.1.7" });
  put(root, "node_modules/husky/bin.js", "// isolated Husky activation fixture\n");
  put(root, "node_modules/husky/husky", "#!/bin/sh\n# isolated exact local Husky forwarder\n");
  const calls = [], native = fakeRunner(root, "frontend", calls);
  const runner = (exe, args, opts) => {
    if (args[0]?.endsWith("husky/bin.js")) {
      calls.push({ executable: exe, args }); put(root, ".husky/_/h", readFileSync(path.join(root, "node_modules/husky/husky"), "utf8"));
      for (const hook of ["pre-commit", "pre-push", "commit-msg"]) { put(root, `.husky/_/${hook}`, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'); chmodSync(path.join(root, `.husky/_/${hook}`), 0o755); }
      return { status: 0, stdout: "", stderr: "" };
    }
    return native(exe, args, opts);
  };
  const options = { root, complete: true, registry: REGISTRY, runner }, plan = planOnboarding(options);
  assert.equal(plan.complete.husky.id, "husky-explicit-activation"); assert.equal(plan.complete.husky.args[1], ".husky");
  const result = apply(options, plan); assert(result.complete.stages.some((stage) => stage.id === "husky-explicit-activation")); assert(existsSync(path.join(root, ".husky/_/h")));
  const next = planOnboarding(options); put(root, "node_modules/husky/bin.js", "// changed activation fixture\n"); assert.throws(() => apply(options, next), /planHash/);
});

test("BD后先输出POM审批；确认精确profile/真实PL includes后写入，doctor缺项仍阻断", (t) => {
  const root = fixture(t, "backend"); apply({ root }); installIsolatedTools(root, "backend"); rmSync(path.join(root, ".wl-skills-bd/capabilities.json"));
  const calls = [], options = { root, complete: true, registry: REGISTRY, runner: fakeRunner(root, "backend", calls, { applyNative: true }) };
  const first = planOnboarding(options); assert.equal(first.complete.blockers.length, 0, JSON.stringify(first.complete.blockers));
  assert.equal(first.complete.pom.status, "pending-native-assets");
  const initial = apply(options, first); assert.equal(initial.status, "pom-approval-required");
  assert.doesNotMatch(readFileSync(path.join(root, "pom.xml"), "utf8"), /wl-quality-unit/);
  const second = planOnboarding(options); assert.equal(second.complete.pom.status, "patch-planned");
  assert.match(second.complete.pom.afterContent, /business-existing/); assert.match(second.complete.pom.afterContent, /ProductFormCodeTest.java/);
  assert.match(second.complete.pom.afterContent, /wl-quality-audit/); assert.match(second.complete.pom.afterContent, /wl-quality-unit/);
  const result = apply(options, second);
  assert.equal(result.status, "local-readiness-blocked", JSON.stringify(result.complete)); assert.equal(result.complete.localValidated, false);
  assert.match(readFileSync(path.join(root, "pom.xml"), "utf8"), /StableBusinessIdTest.java/);
  assert.ok(result.complete.stages.some((stage) => stage.id === "doctor"));
  assert.ok(result.complete.stages.every((stage) => stage.id !== "git-pre-push-first-scan"));
});

test("doctor通过仍必须实际首扫；失败与旧绿报告均不能接入通过", async (t) => {
  for (const mode of ["failed", "stale"]) await t.test(mode, (sub) => {
    const root = fixture(sub, "backend"); apply({ root }); installIsolatedTools(root, "backend");
    // doctor only checks the approved input's presence. The fake first-scan
    // below must still fail; this is deliberately not a valid Java archive.
    const previousArchive=process.env.WL_JAVA_SCAN_ARCHIVE;
    put(root,"fixture-java-tools.zip","presence-only input for readonly doctor");
    process.env.WL_JAVA_SCAN_ARCHIVE=path.join(root,"fixture-java-tools.zip");
    sub.after(()=>{if(previousArchive===undefined)delete process.env.WL_JAVA_SCAN_ARCHIVE;else process.env.WL_JAVA_SCAN_ARCHIVE=previousArchive;});
    for (const name of ["audit", "unit"]) put(root, `.github/java-quality/maven-snippets/quality-${name}-profile.xml`, readFileSync(path.join(BD_FILES, `quality-${name}-profile.xml`), "utf8"));
    if (mode === "stale") put(root, "quality-reports/quality-summary.json", { run: { eventId: "old-green" }, decision: { status: "passed" } });
    const calls = [], native = fakeRunner(root, "backend", calls);
    const runner = (executable, args, opts) => args[0] === "hook" ? { status: mode === "failed" ? 1 : 0, stdout: "", stderr: mode === "failed" ? "quality blocker fixture" : "" } : native(executable, args, opts);
    const result = apply({ root, complete: true, registry: REGISTRY, runner });
    assert.equal(result.status, "onboarding-execution-blocked"); assert.equal(result.complete.localValidated, false);
    assert.match(result.complete.failure, /未生成新报告/);
    assert.ok(result.complete.stages.some((stage) => stage.id === "doctor" && stage.result.status === "ready-for-local-validation"));
    assert.ok(result.complete.stages.every((stage) => stage.id !== "git-commit-message-positive"));
    assert.ok(existsSync(result.executionReceipt));
    assert.equal(existsSync(path.join(root, ".quality-onboarding-execution.lock")), false);
  });
});

test("隔离真实Git和Gate完成首扫及提交说明正反验证，远端仍未验收", async (t) => {
  for (const mode of ["clean", "controlled-lifecycle", "quality-blocked", "quality-blocked-forged-project", "quality-blocked-forged-scope", "quality-blocked-exit2", "hook-mutates-source", "negative-executor-error", "forged-project", "forged-empty-checks"]) await t.test(mode, (sub) => {
    const root = fixture(sub); const assets = path.join(root, "isolated-approved-assets");
    cpSync(path.join(PACKAGE, "templates/onboarding"), assets, { recursive: true });
    put(assets, "frontend/policy.yml", ["schemaVersion: 1", "project: fixture", "releaseRequires: [ISOLATED-REPORT]", "checks:", "  - id: ISOLATED-REPORT", "    dimension: 编码规范", "    tool: raw-json", "    command: node scripts/quality/isolated-producer.mjs", "    file: quality-reports/native/isolated.json", "    versionCommand: node node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js --version", "    profiles: [standard, release]", ""].join("\n"));
    const pkgFile = path.join(root, "package.json"), pkg = JSON.parse(readFileSync(pkgFile)); pkg.packageManager = "pnpm@10.34.5"; pkg.devDependencies["vue-tsc"] = "3.0.0"; put(root, "package.json", pkg);
    put(root, "src/fixture.js", "export const fixture = true;\n");
    const findings = mode.startsWith("quality-blocked") ? [{ ruleId: "QUALITY/REAL-BLOCKER", severity: "error", file: "src/fixture.js", line: 1, message: "真实检查产出的阻断问题" }] : [];
    put(root, "scripts/quality/isolated-producer.mjs", "import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('quality-reports/native',{recursive:true});writeFileSync('quality-reports/native/isolated.json',JSON.stringify({toolVersion:'2.33.1',findings:" + JSON.stringify(findings) + "}));\n");
    if (mode === "controlled-lifecycle") commonLifecycleFixture(root);
    apply({ root, assetRoot: assets }); installIsolatedTools(root, "frontend");
    if (mode === "hook-mutates-source") {
      const hook = path.join(root, ".githooks/pre-push"); writeFileSync(hook, readFileSync(hook, "utf8") + "printf '\\n// unexpected hook write\\n' >> src/fixture.js\n");
    }
    if (mode === "hook-mutates-source") { const manifestFile = path.join(root, "quality/workspace.json"), manifest = JSON.parse(readFileSync(manifestFile)); const { createHash } = globalThis.process.getBuiltinModule("node:crypto"); for (const entry of manifest.hookFiles) entry.sha256 = createHash("sha256").update(readFileSync(path.join(root, entry.path))).digest("hex"); put(root, "quality/workspace.json", manifest); }
    const calls = [], native = fakeRunner(root, "frontend", calls);
    const runner = (executable, args, opts) => {
      if (args[0] !== "hook") return native(executable, args, opts);
      if (mode === "negative-executor-error" && args.includes("quality-reports/onboarding/invalid-commit.txt")) return { status: 2, stdout: "", stderr: "fixture executor unavailable" };
      const result = globalThis.process.getBuiltinModule("node:child_process").spawnSync(executable, args, opts);
      if (args.includes("pre-push") && mode.startsWith("forged-")) {
        const file = path.join(root, "quality-reports/quality-summary.json"), report = JSON.parse(readFileSync(file));
        if (mode === "forged-project") report.run.project = "wrong-project";
        else { report.checks = []; report.policy.requiredCheckIds = []; report.policy.checksSelected = 0; }
        put(root, "quality-reports/quality-summary.json", report);
      }
      if (args.includes("pre-push") && mode.startsWith("quality-blocked-")) {
        const file = path.join(root, "quality-reports/quality-summary.json"), report = JSON.parse(readFileSync(file));
        if (mode === "quality-blocked-forged-project") report.run.project = "wrong-project";
        if (mode === "quality-blocked-forged-scope") report.run.scope = "staged";
        if (mode === "quality-blocked-exit2") result.status = 2;
        put(root, "quality-reports/quality-summary.json", report);
      }
      return result;
    };
    const result = apply({ root, assetRoot: assets, complete: true, registry: REGISTRY, runner });
    if (["clean", "controlled-lifecycle"].includes(mode)) {
      assert.equal(result.status, "local-validated-awaiting-remote-acceptance", JSON.stringify(result.complete));
      assert.equal(result.complete.localValidated, true); assert.match(result.complete.reportSha256, /^[a-f0-9]{64}$/);
      assert.ok(result.complete.stages.some((stage) => stage.id === "git-commit-message-negative" && stage.exitCode === 1));
      if (mode === "controlled-lifecycle") assert.ok(result.complete.stages.some((stage) => stage.id === "project-lifecycle-common-core-types" && stage.changed === 2 && stage.idempotent === true));
    } else if (mode === "quality-blocked") {
      assert.equal(result.status, "installed-quality-blocked", JSON.stringify(result.complete));
      assert.equal(result.complete.installationValidated, true); assert.equal(result.complete.localValidated, false); assert.equal(result.complete.qualityPassed, false);
      assert.equal(JSON.parse(readFileSync(path.join(root, "quality-reports/quality-summary.json"))).decision.status, "blocked");
      assert.ok(result.complete.stages.some((stage) => stage.id === "git-commit-message-negative" && stage.exitCode === 1));
    } else {
      assert.equal(result.status, "onboarding-execution-blocked", JSON.stringify(result.complete));
      assert.equal(result.complete.localValidated, false);
      assert.match(result.complete.failure, mode === "hook-mutates-source" ? /修改了项目源码/ : ["forged-project", "quality-blocked-forged-project", "quality-blocked-forged-scope"].includes(mode) ? /项目.*源码|项目不一致/ : mode === "forged-empty-checks" ? /遗漏.*必需检查/ : mode === "quality-blocked-exit2" ? /退出2/ : /执行异常/);
    }
    assert.equal(result.complete.remoteValidated, false); assert.equal(result.complete.businessClosureValidated, false);
    assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
  });
});

function commonLifecycleFixture(root, { declaration = true } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  pkg.dependencies["@jhlc/common-core"] = "3.1.0-prod.14";
  pkg.scripts = { ...pkg.scripts, preinstall: "node scripts/enforce-pnpm.mjs", postinstall: "node scripts/patch-common-core-dts.mjs", prepare: "husky" };
  for (const [source, target] of [["frontend-enforce-pnpm.mjs", "scripts/enforce-pnpm.mjs"], ["frontend-common-core-postinstall.mjs", "scripts/patch-common-core-dts.mjs"]]) put(root, target, readFileSync(path.join(PACKAGE, "templates/onboarding/legacy", source), "utf8"));
  put(root, "package.json", pkg);
  if (declaration) {
    put(root, "node_modules/@jhlc/common-core/package.json", { name: "@jhlc/common-core", version: "3.1.0-prod.14" });
    put(root, "node_modules/@jhlc/common-core/lib/Fixture.d.ts", "type A = EpPropFinalized<[StringConstructor], , boolean>;\ntype B = EpPropFinalized<[, StringConstructor], string, boolean>;\n");
    put(root, "node_modules/@jhlc/common-core/src/components/form/common/type.ts", 'export type defaultValueType =\n  "currentDept" |\n  "currentUser";\n');
    put(root, "node_modules/@jhlc/common-core/keep.js", "export const untouched = true;\n");
  }
}

test("Node最低版本及项目engines在配置和安装前零写入拦截", (t) => {
  const root = fixture(t), original = Object.getOwnPropertyDescriptor(process.versions, "node");
  const before = git(root, "status", "--porcelain");
  try {
    Object.defineProperty(process.versions, "node", { ...original, value: "22.11.0" });
    const calls = [], options = { root, complete: true, registry: REGISTRY, runner: () => { calls.push(1); throw new Error("环境失败不能执行任何命令"); } };
    const plan = planOnboarding(options);
    assert(plan.complete.blockers.some((blocker) => blocker.id === "NODE-ENVIRONMENT"));
    const result = apply(options, plan);
    assert.equal(result.status, "onboarding-execution-blocked"); assert.deepEqual(calls, []);
    assert.equal(git(root, "status", "--porcelain"), before); assert.equal(existsSync(path.join(root, ".githooks")), false);
    assert.throws(() => apply({ root }), /零写入/);
  } finally { Object.defineProperty(process.versions, "node", original); }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); pkg.engines = { node: ">=99.0.0" }; put(root, "package.json", pkg);
  const plan = planOnboarding({ root }); assert.equal(plan.status, "configuration-blocked"); assert(plan.environment.blockers.some((blocker) => blocker.id === "PROJECT-NODE-ENGINES"));
  assert.throws(() => apply({ root }, plan), /零写入/); assert.equal(existsSync(path.join(root, ".githooks")), false);
});

test("Node范围与真实执行器摘要可复核，复杂未知范围保守拒绝", () => {
  for (const [range, version, expected] of [[">=22.12.0", "22.11.0", false], [">=22.12.0", "22.12.0", true], ["^20.19.0 || >=22.12.0", "24.0.0", true], ["^22.12.0", "23.0.0", false], ["22.x", "22.15.0", true], ["~22.12.0", "22.13.0", false], [">=22.12.0 <25", "24.0.0", true], ["22 - 24", "24.0.0", false]]) assert.equal(nodeRangeSatisfied(range, version), expected, `${range} ${version}`);
});

test("已核对项目postinstall只生成固定依赖精确patch，应用后再扫幂等且不执行项目脚本", (t) => {
  const root = fixture(t); commonLifecycleFixture(root);
  const plan = planLifecycle({ root, kind: "frontend" }); assert.deepEqual(plan.blockers, []); assert.equal(plan.arbitraryLifecycleExecution, false);
  assert(plan.scripts.every((script) => script.executesProjectScript === false));
  assert.equal(plan.patches[0].status, "patch-planned"); assert.deepEqual(plan.patches[0].allowedPaths, ["lib/*.d.ts", "src/components/form/common/type.ts"]);
  const report = applyLifecycle(root, plan, "a".repeat(64)); assert.equal(report[0].changed, 2); assert.equal(report[0].idempotent, true);
  assert.match(readFileSync(path.join(root, "node_modules/@jhlc/common-core/lib/Fixture.d.ts"), "utf8"), /\[StringConstructor\], unknown,/);
  assert.equal(readFileSync(path.join(root, "node_modules/@jhlc/common-core/keep.js"), "utf8"), "export const untouched = true;\n");
  const next = planLifecycle({ root, kind: "frontend" }); assert.equal(next.patches[0].status, "unchanged"); assert.equal(applyLifecycle(root, next, "b".repeat(64))[0].changed, 0);
  assert.equal(existsSync(path.join(root, ".githooks")), false);
});

test("安装前可识别受控准备，依赖安装后重新预览实际差异，未知生命周期零写入拒绝", (t) => {
  const root = fixture(t); commonLifecycleFixture(root, { declaration: false });
  const lifecycle = planLifecycle({ root, kind: "frontend" }); assert.deepEqual(lifecycle.blockers, []); assert.equal(lifecycle.patches[0].status, "pending-installation");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); pkg.scripts.postprepare = "touch must-not-execute"; put(root, "package.json", pkg);
  const calls = [], options = { root, complete: true, registry: REGISTRY, runner: () => { calls.push(1); throw new Error("未批准脚本不能触发安装"); } };
  const plan = planOnboarding(options); assert(plan.complete.blockers.some((blocker) => blocker.lifecycle === "postprepare"));
  const before = git(root, "status", "--porcelain"), result = apply(options, plan);
  assert.equal(result.status, "onboarding-execution-blocked"); assert.deepEqual(calls, []); assert.equal(git(root, "status", "--porcelain"), before);
  assert.equal(existsSync(path.join(root, "must-not-execute")), false); assert.equal(existsSync(path.join(root, ".githooks")), false);
});

test("脚本或安装内容漂移、越界pnpm链接、目标符号链接均拒绝适配", async (t) => {
  for (const mode of ["script-drift", "package-drift", "wrong-version", "target-link", "external-package-link"]) await t.test(mode, (sub) => {
    const root = fixture(sub); commonLifecycleFixture(root); const plan = planLifecycle({ root, kind: "frontend" });
    const packageRoot = path.join(root, "node_modules/@jhlc/common-core");
    if (mode === "script-drift") put(root, "scripts/patch-common-core-dts.mjs", "throw new Error('must not execute');\n");
    if (mode === "package-drift") put(packageRoot, "keep.js", "changed package\n");
    if (mode === "wrong-version") put(packageRoot, "package.json", { name: "@jhlc/common-core", version: "3.1.1" });
    if (mode === "target-link") { rmSync(path.join(packageRoot, "lib/Fixture.d.ts")); symlinkSync(path.join(root, "package.json"), path.join(packageRoot, "lib/Fixture.d.ts")); }
    if (mode === "external-package-link") { rmSync(packageRoot, { recursive: true }); symlinkSync(PACKAGE, packageRoot); }
    assert.throws(() => applyLifecycle(root, plan, "c".repeat(64)), /变化|版本|链接|符号|仅核对/);
  });
});

test("项目内pnpm common-core链接可安全应用，写入采用独立文件不改共享硬链接", (t) => {
  const root = fixture(t); commonLifecycleFixture(root);
  const from = path.join(root, "node_modules/@jhlc/common-core"), target = path.join(root, "node_modules/.pnpm/common-core/node_modules/@jhlc/common-core");
  mkdirSync(path.dirname(target), { recursive: true }); cpSync(from, target, { recursive: true }); rmSync(from, { recursive: true }); symlinkSync(target, from);
  const plan = planLifecycle({ root, kind: "frontend" }); assert.deepEqual(plan.blockers, []); assert.equal(applyLifecycle(root, plan, "d".repeat(64))[0].changed, 2);
});

test("已失败安装即使留下部分依赖和锁也必须重新批准安装，不跳过失败阶段", (t) => {
  const root = fixture(t); apply({ root }); installIsolatedTools(root, "frontend");
  put(root, "quality-reports/onboarding/execution.json", { stages: [{ id: "dependencies-install", exitCode: 17 }], status: "onboarding-execution-blocked" });
  const calls = [], options = { root, complete: true, registry: REGISTRY, runner: fakeRunner(root, "frontend", calls) };
  const plan = planOnboarding(options); assert.equal(plan.complete.installation.id, "dependencies-install");
  const result = apply(options, plan); assert.equal(result.status, "native-approval-required");
  const next = planOnboarding(options); assert.equal(next.complete.installation, null);
});

test("Husky空壳h文件不算实际激活成功，失败后停止首扫", (t) => {
  const root = fixture(t); git(root, "config", "core.hooksPath", ".husky/_"); apply({ root }); installIsolatedTools(root, "frontend");
  put(root, "node_modules/husky/package.json", { name: "husky", version: "9.1.7" }); put(root, "node_modules/husky/bin.js", "// isolated activation\n"); put(root, "node_modules/husky/husky", "#!/bin/sh\n# fixed actual wrapper\n");
  const native = fakeRunner(root, "frontend", []), runner = (exe, args, opts) => { if (args[0]?.endsWith("husky/bin.js")) { put(root, ".husky/_/h", "#!/bin/sh\n"); return { status: 0, stdout: "", stderr: "" }; } return native(exe, args, opts); };
  const result = apply({ root, complete: true, registry: REGISTRY, runner }); assert.equal(result.status, "onboarding-execution-blocked"); assert.match(result.complete.failure, /固定本地包/);
  assert(!result.complete.stages.some((stage) => stage.id === "git-pre-push-first-scan"));
});

test("项目准备缺依赖时不能卡在永久等待；同一入口恢复已批准安装阶段", (t) => {
  const root = fixture(t); commonLifecycleFixture(root, { declaration: false }); apply({ root }); installIsolatedTools(root, "frontend");
  const options = { root, complete: true, registry: REGISTRY, runner: fakeRunner(root, "frontend", []) };
  const plan = planOnboarding(options); assert.equal(plan.complete.lifecycle.patches[0].status, "pending-installation"); assert.equal(plan.complete.installation.id, "dependencies-install");
});

test("common-core第二个文件写入失败回滚第一个精确补丁，不留半准备状态", (t) => {
  const root = fixture(t); commonLifecycleFixture(root); const pkg = path.join(root, "node_modules/@jhlc/common-core");
  const original = readFileSync(path.join(pkg, "lib/Fixture.d.ts"), "utf8"), planHash = "e".repeat(64);
  put(pkg, `src/components/form/common/type.ts.onboard-${planHash.slice(0, 12)}.tmp`, "existing collision must survive\n");
  const plan = planLifecycle({ root, kind: "frontend" }); assert.deepEqual(plan.blockers, []);
  assert.throws(() => applyLifecycle(root, plan, planHash), /EEXIST/);
  assert.equal(readFileSync(path.join(pkg, "lib/Fixture.d.ts"), "utf8"), original);
  assert.equal(readFileSync(path.join(pkg, `src/components/form/common/type.ts.onboard-${planHash.slice(0, 12)}.tmp`), "utf8"), "existing collision must survive\n");
});

test("版本命令不能仅凭@agile-team目录前缀运行未批准的脚本", (t) => {
  const root = fixture(t); apply({ root }); installIsolatedTools(root, "frontend");
  const file = path.join(root, "quality/policy.yml"); writeFileSync(file, readFileSync(file, "utf8").replace("node node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js --version", "node node_modules/@agile-team/unapproved/bin/malicious.js --version"));
  const base = { ...planOnboarding({ root }), files: [], hardConflicts: [] }, calls = [];
  const result = planCompleteOnboarding(base, { registry: REGISTRY, runner: fakeRunner(root, "frontend", calls) });
  assert.equal(result.status, "complete-preflight-blocked"); assert(result.blockers.some((blocker) => /固定argv白名单/.test(blocker.reason)));
  assert(!calls.some((call) => call.args.some((arg) => /malicious/.test(arg))));
});
