import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate } from "../../lib/run.js";
import { loadConfig } from "../../lib/config.js";
import { validatePassingSummary, validateExecutedSummary } from "../../lib/evidence.js";
import { git } from "../../lib/source-state.js";
import { run as cmdRun } from "../../lib/adapters/cmd-json.js";

const gateVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
const fileA = "module-a/target/surefire-reports/TEST-suite.A.xml";
const fileB = "module-b/target/surefire-reports/TEST-suite.B.xml";
const dirs = ["module-a/target/surefire-reports", "module-b/target/surefire-reports"];
function suite(name, state = "passed", caseName = "core", className = name) {
  const body = state === "passed" ? "" : `<${state} message="fixture result"/>`;
  return `<testsuite name="${name}" tests="1" failures="${state === "failure" ? 1 : 0}" errors="${state === "error" ? 1 : 0}" skipped="${state === "skipped" ? 1 : 0}"><testcase classname="${className}" name="${caseName}">${body}</testcase></testsuite>`;
}
function fixture(t, { reports = { [fileA]: suite("suite.A"), [fileB]: suite("suite.B") }, exit = 0, extra = "", split = false, controlled = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-junit-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "quality")); mkdirSync(path.join(root, "quality-reports"));
  const base = { tool: "junit", producer: "JAVA-UNIT", profiles: ["standard"], command: "node produce.mjs",
    versionCommand: `node -e 'console.log("unit-fixture@1")'` };
  const checks = split ? [
    { ...base, id: "UNIT-A", files: [fileA], reportDirs: [dirs[0]], requiredTests: ["suite.A#core"], requiredSuites: ["suite.A"] },
    { ...base, id: "UNIT-B", files: [fileB], reportDirs: [dirs[1]], requiredTests: ["suite.B#core"], requiredSuites: ["suite.B"] },
  ] : [{ ...base, id: "UNIT", files: [fileA, fileB], reportDirs: dirs, requiredTests: ["suite.A#core", "suite.B#core"], requiredSuites: ["suite.A", "suite.B"] }];
  const policy = { schemaVersion: 1, project: "junit-fixture", checks };
  writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(policy));
  writeFileSync(path.join(root, "quality/rules.lock.json"), JSON.stringify({ "wl-skills-gate": gateVersion, tools: Object.fromEntries(checks.map((c) => [c.id, "unit-fixture@1"])) }));
  writeFileSync(path.join(root, "produce.mjs"), `import{writeFileSync,readFileSync,existsSync}from'node:fs';
const reports=${JSON.stringify(reports)};
if(${JSON.stringify([fileA, fileB])}.some(p=>existsSync(p)))process.exit(9);
let n=0;try{n=Number(readFileSync('quality-reports/count.txt','utf8'));}catch{}
writeFileSync('quality-reports/count.txt',String(n+1));
for(const[p,xml]of Object.entries(reports))writeFileSync(p,xml);
${extra}
process.exit(${exit});`);
  if (controlled) {
    writeFileSync(path.join(root, ".gitignore"), "target/\nquality-reports/\n");
    git(["init", "-q"], root); git(["config", "user.name", "quality-fixture"], root); git(["config", "user.email", "quality-fixture@example.invalid"], root);
    git(["add", "."], root); git(["commit", "-qm", "approved-fixture"], root);
  }
  return { root, checks, policy };
}
const run = (root) => runGate({ argv: ["--root", root] });

test("JUnit 全部原始报告本轮生产一次，清理旧 XML，真实计数/必测/源摘要可独立验收", async (t) => {
  const { root } = fixture(t, { controlled: true });
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, fileA), "STALE"); writeFileSync(path.join(root, dirs[0], "OLD-suite.xml"), "STALE");
  const sha = git(["rev-parse", "HEAD"], root);
  const config = loadConfig(root);
  for (let n = 1; n <= 2; n++) {
    const r = await runGate({ argv: ["--root", root, "--sha", sha] });
    assert.equal(r.exitCode, 0);
    assert.equal(Number(readFileSync(path.join(root, "quality-reports/count.txt"))), n);
    assert.equal(existsSync(path.join(root, dirs[0], "OLD-suite.xml")), false);
    const c = r.summary.checks[0];
    assert.equal(c.testEvidence.files.length, 2); assert.equal(c.testEvidence.counts.tests, 2);
    assert.equal(c.production.eventId, r.summary.run.eventId); assert.equal(c.production.sourceDigest, r.summary.run.sourceDigest);
    assert.equal(r.summary.productions[0].reportCount, 2); assert.equal(r.summary.productions[0].commandRuns, 1);
    assert.deepEqual(validatePassingSummary(r.summary, { sha, project: "junit-fixture", profile: "standard", expectPolicyHash: config.policyHash, expectRulesHash: config.ruleSetHash }), []);
  }
});

