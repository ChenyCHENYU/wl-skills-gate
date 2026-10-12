import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runGate, parseArgs } from "../../lib/run.js";
import { loadConfig } from "../../lib/config.js";
import { git, snapshotSource, safePath } from "../../lib/source-state.js";
import { buildFixPlan, applyFixPlan } from "../../lib/fix.js";
import { validatePassingSummary } from "../../lib/evidence.js";
import { redactLog } from "../../lib/exec.js";
import * as eslint from "../../lib/adapters/eslint.js";

const gateVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

function fixture(t, files = {}, checks = [], extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-closure-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = { ".gitignore": "quality-reports/\ndist/\ntarget/\ncoverage/\nnode_modules/\n",
    "quality/policy.json": JSON.stringify({ schemaVersion: 1, project: "closure", checks, ...extra }), ...files };
  for (const [p, data] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), typeof data === "string" ? data : JSON.stringify(data));
  }
  git(["init", "-q"], root); git(["config", "user.name", "Closure Test"], root);
  git(["config", "user.email", "closure@example.invalid"], root);
  git(["add", "-A"], root); git(["commit", "-qm", "fixture"], root);
  return root;
}
function commit(root) { git(["add", "-A"], root); git(["commit", "-qm", "change"], root); return git(["rev-parse", "HEAD"], root); }
const ctx = (root, extra = {}) => ({ root, project: "closure", ...extra });
const scanner = { id: "SCAN", tool: "cmd-json", command: "node scan.mjs", versionCommand: "node --version", profiles: ["standard", "release"] };
const scannerFiles = { "src.txt": "source", "scan.mjs": "console.log(JSON.stringify({findings:[]}));",
  "quality/rules.lock.json": { lockVersion: 1, "wl-skills-gate": gateVersion, tools: { SCAN: process.version } } };
const fakeLint = `#!/usr/bin/env node
import path from 'node:path';
const args=process.argv.slice(2), i=args.indexOf('--format');
const targets=args.slice(i+2);
const files=targets.flatMap(p=>p==='.'||p==='src'?['src/a.js']:p);
console.log(JSON.stringify(files.map(p=>({filePath:path.resolve(p),messages:[{ruleId:'no-var',severity:2,message:'bad'}]}))));
process.exit(files.length?1:0);
`;

