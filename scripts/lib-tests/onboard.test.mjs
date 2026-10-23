import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync, realpathSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { planOnboarding, applyOnboarding, parseOnboardArgs, detectProject } from "../../lib/onboard.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(PACKAGE_ROOT, "bin/wl-skills-gate.js");
const put = (root, file, value) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"); };
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t, kind = "frontend", { adopted = true, hooks = null } = {}) {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-onboard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q"); git(root, "config", "user.name", "fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  if (hooks) git(root, "config", "core.hooksPath", hooks);
  if (kind === "frontend") put(root, "package.json", { name: "fixture-console", dependencies: { vue: "3.5.0" }, devDependencies: adopted ? { "@agile-team/wl-skills-kit": "2.33.1" } : {}, scripts: { build: "business-build" } });
  else {
    put(root, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId></project>");
    put(root, "wl-produce-pl/wl-produce-pl-service/pom.xml", "<project><artifactId>wl-produce-pl-service</artifactId></project>");
  }
  git(root, "add", "."); git(root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture: seed");
  return root;
}
const apply = (options, plan = planOnboarding(options)) => applyOnboarding({ ...options, planHash: plan.planHash, confirm: true });

test("onboard 自动识别已接 PC；计划完全只读，质量工具关系与剩余验收透明", (t) => {
  const root = fixture(t); const before = git(root, "status", "--porcelain");
  const plan = planOnboarding({ root });
  assert.equal(plan.projectKind, "frontend"); assert.equal(plan.preset, "pc-vue");
  assert.equal(plan.status, "configuration-planned"); assert.equal(plan.capabilities.remoteCiRegistration, false);
  assert.deepEqual(plan.hooks.activation, { action: "set-local-hooks-path", before: null, after: ".githooks" });
  assert.equal(plan.hooks.executionValidated, false);
  assert.match(plan.files.find((f) => f.path === "quality/policy.yml").afterContent, /project: "fixture-console"/);
  assert.equal(git(root, "status", "--porcelain"), before);
  assert.equal(spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"]).status, 1);
});

test("应用受控计划一次激活 Hook，保存既有内容且重复执行幂等", (t) => {
  const root = fixture(t); put(root, ".githooks/pre-push", "#!/bin/sh\nexec echo original\n");
  const options = { root }; const first = apply(options);
  assert.equal(first.status, "configuration-applied"); assert.equal(first.hooks.pathConfigured, true);
  assert.equal(git(root, "config", "--local", "--get", "core.hooksPath"), ".githooks");
  const body = readFileSync(path.join(root, ".githooks/pre-push"), "utf8");
  assert.ok(body.indexOf("project-actions.mjs") < body.indexOf("exec echo original"));
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"))).scripts.build, "business-build");
  const second = apply(options); assert.deepEqual(second.files, []);
  assert.equal(readFileSync(path.join(root, ".githooks/pre-push"), "utf8"), body);
  assert.equal(existsSync(path.join(root, "node_modules")), false);
});

test("真实 Git Hook 在 Gate 缺失时拒绝提交，不会假成功", (t) => {
  const root = fixture(t); apply({ root });
  put(root, "src/new.js", "export const x = 1;\n"); git(root, "add", "src/new.js");
  const result = spawnSync("git", ["-C", root, "commit", "-m", "feat: verify hook"], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /缺少固定版本 Gate|依赖不可用|入口或依赖不可用|固定Gate入口不可用/);
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1");
});

test("Java 依赖放在 quality-tools；Maven/POM 原文保留", (t) => {
  const root = fixture(t, "backend"); const pom = readFileSync(path.join(root, "pom.xml"), "utf8");
  const plan = planOnboarding({ root }); assert.equal(plan.projectKind, "backend");
  assert.equal(plan.dependencyChanges.length, 2, "新建后端工具清单须展示Gate/BD两项新增声明");
  assert.match(plan.dependencyLayout.role, /不是另一个 npm 包/);
  const result = apply({ root }, plan);
  const pkg = JSON.parse(readFileSync(path.join(root, "quality-tools/package.json")));
  assert.equal(pkg.devDependencies["@agile-team/wl-skills-gate"], JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"))).version);
  assert.equal(pkg.devDependencies["@agile-team/wl-skills-bd"], "0.41.1");
  assert.equal(existsSync(path.join(root, "package.json")), false);
  assert.equal(readFileSync(path.join(root, "pom.xml"), "utf8"), pom);
  assert.ok(result.gaps.some((g) => g.id === "POM-PROFILE-REQUIRED"));
  assert.equal(existsSync(path.join(root, ".githooks/pre-commit")), false);
});

test("保护未知项目：新 Vue 需明确 PC 范围，移动/混合/未知 Maven 不误套具体示例", (t) => {
  const root = fixture(t, "frontend", { adopted: false });
  assert.throws(() => planOnboarding({ root }), /不能证明属于 PC/);
  assert.equal(planOnboarding({ root, kind: "frontend" }).projectKind, "frontend");
  put(root, "pages.json", "{}"); assert.throws(() => planOnboarding({ root, kind: "frontend" }), /移动/);
  rmSync(path.join(root, "pages.json")); put(root, "pom.xml", "<project/>");
  assert.throws(() => detectProject({ root }), /同时发现/);
  assert.throws(() => planOnboarding({ root, kind: "backend" }), /不能套用到其他项目/);
  assert.equal(existsSync(path.join(root, "quality-tools")), false);
});

test("没有授权、过期计划、冲突与符号链接目标均拒绝写入和激活", (t) => {
  const root = fixture(t); const plan = planOnboarding({ root });
  assert.throws(() => applyOnboarding({ root, planHash: plan.planHash }), /显式/);
  put(root, "package.json", { name: "changed", dependencies: { vue: "3" }, devDependencies: { "@agile-team/wl-skills-kit": "2.33.1" } });
  assert.throws(() => apply({ root }, plan), /零写入/);
  assert.equal(existsSync(path.join(root, ".githooks")), false);
  put(root, "quality/policy.json", "{}"); const conflict = planOnboarding({ root });
  assert.equal(conflict.status, "configuration-blocked"); assert.throws(() => apply({ root }, conflict), /零写入/);
  rmSync(path.join(root, "quality"), { recursive: true }); symlinkSync(PACKAGE_ROOT, path.join(root, "quality"));
  const symlink = planOnboarding({ root }); assert.equal(symlink.status, "configuration-blocked");
  assert.throws(() => apply({ root }, symlink), /零写入/);
  assert.equal(spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"]).status, 1);
});

test("已有 Husky 路径被复用，禁止接入时静默换掉旧路径", (t) => {
  const root = fixture(t, "frontend", { hooks: ".husky/_" });
  put(root, ".husky/_/h", "#!/bin/sh\n");
  const result = apply({ root });
  assert.equal(git(root, "config", "--get", "core.hooksPath"), ".husky/_");
  assert.equal(result.hooks.destination, ".husky");
  assert.equal(existsSync(path.join(root, ".husky/pre-push")), true);
});

test("CLI 参数严格，支持显式不激活；预览 JSON 可交给接入界面展示", (t) => {
  assert.throws(() => parseOnboardArgs(["--apply", "--apply"]), /重复/);
  assert.throws(() => parseOnboardArgs(["--confirm"]), /仅用于/);
  assert.throws(() => parseOnboardArgs(["--install"]), /未知/);
  const root = fixture(t); const args = [CLI, "onboard", "--root", root, "--no-activate-hooks"];
  const preview = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  const applied = spawnSync(process.execPath, [...args, "--apply", "--plan-hash", plan.planHash, "--confirm"], { encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"]).status, 1);
});

test("打包后仅靠 Gate 自带资产完成接入，不依赖作者规范目录", (t) => {
  const root = fixture(t); const detached = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-onboard-package-"));
  t.after(() => rmSync(detached, { recursive: true, force: true }));
  for (const rel of ["bin", "lib", "templates", "schemas", "assets", "scripts", "package.json", "npm-shrinkwrap.json"]) cpSync(path.join(PACKAGE_ROOT, rel), path.join(detached, rel), { recursive: true });
  const args = [path.join(detached, "bin/wl-skills-gate.js"), "onboard", "--root", root];
  const preview = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  assert.ok(plan.sources.every((s) => !s.path.includes("quality-onboarding-examples")));
  const applied = spawnSync(process.execPath, [...args, "--apply", "--plan-hash", plan.planHash, "--confirm"], { encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
});

test("依赖升级必须明确批准，不挪动已有依赖类别", (t) => {
  const root = fixture(t); put(root, "package.json", { name: "fixture", dependencies: { vue: "3", "@agile-team/wl-skills-kit": "2.29.0" } });
  assert.equal(planOnboarding({ root }).status, "configuration-blocked");
  const options = { root, allowDependencyUpdates: true }; const plan = planOnboarding(options);
  assert.equal(plan.status, "configuration-planned"); apply(options, plan);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  assert.equal(pkg.dependencies["@agile-team/wl-skills-kit"], "2.33.1"); assert.equal(pkg.devDependencies["@agile-team/wl-skills-kit"], undefined);
});

test("已核对前端旧块自动进批准patch，保留只读Prettier/ESLint与Kit兼容marker", (t) => {
  const root = fixture(t, "frontend", { hooks: ".husky/_" }); put(root, ".husky/_/h", "#!/bin/sh\n");
  for (const action of ["pre-commit", "pre-push"]) put(root, `.husky/${action}`, readFileSync(path.join(PACKAGE_ROOT, `templates/onboarding/legacy/frontend-${action}.sh`), "utf8"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"))); pkg["lint-staged"] = { "src/**/*.ts": ["eslint --fix", "prettier --write"], "*.md": "prettier --write", "*.custom": "echo preserve-custom-check" }; put(root, "package.json", pkg);
  const plan = planOnboarding({ root }); assert.ok(plan.legacyMigrations.length >= 3);
  assert.equal(plan.gaps.some((gap) => ["LEGACY-SILENT-REPAIR", "LEGACY-DUPLICATE-CHECK"].includes(gap.id)), false);
  apply({ root }, plan);
  const after = JSON.parse(readFileSync(path.join(root, "package.json")));
  assert.deepEqual(after["lint-staged"]["src/**/*.ts"], ["eslint", "prettier --check"]);
  assert.equal(after["lint-staged"]["*.custom"], "echo preserve-custom-check");
  for (const [action, marker] of [["pre-commit", "wl-skills-hook-v2"], ["pre-push", "wl-skills-prepush-hook-v1"]]) {
    const text = readFileSync(path.join(root, `.husky/${action}`), "utf8"); assert.match(text, /project-actions.mjs/); assert.ok(text.includes(marker)); assert.doesNotMatch(text, /validate --(?:typecheck|pre-commit)/);
  }
  assert.ok(planOnboarding({ root }).files.every((file) => file.action === "unchanged"));
});

test("后端BD受管Hook原文保留，独立Gate dispatcher使用固定本地BD保留scope校验", (t) => {
  const root = fixture(t, "backend", { hooks: ".githooks" });
  const original = readFileSync(path.join(PACKAGE_ROOT, "templates/onboarding/legacy/backend-commit-msg.sh"), "utf8"); put(root, ".githooks/commit-msg", original);
  const plan = planOnboarding({ root }); assert.equal(plan.hooks.destination, "scripts/quality/git-hooks"); assert.equal(plan.hooks.activation.before, ".githooks");
  assert.equal(plan.gaps.some((gap) => gap.id === "LEGACY-DUPLICATE-CHECK"), false);
  apply({ root }, plan);
  assert.equal(readFileSync(path.join(root, ".githooks/commit-msg"), "utf8"), original);
  assert.equal(git(root, "config", "--get", "core.hooksPath"), "scripts/quality/git-hooks");
  const dispatcher = readFileSync(path.join(root, "scripts/quality/git-hooks/commit-msg"), "utf8");
  assert.match(dispatcher, /quality-tools\/node_modules\/@agile-team\/wl-skills-bd/); assert.match(dispatcher, /commit validate --file/);
  assert.doesNotMatch(dispatcher, /command -v wl-skills-bd/);
  assert.ok(planOnboarding({ root }).files.every((file) => file.action === "unchanged"));
});

test("默认九维Review策略绑定真实项目；自有差异冲突拒绝覆盖", (t) => {
  const root = fixture(t); const plan = planOnboarding({ root });
  const policy = JSON.parse(plan.files.find((file) => file.path === "quality/review-policy.json").afterContent);
  assert.equal(policy.project, "fixture-console"); assert.equal(policy.dimensions.length, 9); apply({ root }, plan);
  policy.dimensions[0].applicable = false; put(root, "quality/review-policy.json", policy);
  const next = planOnboarding({ root }); assert.ok(next.hardConflicts.some((conflict) => conflict.target === "quality/review-policy.json"));
  assert.throws(() => apply({ root }, next), /零写入/); assert.equal(JSON.parse(readFileSync(path.join(root, "quality/review-policy.json"))).dimensions[0].applicable, false);
});
