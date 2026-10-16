import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { registryInstallationEvidence, verifyLockOrigins } from "../../lib/onboard-registry.js";
const approved = "https://registry.example.invalid/";
function fixture(t) { const root = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-registry-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
test("只读pnpm配置禁止版本自动下载，只保留registry且安装强制全部scope和版本", (t) => {
  const root = fixture(t); let argv;
  const evidence = registryInstallationEvidence({ root, kind: "frontend", approved, executable: process.execPath, manager: "pnpm", manifestContent: JSON.stringify({ packageManager: "pnpm@10.34.5", devDependencies: { "@demo/checker": "1.0.0" } }), runner: (exe, args) => {
    argv = args; return { status: 0, stdout: JSON.stringify({ registry: approved, "@old:registry": "https://old.example.invalid/", "//registry.example.invalid/:_authToken": "SUPER_SECRET", userAgent: "pnpm/11.21.0 npm/?" }) };
  } });
  assert(argv.includes("--config.pm-on-fail=ignore")); assert(argv.includes("--config.manage-package-manager-versions=false"));
  assert(argv.includes("--config.ignore-pnpmfile=true"));
  assert(evidence.scopedRegistryOverrides.includes(`--config.@old:registry=${approved}`));
  assert(evidence.scopedRegistryOverrides.includes(`--config.@demo:registry=${approved}`));
  assert(evidence.packageManagerFlags.includes("--config.pm-on-fail=error")); assert.equal(evidence.packageManager.observed, "pnpm@11.21.0");
  assert(evidence.packageManagerFlags.includes("--config.ignore-pnpmfile=true"));
  assert(!JSON.stringify(evidence).includes("SUPER_SECRET"));
});

test("真实本机pnpm离线无依赖安装：ignore-scripts仍执行CJS/ESM钩子，明确ignore-pnpmfile后不执行，接入明确阻断待适配", async (t) => {
  const version = spawnSync("pnpm", ["--version", "--config.manage-package-manager-versions=false", "--config.ignore-pnpmfile=true"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  for (const extension of ["cjs", "mjs"]) await t.test(extension, (sub) => {
    const root = fixture(sub), marker = path.join(root, "pnpmfile-executed.txt"), hook = `.pnpmfile.${extension}`;
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true }));
    writeFileSync(path.join(root, ".npmrc"), `pnpmfile=${hook}\n`);
    writeFileSync(path.join(root, hook), extension === "cjs"
      ? "require('node:fs').writeFileSync('pnpmfile-executed.txt','executed');module.exports={hooks:{}};\n"
      : "import fs from 'node:fs';fs.writeFileSync('pnpmfile-executed.txt','executed');export const hooks={};\n");
    const args = ["install", "--offline", "--ignore-scripts", "--config.manage-package-manager-versions=false", "--config.pm-on-fail=error", "--config.package-manager-strict-version=true"];
    const unprotected = spawnSync("pnpm", args, { cwd: root, encoding: "utf8", timeout: 30000, env: { ...process.env, CI: "true" } });
    assert.equal(unprotected.status, 0, unprotected.stdout + unprotected.stderr);
    assert.equal(readFileSync(marker, "utf8"), "executed", "反例必须实际证明ignore-scripts并不禁pnpmfile");
    rmSync(marker);
    const protectedInstall = spawnSync("pnpm", [...args, "--config.ignore-pnpmfile=true"], { cwd: root, encoding: "utf8", timeout: 30000, env: { ...process.env, CI: "true" } });
    assert.equal(protectedInstall.status, 0, protectedInstall.stdout + protectedInstall.stderr);
    assert.equal(existsSync(marker), false);
    assert.throws(() => registryInstallationEvidence({ root, kind: "frontend", manager: "pnpm", executable: "pnpm", approved }), /pnpmfile.*固定摘要/);
    assert.equal(existsSync(marker), false, "真实配置预检也不执行钩子");
  });
});

