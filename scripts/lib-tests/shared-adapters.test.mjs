import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeNative, projectFile } from "../../lib/native-input.js";
import { parseJavaReport, run as javaRun } from "../../lib/adapters/java-xml.js";
import { run as cmdRun } from "../../lib/adapters/cmd-json.js";
import { runGate } from "../../lib/run.js";
import { loadConfig } from "../../lib/config.js";
import { immutableFailure } from "../../lib/risk.js";

function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-shared-adapters-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return { root, project: "shared-adapters", eventId: "test", commitSha: "unknown" };
}
const bd = { schemaVersion: 1, coverage: { status: "complete", scanComplete: true, mode: "full" },
  execution: { checkedFiles: ["src/main/java/demo/ResultVO.java"] }, issues: [] };
const pmd = (rule) => `<pmd version="7.17.0"><file name="src/main/java/demo/Sample.java"><violation rule="${rule}" beginline="7">problem</violation></file></pmd>`;

test("BD 返回模型警告、请求错误及权限底线在转换后保持等级", () => {
  const ctx = { root: "/tmp", project: "p" };
  const converted = normalizeNative({ ...bd, issues: [
    { rule: "B32", severity: "warn", file: "src/ResultVO.java", message: "confirm consumer" },
    { rule: "B32", severity: "error", file: "src/RequestDTO.java", message: "missing creator" },
    { rule: "B1", severity: "error", file: "src/Controller.java", message: "missing auth" },
    { rule: "B10", severity: "error", file: "src/Service.java", message: "legacy length" },
  ] }, "wl-bd", ctx).data.findings;
  assert.deepEqual(converted.map((f) => f.severity), ["warning", "error", "error", "error"]);
  assert.deepEqual(converted.map(immutableFailure), [false, true, true, true]);
  const suppressed = normalizeNative({ ...bd, suppressed: [
    { rule: "B1", severity: "error", file: "src/Controller.java", message: "upstream waived auth", suppressionReason: "legacy" },
  ] }, "wl-bd", ctx).data.findings;
  assert.equal(suppressed.length, 1);
  assert.equal(immutableFailure(suppressed[0]), true);
});

test("原生报告缺覆盖、partial、空扫、未知等级或逃逸路径均拒绝", () => {
  for (const input of [{ issues: [] }, { ...bd, coverage: { ...bd.coverage, status: "partial" } },
    { ...bd, execution: { checkedFiles: [] } },
    { ...bd, issues: [{ rule: "B1", severity: "maybe", file: "src/C.java", message: "bad" }] },
    { ...bd, issues: [{ rule: "B1", severity: "error", file: "../C.java", message: "bad" }] }]) {
    assert.throws(() => normalizeNative(input, "wl-bd", { root: "/tmp" }));
  }
  assert.throws(() => normalizeNative({ issues: [], executionStatus: "completed", validationStatus: "passed",
    summary: { checkedFiles: ["src/index.vue"], astAvailable: false } }, "wl-kit", { root: "/tmp" }));
});

test("Kit/UI 结构转换及接入错误保留；failed 空报告失效", () => {
  const ctx = { root: "/tmp" };
  const evidence = { executionStatus: "completed", validationStatus: "passed" };
  const kit = normalizeNative({ ...evidence, summary: { checkedFiles: ["src/index.vue"], astAvailable: true },
    issues: [{ rule: "PAGE", level: "warn", dir: "src/index.vue", text: "review layout" }] }, "wl-kit", ctx);
  assert.equal(kit.data.findings[0].severity, "warning");
  const ui = normalizeNative({ ...evidence, summary: { fileCount: 1 },
    issues: [{ rule: "R001", severity: "review", file: "src/index.vue", description: "review color" }],
    integration: [{ id: "dependency", ok: false, severity: "error", description: "missing component" }] }, "wl-ui", ctx);
  assert.equal(ui.data.findings.length, 2);
  assert.equal(ui.data.findings[1].baselineAllowed, false);
  assert.throws(() => normalizeNative({ ...evidence, validationStatus: "failed", summary: { fileCount: 1 }, issues: [] }, "wl-ui", ctx));
});

test("原生大报告通过文件描述符完整接收，支持退出 1 的真实问题", async (t) => {
  const ctx = fixture(t, { "scan.mjs": `process.stdout.write(JSON.stringify(${JSON.stringify({ ...bd,
    issues: [{ rule: "B9", severity: "warn", file: "src/C.java", message: "x".repeat(180000) }] })}));process.exit(1);` });
  const result = await cmdRun({ command: "node scan.mjs", file: "quality-reports/native.json", captureStdout: true,
    format: "wl-bd", okExitCodes: [0, 1] }, ctx);
  assert.equal(result.status, "ok", result.reason);
  assert.equal(result.findings[0].message.length, 180000);
  assert.equal(result.findings[0].severity, "warning");
  assert.equal((await cmdRun({ command: "node scan.mjs", format: "wl-bd" }, { ...ctx, scope: "staged" })).status, "invalid");
});

test("Java 风格/复杂度预警，资源泄漏等确定缺陷保持不可基线阻断", (t) => {
  const ctx = fixture(t, { "src/main/java/demo/Sample.java": "class Sample {}", "src/A.java": "class A {}" });
  const complexity = parseJavaReport(pmd("CyclomaticComplexity"), "pmd", ctx)[0];
  const leak = parseJavaReport(pmd("CloseResource"), "pmd", ctx)[0];
  assert.equal(complexity.severity, "warning");
  assert.equal(leak.severity, "error");
  assert.equal(immutableFailure(leak), true);
  const style = parseJavaReport('<checkstyle version="9.3"><file name="src/A.java"><error line="3" severity="error" source="com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck" message="too long"/></file></checkstyle>', "checkstyle", ctx);
  assert.equal(style[0].severity, "warning");
  assert.deepEqual(parseJavaReport('<checkstyle version="9.3"/>', "checkstyle", ctx), [], "报告目标可能不列出无违规文件");
});