test("多个 JUnit 检查共享同轮生产，失败模块的实际 XML 让整轮 blocked", async (t) => {
  for (const state of ["passed", "failure"]) {
    const { root } = fixture(t, { split: true, reports: { [fileA]: suite("suite.A"), [fileB]: suite("suite.B", state) }, exit: state === "passed" ? 0 : 1 });
    const r = await run(root);
    assert.equal(r.exitCode, state === "passed" ? 0 : 1);
    assert.equal(r.summary.productions[0].commandRuns, 1);
    assert.deepEqual(r.summary.checks.map((c) => c.production.reused), [false, true]);
    assert.ok(r.summary.checks.every((c) => c.status === "ok"));
  }
});

test("安装验收只接受完整执行的失败JUnit，正式放行仍拒绝；缺原件/范围/计数仍不能验收执行", async (t) => {
  const { root } = fixture(t, { controlled: true, reports: { [fileA]: suite("suite.A"), [fileB]: suite("suite.B", "failure") }, exit: 1 });
  const sha = git(["rev-parse", "HEAD"], root), config = loadConfig(root), result = await runGate({ argv: ["--root", root, "--sha", sha] });
  const expected = { sha, project: "junit-fixture", profile: "standard", expectPolicyHash: config.policyHash, expectRulesHash: config.ruleSetHash };
  assert.equal(result.exitCode, 1); assert.equal(result.summary.decision.status, "blocked");
  assert.deepEqual(validateExecutedSummary(result.summary, expected), []);
  assert.ok(validatePassingSummary(result.summary, expected).length > 0, "完整执行不代表质量通过，正式签发不变");
  for (const mutate of [
    value => { delete value.checks[0].production; },
    value => { value.checks[0].testEvidence.requiredTests = []; },
    value => { value.checks[0].testEvidence.counts.passed += 2; },
    value => { value.checks[0].status = "invalid"; },
    value => { value.checks[0].testEvidence.files[0].sha256 = "wrong"; },
  ]) { const invalid = structuredClone(result.summary); mutate(invalid); assert.ok(validateExecutedSummary(invalid, expected).length > 0); }
});

for (const [name, reports, expected] of [
  ["前一份失败", { [fileA]: suite("suite.A", "failure"), [fileB]: suite("suite.B") }, 1],
  ["后一份失败", { [fileA]: suite("suite.A"), [fileB]: suite("suite.B", "error") }, 1],
  ["后一份空套件", { [fileA]: suite("suite.A"), [fileB]: '<testsuite name="suite.B" tests="0"/>' }, 1],
  ["必测跳过", { [fileA]: suite("suite.A"), [fileB]: suite("suite.B", "skipped") }, 1],
  ["遗漏必测套件", { [fileA]: suite("suite.A"), [fileB]: suite("other.B") }, 1],
  ["末份损坏", { [fileA]: suite("suite.A"), [fileB]: '<testsuite name="suite.B"><testcase' }, 2],
  ["末份声明数伪造", { [fileA]: suite("suite.A"), [fileB]: suite("suite.B").replace('tests="1"', 'tests="2"') }, 2],
  ["跨文件重复 testcase", { [fileA]: suite("suite.A"), [fileB]: suite("suite.B", "passed", "core", "suite.A") }, 2],
]) test(`JUnit 完整多报告：${name}`, async (t) => {
  const { root } = fixture(t, { reports }); assert.equal((await run(root)).exitCode, expected);
});