for (const key of ["pnpmfile", "globalPnpmfile", "global-pnpmfile"]) test(`自定义/全局 ${key} 声明须固定适配，不靠跳过钩子伪装接入成功`, (t) => {
  const root = fixture(t);
  assert.throws(() => registryInstallationEvidence({ root, kind: "frontend", manager: "pnpm", executable: process.execPath, approved,
    manifestContent: "{}", runner: () => ({ status: 0, stdout: JSON.stringify({ registry: approved, [key]: "private-required-hook.cjs" }) }) }), /必要依赖转换/);
});
for (const value of ["https://user:SECRET@registry.example.invalid/", "https://registry.example.invalid/?token=SECRET", "https://registry.example.invalid/#SECRET"]) test("registry凭据和查询参数不进计划或错误消息", (t) => {
  const root = fixture(t); assert.throws(() => registryInstallationEvidence({ root, kind: "frontend", approved, executable: process.execPath, manager: "pnpm", manifestContent: "{}", runner: () => ({ status: 0, stdout: JSON.stringify({ registry: value }) }) }), (error) => !error.message.includes("SECRET"));
});
test("旧锁非批准源拒绝；deprecation文档URL不被误认为下载源", (t) => {
  const root = fixture(t), lock = path.join(root, "pnpm-lock.yaml");
  writeFileSync(lock, "lockfileVersion: '9.0'\npackages:\n  test@1:\n    deprecated: see https://eslint.org/version-support\n    resolution: {tarball: https://registry.example.invalid/test.tgz}\n");
  assert.equal(verifyLockOrigins(root, "frontend", approved).tarballs.length, 1);
  writeFileSync(lock, "packages:\n  x:\n    resolution: {tarball: https://unapproved.example.invalid/x.tgz}\n"); assert.throws(() => verifyLockOrigins(root, "frontend", approved), /批准源/);
});
test("项目内vendor文件用实际摘要绑定，越界和链接拒绝", (t) => {
  const root = fixture(t); mkdirSync(path.join(root, "vendor")); writeFileSync(path.join(root, "vendor/x.tgz"), "local vendor bytes");
  const lock = path.join(root, "pnpm-lock.yaml"); writeFileSync(lock, "resolution: {tarball: file:vendor/x.tgz}\n");
  assert.match(verifyLockOrigins(root, "frontend", approved).localTarballs[0].sha256, /^[a-f0-9]{64}$/);
  writeFileSync(lock, "resolution: {tarball: file:../outside.tgz}\n"); assert.throws(() => verifyLockOrigins(root, "frontend", approved), /越出/);
  symlinkSync("x.tgz", path.join(root, "vendor/link.tgz")); writeFileSync(lock, "resolution: {tarball: file:vendor/link.tgz}\n"); assert.throws(() => verifyLockOrigins(root, "frontend", approved), /符号链接/);
});
test("首次无锁安装逐项绑定npm alias、批准HTTPS和本地vendor摘要", (t) => {
  const root = fixture(t); mkdirSync(path.join(root, "vendor")); writeFileSync(path.join(root, "vendor/x.tgz"), "approved vendor");
  const manifest = { dependencies: { ordinary: "^1.2.0 || >=2 <3", alias: "npm:@approved/real@~2.0.0", vendor: "file:vendor/x.tgz", direct: `${approved}direct/-/direct-1.tgz` } };
  const evidence = registryInstallationEvidence({ root, kind: "frontend", approved, executable: process.execPath, manager: "pnpm", manifestContent: JSON.stringify(manifest), runner: () => ({ status: 0, stdout: JSON.stringify({ registry: approved }) }) });
  assert.equal(evidence.dependencySources.length, 4); assert.equal(evidence.dependencySources.find((v) => v.name === "alias").source, "approved-registry-alias");
  assert.match(evidence.dependencySources.find((v) => v.name === "vendor").sha256, /^[a-f0-9]{64}$/);
});
for (const value of ["git+https://git.example.invalid/project.git", "ssh://git@example.invalid/project", "owner/project", "github:owner/project", "https://unapproved.example.invalid/x.tgz", "file:../outside.tgz", "file:vendor", "link:../project", "workspace:*", "patch:pkg@1#./patch"]) test(`安装前拒绝非registry受控依赖来源 ${value.split(":")[0]}`, (t) => {
  const root = fixture(t); let called = false;
  assert.throws(() => registryInstallationEvidence({ root, kind: "frontend", approved, executable: process.execPath, manager: "pnpm", manifestContent: JSON.stringify({ dependencies: { unknown: value } }), runner: () => { called = true; throw new Error("source preflight must run first"); } }), /未批准|批准源|越出/);
  assert.equal(called, false);
});
test("锁中Git commit/repo解析不能混入批准npm源", (t) => {
  const root = fixture(t); writeFileSync(path.join(root, "pnpm-lock.yaml"), "packages:\n  example:\n    resolution: {repo: https://github.com/user/project, commit: aaaaaaaa, type: git}\n");
  assert.throws(() => verifyLockOrigins(root, "frontend", approved), /未批准Git/);
});