test("Java 原始报告物理绝对路径与项目路径别名可正确定位", (t) => {
  const ctx = fixture(t, { "src/A.java": "class A {}" });
  const physicalFile = path.join(realpathSync(ctx.root), "src/A.java");
  assert.equal(projectFile(physicalFile, ctx.root), "src/A.java");
  const report = `<pmd><file name="${physicalFile}"><violation rule="CloseResource" beginline="1">leak</violation></file></pmd>`;
  assert.equal(parseJavaReport(report, "pmd", ctx)[0].file, "src/A.java");
});

test("SpotBugs 根据类别及置信度分级，低置信度仍出现在报告", (t) => {
  const ctx = fixture(t, { "src/main/java/demo/A.java": "class A {}" });
  const xml = (priority) => `<BugCollection><BugInstance type="NP_NULL_ON_SOME_PATH" category="CORRECTNESS" priority="${priority}"><SourceLine sourcepath="demo/A.java" start="12" primary="true"/><LongMessage>Null path</LongMessage></BugInstance><Errors errors="0" missingClasses="0"/><FindBugsSummary total_classes="1" total_bugs="1"/></BugCollection>`;
  assert.equal(parseJavaReport(xml(2), "spotbugs", ctx)[0].severity, "error");
  assert.equal(parseJavaReport(xml(3), "spotbugs", ctx)[0].severity, "warning");
});

test("Java 缺文件、损坏 XML、分析失败和依赖缺类全部失败关闭", async (t) => {
  const ctx = fixture(t);
  const result = await javaRun({ file: "missing.xml", format: "pmd" }, ctx);
  assert.equal(result.status, "invalid");
  for (const [format, xml] of [
    ["pmd", "<pmd><file>"], ["pmd", '<pmd><error filename="A.java" msg="parse failed"/></pmd>'],
    ["checkstyle", '<checkstyle><file name="A.java"><error severity="error" source="com.puppycrawl.tools.checkstyle.api.CheckstyleException" message="parse failed"/></file></checkstyle>'],
    ["spotbugs", '<BugCollection><Errors errors="0" missingClasses="1"/></BugCollection>'],
    ["spotbugs", '<BugCollection><Errors errors="0"/><FindBugsSummary total_classes="0" total_bugs="0"/></BugCollection>'],
    ["checkstyle", "<checkstyle/>"],
  ]) assert.throws(() => parseJavaReport(xml, format, ctx));
});

test("Maven 生产异常不能被已有 XML 告警掩盖；旧报告不能冒充本轮结果", async (t) => {
  const ctx = fixture(t, { "stale.xml": pmd("CloseResource"),
    "fail.mjs": `import {writeFileSync} from 'node:fs';writeFileSync('report.xml',${JSON.stringify(pmd("CloseResource"))});process.exit(1);` });
  assert.equal((await javaRun({ command: "node fail.mjs", file: "report.xml", format: "pmd" }, ctx)).status, "invalid");
  assert.equal((await javaRun({ command: "node -e \"process.exit(0)\"", file: "stale.xml", format: "pmd" }, ctx)).status, "invalid");
});

test("报告生产失败保留脱敏后的真实诊断，不向报告泄露口令", async (t) => {
  const ctx = fixture(t, { "fail.mjs": "console.error('broken-parent-POM password=fixture-secret');process.exit(1);" });
  const java = await javaRun({ command: "node fail.mjs", file: "report.xml", format: "pmd" }, ctx);
  const native = await cmdRun({ command: "node fail.mjs" }, ctx);
  for (const result of [java, native]) {
    assert.equal(result.status, "invalid");
    assert.match(result.reason, /broken-parent-POM/);
    assert(!result.reason.includes("fixture-secret"));
  }
});

test("Gate 完整决策：预警可通过、确定缺陷阻断、报告失效 invalid", async (t) => {
  const check = { id: "PMD", tool: "java-xml", format: "pmd", profiles: ["standard"], file: "quality-reports/pmd.xml", command: "node report.mjs" };
  const ctx = fixture(t, { "quality/policy.json": { schemaVersion: 1, project: "fixture", enforceWarnings: false, checks: [check] },
    "src/main/java/demo/Sample.java": "class Sample {}",
    "report.mjs": `import{writeFileSync}from'node:fs';writeFileSync('quality-reports/pmd.xml',${JSON.stringify(pmd("CyclomaticComplexity"))});` });
  assert.equal((await runGate({ argv: ["--root", ctx.root] })).exitCode, 0);
  writeFileSync(path.join(ctx.root, "report.mjs"), `import{writeFileSync}from'node:fs';writeFileSync('quality-reports/pmd.xml',${JSON.stringify(pmd("CloseResource"))});`);
  assert.equal((await runGate({ argv: ["--root", ctx.root] })).exitCode, 1);
  writeFileSync(path.join(ctx.root, "report.mjs"), "process.exit(0);");
  assert.equal((await runGate({ argv: ["--root", ctx.root] })).exitCode, 2);
});

test("未知格式或 captureStdout 配置错误不能静默生效", (t) => {
  for (const check of [
    { tool: "java-xml", file: "a.xml", format: "guess" },
    { tool: "cmd-json", format: "whatever" }, { tool: "cmd-json", captureStdout: true },
  ]) {
    const ctx = fixture(t, { "quality/policy.json": { schemaVersion: 1, project: "fixture", checks: [{ id: "A", profiles: ["standard"], ...check }] } });
    assert.throws(() => loadConfig(ctx.root));
  }
});