test("参数化用例完整名字可以区分，同 class/name 重复和缺 name 失败关闭", async (t) => {
  const { root, policy } = fixture(t, { reports: { [fileA]: suite("suite.A", "passed", "core[1]"), [fileB]: suite("suite.B", "passed", "core[2]", "suite.A") } });
  policy.checks[0].requiredTests = ["suite.A#core[1]", "suite.A#core[2]"];
  writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(policy));
  assert.equal((await run(root)).exitCode, 0);
  for (const xml of [
    '<testsuite><testcase name="same"/><testcase name="same"/></testsuite>',
    '<testsuite><testcase classname="suite.A"/></testsuite>',
  ]) {
    const { root: other } = fixture(t, { reports: { [fileA]: xml, [fileB]: suite("suite.B") } });
    assert.equal((await run(other)).exitCode, 2);
  }
});

test("报告全集缺一份不能用旧 XML 补齐，未登记新 XML 也拒绝", async (t) => {
  for (const reports of [{ [fileA]: suite("suite.A") }, { [fileA]: suite("suite.A"), [fileB]: suite("suite.B"), [`${dirs[1]}/TEST-unapproved.xml`]: suite("unapproved") }]) {
    const { root } = fixture(t, { reports });
    mkdirSync(path.join(root, dirs[1]), { recursive: true }); writeFileSync(path.join(root, fileB), suite("suite.B"));
    const r = await run(root);
    assert.equal(r.exitCode, 2); assert.match(r.summary.checks[0].reason, /报告全集/);
    assert.equal(Number(readFileSync(path.join(root, "quality-reports/count.txt"))), 1);
  }
});

test("exit 1 只有实际 failure/error 能解释；exit 2 不被任何测试失败掩盖", async (t) => {
  for (const [state, exit] of [["passed", 1], ["skipped", 1], ["failure", 2]]) {
    const { root } = fixture(t, { reports: { [fileA]: suite("suite.A"), [fileB]: suite("suite.B", state) }, exit });
    assert.equal((await run(root)).exitCode, 2);
  }
});

test("JUnit 配置无 glob、路径别名、空范围、错误目录及混合生产者，不静默放宽", (t) => {
  const { root, policy } = fixture(t);
  for (const change of [
    { files: [fileA, fileA] }, { files: [fileA, `module-a/target/./surefire-reports/TEST-suite.A.xml`] },
    { files: [`module-a/target/./surefire-reports/TEST-suite.A.xml`, fileB] },
    { files: ["**/target/surefire-reports/*.xml"] }, { files: ["../outside.xml"] },
    { file: fileA }, { reportDirs: undefined }, { reportDirs: [dirs[0]] }, { reportDirs: [...dirs, "extra"] },
    { files: [] }, { requiredSuites: ["x", "x"] }, { timeoutMs: -1 },
  ]) {
    const p = structuredClone(policy); Object.assign(p.checks[0], change);
    writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(p)); assert.throws(() => loadConfig(root));
  }
  const p = structuredClone(policy);
  p.checks.push({ id: "PMD", tool: "java-xml", format: "pmd", profiles: ["standard"], producer: "JAVA-UNIT", command: "node produce.mjs", file: "quality-reports/pmd.xml" });
  writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(p)); assert.throws(() => loadConfig(root), /tool/);
});

test("报告目录 symlink 拒绝且不清理外部 XML", async (t) => {
  const { root } = fixture(t);
  const external = mkdtempSync(path.join(tmpdir(), "wl-gate-junit-external-")); t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(path.join(external, "TEST-source.xml"), "external source");
  mkdirSync(path.join(root, "module-a/target"), { recursive: true }); symlinkSync(external, path.join(root, dirs[0]));
  assert.equal((await run(root)).exitCode, 2); assert.equal(readFileSync(path.join(external, "TEST-source.xml"), "utf8"), "external source");
  assert.equal(existsSync(path.join(root, "quality-reports/count.txt")), false);
});

test("末模块报告指向已跟踪输入时预检零清理，首模块旧报告也保留", async (t) => {
  const { root } = fixture(t, { controlled: true });
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, fileA), "old report"); writeFileSync(path.join(root, fileB), "approved XML input");
  git(["add", "-f", fileB], root); git(["commit", "-qm", "track-approved-input"], root);
  const r = await run(root); assert.equal(r.exitCode, 2);
  assert.match(r.summary.checks[0].reason, /已跟踪源码/);
  assert.equal(readFileSync(path.join(root, fileA), "utf8"), "old report");
  assert.equal(readFileSync(path.join(root, fileB), "utf8"), "approved XML input");
  assert.equal(r.summary.productions[0].commandRuns, 0);
});

