import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "../../lib/source-state.js";

const wrapper = new URL("../../templates/scripts-quality/java-unit.mjs", import.meta.url).pathname;
function fixture(t, { prepare = true, controlled = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-java-unit-wrapper-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  const plan = { schemaVersion: 1, prepareDependencies: prepare, offline: true, modules: ["module-a", "module-b"].map((name) => ({ path: name, reportFiles: [`${name}/target/surefire-reports/TEST-${name}.xml`] })) };
  for (const m of plan.modules) write(`${m.path}/pom.xml`, "<project/>");
  write("quality/java-unit.plan.json", JSON.stringify(plan));
  const command = path.join(root, "fake-mvn.mjs");
  writeFileSync(command, `#!/usr/bin/env node
import{mkdirSync,appendFileSync,readFileSync,writeFileSync}from'node:fs';
const args=process.argv.slice(2);mkdirSync('quality-reports',{recursive:true});
appendFileSync('quality-reports/fake-maven-calls.jsonl',JSON.stringify(args)+'\\n');
if(process.env.FAKE_LOG_SECRET)console.log('credential='+process.env.FAKE_LOG_SECRET);
if(process.env.FAKE_LOG_TEXT)console.log(process.env.FAKE_LOG_TEXT);
if(args.includes('install'))process.exit(process.env.FAKE_PREP_FAIL?1:0);
const plan=JSON.parse(readFileSync('quality/java-unit.plan.json','utf8'));
for(const m of plan.modules)for(const file of m.reportFiles){if(process.env.FAKE_XML_MODE==='missing'&&m.path==='module-b')continue;mkdirSync(file.slice(0,file.lastIndexOf('/')),{recursive:true});writeFileSync(file,'<testsuite name="fixture" tests="1"><testcase classname="fixture" name="ok"/></testsuite>');}
if(process.env.FAKE_XML_MODE==='extra')writeFileSync('module-b/target/surefire-reports/TEST-extra.xml','<testsuite/>');
process.exit(process.env.FAKE_UNIT_FAIL?1:0);
`, { mode: 0o700 });
  if (controlled) {
    write(".gitignore", "target/\nquality-reports/\n"); git(["init", "-q"], root); git(["config", "user.name", "fixture"], root); git(["config", "user.email", "fixture@example.invalid"], root);
    git(["add", "."], root); git(["commit", "-qm", "fixture"], root);
  }
  const run = (extraEnv = {}) => spawnSync(process.execPath, [wrapper, "--plan", "quality/java-unit.plan.json"], { cwd: root, encoding: "utf8", env: { ...process.env, WL_MAVEN_COMMAND: command, WL_GATE_EVENT_ID: "fixture-event", WL_GATE_COMMIT_SHA: "a".repeat(40), ...extraEnv } });
  const calls = () => existsSync(path.join(root, "quality-reports/fake-maven-calls.jsonl")) ? readFileSync(path.join(root, "quality-reports/fake-maven-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  const execution = () => JSON.parse(readFileSync(path.join(root, "quality-reports/java-unit/unit-execution.json"), "utf8"));
  return { root, plan, run, calls, execution, write };
}

test("Java 单元包装器依赖准备与真实测试分开选择，保留全部原始XML摘要", (t) => {
  const { plan, run, calls, execution } = fixture(t);
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const commands = calls(); assert.equal(commands.length, 2);
  assert.ok(commands[0].includes("-am") && commands[0].includes("install") && commands[0].includes("-Dmaven.test.skip=true"));
  assert.ok(commands[1].includes("-Pwl-quality-unit") && commands[1].includes("verify") && !commands[1].includes("-am"));
  assert.equal(commands[1][commands[1].indexOf("-pl") + 1], plan.modules.map((m) => m.path).join(","));
  assert.ok(commands.every((x) => x.includes("-o")));
  const evidence = execution(); assert.equal(evidence.status, "completed"); assert.equal(evidence.eventId, "fixture-event"); assert.equal(evidence.sha, "a".repeat(40));
  assert.equal(evidence.reports.length, 2); assert.ok(evidence.reports.every((x) => /^[a-f0-9]{64}$/.test(x.sha256)));
});

test("可显式关闭依赖准备，单元执行仍不使用-am", (t) => {
  const { run, calls } = fixture(t, { prepare: false }); assert.equal(run().status, 0);
  assert.equal(calls().length, 1); assert.ok(!calls()[0].includes("-am") && calls()[0].includes("verify"));
});

test("准备失败之前清理全部旧XML，不能把遗留报告误作单元成功", (t) => {
  const { root, plan, write, run, calls, execution } = fixture(t);
  for (const m of plan.modules) write(m.reportFiles[0], "stale report");
  assert.equal(run({ FAKE_PREP_FAIL: "1" }).status, 2); assert.equal(calls().length, 1);
  assert.ok(plan.modules.every((m) => !existsSync(path.join(root, m.reportFiles[0])))); assert.equal(execution().status, "invalid");
});

for (const [name, env] of [["Maven单元非零", { FAKE_UNIT_FAIL: "1" }], ["缺模块报告", { FAKE_XML_MODE: "missing" }], ["新未登记XML", { FAKE_XML_MODE: "extra" }]]) {
  test(`Java 单元包装器失败关闭：${name}`, (t) => {
    const { run, execution } = fixture(t); assert.equal(run(env).status, 2); assert.equal(execution().status, "invalid");
  });
}

test("路径别名、前导-、越界、嵌套报告及重复模块必须在Maven前拒绝", (t) => {
  for (const change of [
    (p) => { p.modules[0].path = "module-a/./"; },
    (p) => { p.modules[0].path = "-module"; },
    (p) => { p.modules[0].path = "../outside"; },
    (p) => { p.modules[0].reportFiles = ["module-a/target/surefire-reports/nested/TEST-case.xml"]; },
    (p) => { p.modules.push(structuredClone(p.modules[0])); },
  ]) {
    const { plan, run, calls, write } = fixture(t); change(plan); write("quality/java-unit.plan.json", JSON.stringify(plan));
    assert.equal(run().status, 2); assert.equal(calls().length, 0);
  }
});

test("末模块有跟踪XML时跨模块预检零清理，前模块旧XML保持原状", (t) => {
  const { root, plan, write, run, calls } = fixture(t, { controlled: true });
  for (const m of plan.modules) write(m.reportFiles[0], "approved input");
  git(["add", "-f", plan.modules[1].reportFiles[0]], root); git(["commit", "-qm", "track XML"], root);
  assert.equal(run().status, 2); assert.equal(calls().length, 0);
  assert.ok(plan.modules.every((m) => readFileSync(path.join(root, m.reportFiles[0]), "utf8") === "approved input"));
});

test("日志与execution符号链接（含断链）不能写到外部文件", (t) => {
  for (const name of ["unit.log", "unit-execution.json"]) {
    const { root, run, calls } = fixture(t);
    const external = mkdtempSync(path.join(tmpdir(), "wl-gate-java-unit-external-")); t.after(() => rmSync(external, { recursive: true, force: true }));
    const target = path.join(external, "must-not-create.txt");
    mkdirSync(path.join(root, "quality-reports/java-unit"), { recursive: true }); symlinkSync(target, path.join(root, "quality-reports/java-unit", name));
    assert.equal(run().status, 2); assert.equal(calls().length, 0); assert.equal(existsSync(target), false);
  }
});

test("Maven日志按凭据字段/环境秘密脱敏，保留可诊断错误", (t) => {
  const { root, run } = fixture(t);
  const text = "analysis failure Authorization: Bearer abcdef https://user:password@example.invalid token=secret-value";
  const result = run({ FAKE_LOG_TEXT: text, FAKE_LOG_SECRET: "example-private-value", PRIVATE_TOKEN: "example-private-value" });
  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(path.join(root, "quality-reports/java-unit/unit.log"), "utf8");
  assert.match(log, /analysis failure/); assert.doesNotMatch(log, /abcdef|user:password|secret-value|example-private-value/);
});