test("ESLint 全量传入默认目标，不再把无参数空报告当通过", async (t) => {
  const root = fixture(t, { "lint.mjs": fakeLint, "src/a.js": "var a=1;" });
  const r = await eslint.run({ bin: process.execPath, args: "lint.mjs" }, ctx(root));
  assert.equal(r.status, "ok"); assert.equal(r.findings.length, 1);
  assert.deepEqual(r.coverage.targets, ["."]); assert.equal(r.coverage.scannedFileCount, 1);
});
test("ESLint 显式 targets/args 与扫描证据一起保存", async (t) => {
  const root = fixture(t, { "lint.mjs": fakeLint, "src/a.js": "var a=1;" });
  const r = await eslint.run({ bin: process.execPath, args: "lint.mjs", targets: ["src"] }, ctx(root));
  assert.deepEqual(r.coverage.targets, ["src"]); assert.deepEqual(r.coverage.scannedFiles, ["src/a.js"]);
});
for (const [name, script, pattern] of [
  ["空扫描", "console.log('[]');", /扫描文件数为 0/],
  ["全部忽略", "console.log(JSON.stringify([{filePath:process.cwd()+'/src/a.js',messages:[{severity:1,message:'File ignored because of a matching ignore pattern.'}]}]));", /扫描文件数为 0/],
  ["忽略与错误混合", "console.log(JSON.stringify([{filePath:process.cwd()+'/src/a.js',messages:[{severity:1,message:'File ignored because of a matching ignore pattern.'},{severity:2,ruleId:'no-var',message:'bad'}]}]));", /报告不一致/],
  ["非零退出却没有问题", "console.log(JSON.stringify([{filePath:process.cwd()+'/src/a.js',messages:[]}]));process.exit(1);", /非零退出/],
  ["项目外结果", "console.log(JSON.stringify([{filePath:'/outside.js',messages:[]}]));", /超出项目/],
]) test(`ESLint 拒绝${name}`, async (t) => {
  const root = fixture(t, { "lint.mjs": script });
  const r = await eslint.run({ command: "node lint.mjs" }, ctx(root));
  assert.equal(r.status, "invalid"); assert.match(r.reason, pattern);
});
test("ESLint 增量精确处理中文和空格文件名", async (t) => {
  const root = fixture(t, { "lint.mjs": fakeLint }); const base = git(["rev-parse", "HEAD"], root);
  const name = "页面 空格.js"; writeFileSync(path.join(root, name), "var a=1"); const head = commit(root);
  const r = await eslint.run({ bin: process.execPath, args: "lint.mjs" }, ctx(root, { base, head }));
  assert.equal(r.status, "ok"); assert.deepEqual(r.coverage.requestedFiles, [name]); assert.deepEqual(r.coverage.scannedFiles, [name]);
});
test("ESLint 增量漏扫与真实无适用文件作不同处理", async (t) => {
  const root = fixture(t, { "lint.mjs": "console.log('[]');" }); const base = git(["rev-parse", "HEAD"], root);
  writeFileSync(path.join(root, "a.js"), "a"); const head = commit(root);
  const missed = await eslint.run({ bin: process.execPath, args: "lint.mjs" }, ctx(root, { base, head }));
  assert.equal(missed.status, "invalid"); assert.match(missed.reason, /未实际检查/);
  writeFileSync(path.join(root, "note.md"), "note"); git(["add", "note.md"], root);
  const empty = await eslint.run({ bin: process.execPath, args: "lint.mjs" }, ctx(root, { scope: "staged" }));
  assert.equal(empty.status, "ok"); assert.equal(empty.coverage.noApplicableFiles, true);
});
test("targets 越界/重复和检查 args 的修复参数被拒绝", (t) => {
  for (const config of [{ targets: ["../src"] }, { targets: [] }, { targets: ["src", "src"] }, { args: "--fix" }, { args: "--fix-dry-run" }, { args: "'--fix'" }]) {
    const root = fixture(t, {}, [{ id: "LINT", tool: "eslint", profiles: ["standard"], ...config }]);
    assert.throws(() => loadConfig(root), /targets|检查与修复/);
  }
});
test("原生执行失败诊断不能被版本核验覆盖", async (t) => {
  const root = fixture(t, { ...scannerFiles, "scan.mjs": "console.error('Non-resolvable parent POM: company-private-parent');process.exit(2);" }, [scanner]);
  const r = await runGate({ argv: ["--root", root, "--sha", git(["rev-parse", "HEAD"], root)] });
  assert.equal(r.exitCode, 2); assert.match(r.summary.checks[0].reason, /company-private-parent/);
  assert.equal(r.summary.checks[0].toolVersionVerified, false);
});
test("release 参数和签发语义均拒绝增量证明", async (t) => {
  assert.throws(() => parseArgs(["--profile", "release", "--base", "a", "--head", "b"]), /全量检查/);
  const root = fixture(t, scannerFiles, [scanner], { releaseRequires: ["SCAN"] });
  const sha = git(["rev-parse", "HEAD"], root);
  const r = await runGate({ argv: ["--root", root, "--profile", "release", "--env", "prd"] });
  assert.equal(r.exitCode, 0); r.summary.run.base = sha; r.summary.run.head = sha;
  const errors = validatePassingSummary(r.summary, { sha, project: "closure", profile: "release", env: "prd",
    expectPolicyHash: r.summary.policy.policyHash, expectRulesHash: r.summary.policy.ruleSetHash });
  assert.ok(errors.some((e) => /全量检查/.test(e)));
});
test("正式 ESLint 证明拒绝缺覆盖、重复清单及增量漏文件", async (t) => {
  const lint = { id: "LINT", tool: "eslint", bin: process.execPath, args: "lint.mjs", versionCommand: "node --version", profiles: ["standard"] };
  const root = fixture(t, { "src/a.js": "const a=1;", "lint.mjs": "console.log(JSON.stringify([{filePath:process.cwd()+'/src/a.js',messages:[]}]));",
    "quality/rules.lock.json": { lockVersion: 1, "wl-skills-gate": gateVersion, tools: { LINT: process.version } } }, [lint]);
  const sha = git(["rev-parse", "HEAD"], root);
  const r = await runGate({ argv: ["--root", root, "--sha", sha] }); assert.equal(r.exitCode, 0);
  const pins = { sha, project: "closure", profile: "standard", expectPolicyHash: r.summary.policy.policyHash, expectRulesHash: r.summary.policy.ruleSetHash };
  assert.deepEqual(validatePassingSummary(r.summary, pins), []);
  for (const coverage of [null, { mode: "full", complete: true, requestedFiles: null, scannedFileCount: 0, scannedFiles: [] },
    { mode: "full", complete: true, requestedFiles: null, scannedFileCount: 2, scannedFiles: ["src/a.js", "src/a.js"] },
    { mode: "range", complete: true, scannedFileCount: 1, scannedFiles: ["src/a.js"], requestedFiles: ["src/missing.js"] }]) {
    const summary = structuredClone(r.summary); summary.checks[0].coverage = coverage;
    if (coverage?.mode === "range") { summary.run.base = sha; summary.run.head = sha; }
    assert.ok(validatePassingSummary(summary, pins).some((e) => /扫描证据|扫描清单/.test(e)));
  }
  const malformed = structuredClone(r.summary); delete malformed.checks[0].coverage.requestedFiles;
  assert.ok(validatePassingSummary(malformed, pins).some((e) => /requestedFiles/.test(e)));
});
test("已跟踪 dist 源码不能被默认目录或报告 exclude 隐藏", (t) => {
  const root = fixture(t, { "dist/source.js": "approved" });
  git(["add", "-f", "dist/source.js"], root); git(["commit", "-qm", "track-dist"], root);
  const before = snapshotSource(root, { exclude: ["dist"] });
  assert.ok(before.entries["dist/source.js"]); assert.equal(before.dirty, false);
  writeFileSync(path.join(root, "dist/source.js"), "changed");
  const after = snapshotSource(root, { exclude: ["dist"] });
  assert.equal(after.dirty, true); assert.notEqual(after.digest, before.digest);
});
test("报告目录不覆盖已跟踪文件，也不经过符号链接", async (t) => {
  const root = fixture(t, scannerFiles, [scanner]);
  for (const out of [".", "src.txt", "quality"]) {
    const r = await runGate({ argv: ["--root", root, "--out", out] });
    assert.equal(r.exitCode, 2); assert.match(r.summary.decision.reasons[0], /覆盖/);
  }
  assert.equal(readFileSync(path.join(root, "src.txt"), "utf8"), "source");
  const outside = mkdtempSync(path.join(tmpdir(), "wl-gate-outside-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(root, "quality-reports"));
  assert.equal((await runGate({ argv: ["--root", root] })).exitCode, 2);
  assert.equal(existsSync(path.join(outside, "quality-summary.json")), false);
});
test("断链、父路径符号链接及 FIFO 不能绕过路径/源码快照", (t) => {
  const root = fixture(t, { "src/a.txt": "a" });
  symlinkSync("/does-not-exist", path.join(root, "broken")); assert.throws(() => safePath(root, "broken"), /符号链接/);
  const outside = mkdtempSync(path.join(tmpdir(), "wl-gate-parent-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "a.txt"), "external"); rmSync(path.join(root, "src"), { recursive: true });
  symlinkSync(outside, path.join(root, "src")); assert.throws(() => snapshotSource(root), /符号链接/);
  rmSync(path.join(root, "src")); mkdirSync(path.join(root, "src"));
  assert.equal(spawnSync("mkfifo", [path.join(root, "src/a.txt")]).status, 0);
  assert.throws(() => snapshotSource(root), /非普通文件/);
});
test("空基线/豁免也需批准，正确摘要能继续受控检查", async (t) => {
  const root = fixture(t, { ...scannerFiles, "quality/baseline.json": { items: [] }, "quality/waivers.json": [] }, [scanner]);
  const sha = git(["rev-parse", "HEAD"], root); const c = loadConfig(root);
  assert.equal((await runGate({ argv: ["--root", root, "--sha", sha] })).exitCode, 2);
  assert.equal((await runGate({ argv: ["--root", root, "--sha", sha, "--expect-baseline-hash", c.baselineHash, "--expect-waivers-hash", c.waiversHash] })).exitCode, 0);
});
test("依赖准备日志脱敏保留错误上下文", () => {
  const secret = "private-token-abcdef";
  const log = redactLog(`network failure ${secret} https://user:password@example.invalid Authorization: Bearer abcdef token=defghi`, { BUILD_TOKEN: secret });
  assert.match(log, /network failure/); assert.doesNotMatch(log, /private-token-abcdef|user:password|abcdef|defghi/);
});

async function repairFixture(t, fixer) {
  const files = { "src.txt": "bad", "fix.mjs": fixer,
    "scan.mjs": `import fs from 'node:fs';console.log(JSON.stringify({findings:fs.readFileSync('src.txt','utf8')==='bad'?[{ruleId:'DEMO/R',severity:'error',file:'src.txt',message:'bad',autoFixable:true,fixerId:'safe'}]:[]}));` };
  const root = fixture(t, files, [scanner], { fixers: [{ id: "safe", ruleIds: ["DEMO/R"], files: ["src.txt"], command: "node fix.mjs" }] });
  const r = await runGate({ argv: ["--root", root] }); assert.equal(r.exitCode, 1);
  return { root, ...buildFixPlan(path.join(root, "quality-reports/quality-summary.json"), { root }) };
}
test("修复替换成符号链接时回滚、重新扫描且不改外部文件", async (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), "wl-gate-fix-outside-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, "target.txt"); writeFileSync(target, "external");
  const { root, planFile } = await repairFixture(t, `import fs from 'node:fs';fs.rmSync('src.txt');fs.symlinkSync(${JSON.stringify(target)},'src.txt');`);
  const r = await applyFixPlan(planFile, { root, confirm: true });
  assert.equal(r.exitCode, 2); assert.equal(r.fixReport.rolledBack, true); assert.deepEqual(r.fixReport.fixed, []);
  assert.equal(r.fixReport.rollbackVerification.sourceRestored, true); assert.equal(r.fixReport.after.decision, "blocked");
  assert.equal(readFileSync(target, "utf8"), "external"); assert.equal(lstatSync(path.join(root, "src.txt")).isSymbolicLink(), false);
  assert.equal(JSON.parse(readFileSync(path.join(root, "quality-reports/quality-summary.json"))).decision.status, "blocked");
});
test("修复器改变 HEAD 必须人工恢复，不能声称已回滚", async (t) => {
  const { root, planFile } = await repairFixture(t, `import fs from 'node:fs';import {spawnSync} from 'node:child_process';fs.writeFileSync('src.txt','fixed');spawnSync('git',['add','src.txt']);spawnSync('git',['commit','-qm','fixer-commit']);`);
  const before = git(["rev-parse", "HEAD"], root);
  const r = await applyFixPlan(planFile, { root, confirm: true });
  assert.equal(r.exitCode, 2); assert.equal(r.fixReport.rolledBack, false); assert.equal(r.fixReport.manualRecoveryRequired, true);
  assert.deepEqual(r.fixReport.fixed, []); assert.notEqual(git(["rev-parse", "HEAD"], root), before);
});