test("报告 UTF-8 编码损坏不能通过替换字符静默解析", async (t) => {
  const { root } = fixture(t, { extra: `writeFileSync(${JSON.stringify(fileB)},Buffer.from([60,116,101,115,116,115,117,105,116,101,62,255,60,47,116,101,115,116,115,117,105,116,101,62]));` });
  assert.equal((await run(root)).exitCode, 2);
});

test("cmd-json 输出不能清理已跟踪源码，失败前无写入", async (t) => {
  const { root } = fixture(t, { controlled: true });
  const result = await cmdRun({ tool: "cmd-json", command: "node -e 'process.exit(0)'", file: "produce.mjs", captureStdout: true }, { root });
  assert.equal(result.status, "invalid"); assert.match(result.reason, /已跟踪源码/);
  assert.match(readFileSync(path.join(root, "produce.mjs"), "utf8"), /const reports=/);
});

test("无 Git 本地检查也不能先删除已有源码再报告漂移", async (t) => {
  const { root, policy } = fixture(t);
  writeFileSync(path.join(root, "source.json"), '{"business":"approved"}');
  policy.checks = [{ id: "CMD", tool: "cmd-json", command: `node -e 'console.log(JSON.stringify({findings:[]}))'`, captureStdout: true, file: "source.json", profiles: ["standard"] }];
  writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(policy));
  const r = await run(root); assert.equal(r.exitCode, 2);
  assert.match(r.summary.checks[0].reason, /源码快照/);
  assert.equal(readFileSync(path.join(root, "source.json"), "utf8"), '{"business":"approved"}');
});

test("后续检查修改已消费 XML，Gate 不能依据先前结果通过", async (t) => {
  const { root, policy } = fixture(t);
  writeFileSync(path.join(root, "alter.mjs"), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(fileA)},'changed');console.log(JSON.stringify({findings:[]}));`);
  policy.checks.push({ id: "AFTER", tool: "cmd-json", command: "node alter.mjs", profiles: ["standard"] });
  writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(policy));
  const r = await run(root); assert.equal(r.exitCode, 2);
  assert.ok(r.summary.checks.some((c) => c.checkId === "GATE/REPORT-DRIFT" && /发生变化/.test(c.reason)));
});

test("测试期间修改源码，原始 XML 正常也不能放行", async (t) => {
  const { root } = fixture(t, { extra: "writeFileSync('source.txt','changed');" });
  writeFileSync(path.join(root, "source.txt"), "approved source");
  const r = await run(root); assert.equal(r.exitCode, 2);
  assert.ok(r.summary.checks.some((c) => c.checkId === "GATE/SOURCE-DRIFT"));
});

test("独立签发复核拒绝缺文件、改计数、必测未通过、缺源绑定或错误报告摘要", async (t) => {
  const { root } = fixture(t, { controlled: true });
  const sha = git(["rev-parse", "HEAD"], root);
  const r = await runGate({ argv: ["--root", root, "--sha", sha] }); assert.equal(r.exitCode, 0);
  const pins = { sha, project: "junit-fixture", profile: "standard", expectPolicyHash: r.summary.policy.policyHash, expectRulesHash: r.summary.policy.ruleSetHash };
  for (const change of [
    (s) => s.checks[0].testEvidence.files.pop(),
    (s) => { s.checks[0].testEvidence.counts.tests = 20; },
    (s) => { s.checks[0].testEvidence.requiredTests[0].passed = false; },
    (s) => { s.checks[0].testEvidence.requiredSuites[0].passed = false; },
    (s) => { s.checks[0].production.sourceDigest = "f".repeat(64); },
    (s) => { s.checks[0].production.reports[0].sha256 = "f".repeat(64); },
    (s) => { delete s.policy.junitScopes; },
  ]) { const copy = structuredClone(r.summary); change(copy); assert.ok(validatePassingSummary(copy, pins).some((e) => /JUnit/.test(e))); }
});
