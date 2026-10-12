import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate } from "../../lib/run.js";
import { loadConfig } from "../../lib/config.js";
import { createReportProducers, prepareSharedReport } from "../../lib/report-producers.js";
import { normalizeNative } from "../../lib/native-input.js";
import { parseFindingsPayload } from "../../lib/finding-input.js";

function fixture(t, command = "node producer.mjs") {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-producers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "quality"));
  mkdirSync(path.join(root, "quality-reports"));
  const checks = ["checkstyle", "pmd", "spotbugs"].map((format) => ({ id: format, tool: "java-xml", format,
    producer: "JAVA-STATIC", command, profiles: ["standard"], file: `quality-reports/${format}.xml` }));
  const policy = { schemaVersion: 1, project: "producer-fixture", enforceWarnings: false, checks };
  writeFileSync(path.join(root, "quality", "policy.json"), JSON.stringify(policy));
  const reports = { checkstyle: '<checkstyle version="10.9.3"/>', pmd: '<pmd version="7.17.0"/>',
    spotbugs: '<BugCollection><FindBugsSummary total_classes="1" total_bugs="0"/></BugCollection>' };
  writeFileSync(path.join(root, "producer.mjs"), `import {existsSync,writeFileSync,readFileSync} from 'node:fs';
const reports=${JSON.stringify(reports)};
if(Object.keys(reports).some(k=>existsSync('quality-reports/'+k+'.xml')))process.exit(10);
let n=0;try{n=Number(readFileSync('quality-reports/count.txt','utf8'));}catch{}
writeFileSync('quality-reports/count.txt',String(n+1));
for(const[k,v]of Object.entries(reports))writeFileSync('quality-reports/'+k+'.xml',v);`);
  return { root, policy, checks, ctx: { root, eventId: "event-one", commitSha: "unknown" } };
}

test("三类 Java 报告本次只生产一次，全部旧文件先清理，下一次运行重新生产", async (t) => {
  const { root } = fixture(t);
  for (const format of ["checkstyle", "pmd", "spotbugs"]) writeFileSync(path.join(root, `quality-reports/${format}.xml`), "STALE");
  for (let count = 1; count <= 2; count++) {
    const result = await runGate({ argv: ["--root", root, "--profile", "standard"] });
    assert.equal(result.exitCode, 0);
    assert.equal(Number(readFileSync(path.join(root, "quality-reports/count.txt"))), count);
    const summary = JSON.parse(readFileSync(path.join(root, "quality-reports/quality-summary.json")));
    assert.deepEqual(summary.checks.map((c) => c.production.reused), [false, true, true]);
    assert.equal(summary.productions.length, 1);
    assert.equal(summary.productions[0].commandRuns, 1);
    assert.equal(summary.productions[0].status, "ok");
    assert.ok(summary.checks.every((c) => c.production.eventId === summary.run.eventId && c.production.reportHash.length === 64));
  }
});

test("共享生产者命令/超时冲突、非 Java 及无命令配置明确拒绝", (t) => {
  const { root, policy } = fixture(t);
  for (const change of [{ command: "node other.mjs" }, { timeoutMs: 2 }, { tool: "raw-json", format: undefined },
    { command: undefined }, { producer: "bad id" }]) {
    const p = structuredClone(policy);
    Object.assign(p.checks[1], change);
    writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(p));
    assert.throws(() => loadConfig(root));
  }
});

test("缺一份新报告仍 invalid，旧报告不会补齐；生产失败不会反复重试", async (t) => {
  const { root, policy } = fixture(t, "node fail.mjs");
  writeFileSync(path.join(root, "fail.mjs"), "import{writeFileSync,readFileSync}from'node:fs';let n=0;try{n=Number(readFileSync('quality-reports/count.txt'));}catch{}writeFileSync('quality-reports/count.txt',String(n+1));writeFileSync('quality-reports/checkstyle.xml','<checkstyle version=\"10.9.3\"/>');");
  writeFileSync(path.join(root, "quality-reports/pmd.xml"), '<pmd version="old"/>');
  assert.equal((await runGate({ argv: ["--root", root] })).exitCode, 2);
  assert.equal(Number(readFileSync(path.join(root, "quality-reports/count.txt"))), 1);
  assert.equal(JSON.parse(readFileSync(path.join(root, "quality-reports/quality-summary.json"))).productions[0].status, "invalid");
  const p = structuredClone(policy);
  for (const c of p.checks) c.command = "node fail.mjs; exit 1";
  writeFileSync(path.join(root, "quality/policy.json"), JSON.stringify(p));
  assert.equal((await runGate({ argv: ["--root", root] })).exitCode, 2);
  assert.equal(Number(readFileSync(path.join(root, "quality-reports/count.txt"))), 2);
});

test("共享报告消费前漂移和重复路径拒绝，不能复用被覆盖的内容", async (t) => {
  const { root, checks, ctx } = fixture(t);
  ctx.reportProducers = createReportProducers(checks, ctx);
  await prepareSharedReport(checks[0], ctx);
  writeFileSync(path.join(root, checks[1].file), '<pmd version="altered"/>');
  await assert.rejects(() => prepareSharedReport(checks[1], ctx), /发生变化/);
  assert.throws(() => createReportProducers([...checks, { ...checks[0], id: "other", producer: undefined }], ctx), /多个消费者/);
});

test("摘要与分页即使保留完整字段，也不得回流为门禁输入", () => {
  const finding = { ruleId: "A", severity: "error", file: "src/A.java", message: "risk" };
  const ctx = { root: "/tmp", project: "p" };
  for (const extra of [{ displayOnly: true }, { response: { truncated: true } }, { page: { nextCursor: "next" } }]) {
    assert.equal(parseFindingsPayload({ findings: [finding], ...extra }, "view", {}, ctx).status, "invalid");
    assert.throws(() => normalizeNative({ schemaVersion: 1, coverage: { status: "complete", scanComplete: true, mode: "full" },
      execution: { checkedFiles: ["src/A.java"] }, issues: [], ...extra }, "wl-bd", ctx), /阅读视图|分页/);
  }
});
