import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseJavaReport, run as javaRun } from "../../lib/adapters/java-xml.js";
import { findingFingerprint } from "../../lib/fingerprint.js";
import { collect } from "../../lib/collect.js";
import { loadConfig } from "../../lib/config.js";
import { runGate } from "../../lib/run.js";

function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-java-triage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  }
  return { root, project: "java-triage", eventId: "synthetic-contract", commitSha: "unknown" };
}
const file = "src/main/java/sample/Domain.java";
const pmd = (rule, extra = "", name = file) => `<pmd version="7.17.0"><file name="${name}"><violation rule="${rule}" ruleset="${extra || "Best Practices"}" beginline="2" priority="2" package="sample" class="Domain" method="apply">native finding</violation></file></pmd>`;
const bug = (type = "EI_EXPOSE_REP2", field = "mutableDTO", extra = "") => `<BugInstance type="${type}" category="MALICIOUS_CODE" priority="2" rank="9"><Class primary="true" classname="sample.Domain"/><Method primary="true" classname="sample.Domain" name="apply" signature="(Ljava/lang/Object;)V"/><Field primary="true" classname="sample.Domain" name="${field}" signature="Ljava/util/List;"/><SourceLine primary="true" classname="sample.Domain" sourcepath="sample/Domain.java" start="2"/><LongMessage>generic shared reference</LongMessage>${extra}</BugInstance>`;
const spot = (...bugs) => `<BugCollection version="4.10.4">${bugs.join("")}<Errors errors="0" missingClasses="0"/><FindBugsSummary total_classes="1" total_bugs="${bugs.length}"/></BugCollection>`;
const context = finding => JSON.parse(finding.context);

test("P3C producer/native rule 保留，PMD引擎版本不冒充P3C版本", t => {
  const ctx = fixture(t, { [file]: "class Domain {}" });
  const finding = parseJavaReport(pmd("NeedBraceRule").replace("7.17.0", "6.55.0"), "p3c", ctx)[0];
  assert.equal(finding.ruleId, "P3C/NeedBraceRule");
  assert.deepEqual(context(finding).primary, { packageName: "sample", className: "Domain", method: { name: "apply", signature: null }, field: null });
  assert.equal(context(finding).producer, "P3C");
  assert.equal(context(finding).engine, "PMD");
  assert.equal(context(finding).engineVersion, "6.55.0");
  assert.equal(context(finding).ruleProvider, "P3C");
  assert.equal(context(finding).ruleProviderVersion, null);
  assert.deepEqual(context(finding).native, { priority: 2, category: "Best Practices", rank: null });
  const checkstyle = parseJavaReport(`<checkstyle version="10.9.3"><file name="${file}"><error source="com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck" severity="error" line="2" message="native style"/></file></checkstyle>`, "checkstyle", ctx)[0];
  assert.equal(context(checkstyle).native.severity, "error");
  assert.equal(checkstyle.severity, "warning");
});

test("同文件/行/generic说明的不同字段指纹独立，class/method/field/signature/priority/rank不丢失", t => {
  const ctx = fixture(t, { [file]: "class Domain {}" });
  const findings = parseJavaReport(spot(bug(undefined, "mutableDTO"), bug(undefined, "injectedService")), "spotbugs", ctx);
  const result = collect({ project: ctx.project, findings });
  assert.equal(result.findings.length, 2);
  assert.notEqual(result.findings[0].fingerprint, result.findings[1].fingerprint);
  const identity = context(findings[0]);
  assert.equal(identity.engineVersion, "4.10.4");
  assert.deepEqual(identity.native, { priority: 2, category: "MALICIOUS_CODE", rank: 9 });
  assert.equal(identity.primary.className, "sample.Domain");
  assert.equal(identity.primary.field.name, "mutableDTO");
  assert.equal(identity.primary.field.signature, "Ljava/util/List;");
  assert.equal(identity.primary.method.signature, "(Ljava/lang/Object;)V");
  const moved = parseJavaReport(spot(bug(undefined, "mutableDTO").replace('start="2"', 'start="20"')), "spotbugs", ctx)[0];
  assert.equal(findingFingerprint(ctx.project, moved), result.findings[0].fingerprint, "行移动不改变相同成员的身份");
});

test("DI类可变DTO和静态表头保留四类context-review，真实安全/正确性底线不降级", t => {
  const ctx = fixture(t, { [file]: "@Service class Domain { List mutableDTO; static String[] headers; }" });
  const findings = parseJavaReport(spot(...["EI_EXPOSE_REP2", "EI_EXPOSE_REP", "MS_EXPOSE_REP", "CT_CONSTRUCTOR_THROW"].map(type => bug(type))), "spotbugs", ctx);
  assert.equal(findings.length, 4);
  assert.ok(findings.every(finding => finding.severity === "warning" && context(finding).risk.classification === "context-review"));
  assert.ok(findings.every(finding => context(finding).risk.reviewRequired === true && finding.suggestion));
  assert.equal(collect({ project: ctx.project, findings }).findings.length, 4);
  for (const type of ["NP_NULL_ON_SOME_PATH", "SQL_INJECTION_JDBC", "OTHER_MALICIOUS_CODE"]) {
    const floor = parseJavaReport(spot(bug(type)), "spotbugs", ctx)[0];
    assert.equal(floor.severity, "error");
    assert.equal(floor.baselineAllowed, false);
  }
});

test("七项PMD底线不能被baseline/waiver或关闭warning隐藏，locale及未知安全规则明确审核", t => {
  const ctx = fixture(t, { [file]: "class Domain {}" });
  const floors = ["CloseResource", "EmptyCatchBlock", "OverrideBothEqualsAndHashcode", "UseEqualsToCompareStrings", "HardCodedCryptoKey", "InsecureCryptoIv", "BrokenNullCheck"].map(rule => parseJavaReport(pmd(rule), "pmd", ctx)[0]);
  const baselineItems = floors.map(finding => ({ fingerprint: findingFingerprint(ctx.project, finding), severity: "error", occurrenceCount: 1 }));
  const waivers = floors.map(finding => ({ id: finding.ruleId, ruleId: finding.ruleId, expiresAt: "2099-01-01" }));
  const result = collect({ project: ctx.project, findings: floors, baselineItems, waivers, enforceWarnings: false });
  assert.equal(result.counts.blockingNew, 7);
  assert.ok(result.findings.every(finding => finding.status === "new" && finding.baselineAllowed === false));
  const locale = parseJavaReport(pmd("UseLocaleWithCaseConversions"), "pmd", ctx)[0];
  assert.equal(locale.severity, "warning");
  assert.equal(context(locale).risk.classification, "explicit-locale");
  assert.match(locale.suggestion, /显式 Locale/);
  const unknown = parseJavaReport(pmd("NewCryptoRisk", "Security"), "pmd", ctx)[0];
  assert.equal(unknown.severity, "warning");
  assert.equal(unknown.baselineAllowed, false);
  assert.equal(context(unknown).risk.classification, "unclassified-security-review");
});

test("SpotBugs显式多模块main/test精确定位，默认单模块main兼容", t => {
  const ctx = fixture(t, { "pl/src/main/java/sample/Domain.java": "class Domain {}", "pl/src/test/java/sample/DomainTest.java": "class DomainTest {}" });
  const check = { sourceRoots: ["pl/src/main/java", "pl/src/test/java"] };
  assert.equal(parseJavaReport(spot(bug()), "spotbugs", ctx, check)[0].file, "pl/src/main/java/sample/Domain.java");
  assert.equal(parseJavaReport(spot(bug().replace("sample/Domain.java", "sample/DomainTest.java")), "spotbugs", ctx, check)[0].file, "pl/src/test/java/sample/DomainTest.java");
  assert.throws(() => parseJavaReport(spot(bug()), "spotbugs", ctx), /不存在/);
  const single = fixture(t, { [file]: "class Domain {}" });
  assert.equal(parseJavaReport(spot(bug()), "spotbugs", single)[0].file, file);
});

test("同名main/test source歧义、原生SourceLine歧义、成员身份歧义和定位不存在均拒绝", t => {
  const ctx = fixture(t, { [file]: "class Domain {}", "src/test/java/sample/Domain.java": "class Domain {}" });
  assert.throws(() => parseJavaReport(spot(bug()), "spotbugs", ctx, { sourceRoots: ["src/main/java", "src/test/java"] }), /歧义/);
  assert.throws(() => parseJavaReport(spot(bug(undefined, undefined, '<SourceLine primary="true" sourcepath="other/Domain.java" start="2"/>')), "spotbugs", ctx), /歧义/);
  assert.throws(() => parseJavaReport(spot(bug(undefined, undefined, '<Field primary="true" name="other" signature="I"/>')), "spotbugs", ctx), /身份歧义/);
  assert.throws(() => parseJavaReport(spot(bug().replace("sample/Domain.java", "sample/Missing.java")), "spotbugs", ctx), /不存在/);
  assert.throws(() => parseJavaReport(pmd("CloseResource", "", "src/missing.java"), "pmd", ctx));
  for (const failure of ["<MissingClass>missing.Dependency</MissingClass>", "<Error>analysis failed</Error>"]) {
    assert.throws(() => parseJavaReport(spot(bug()).replace("</BugCollection>", failure + "</BugCollection>"), "spotbugs", ctx), /分析异常或缺失依赖类/);
  }
});

test("sourceRoots严格限定java-xml，非法目录/相对逃逸/外部符号链接拒绝且生产器不运行", async t => {
  const ctx = fixture(t, { [file]: "class Domain {}", "quality-reports/.keep": "", "producer.mjs": "import{writeFileSync}from'node:fs';writeFileSync('EXECUTED','bad');" });
  const outside = fixture(t, { "sample/Domain.java": "outside sentinel" });
  symlinkSync(outside.root, path.join(ctx.root, "external"), "dir");
  symlinkSync(path.join(outside.root, "sample/Domain.java"), path.join(ctx.root, "src/main/java/sample/External.java"));
  const check = { id: "SB", tool: "java-xml", format: "spotbugs", profiles: ["standard"], file: "quality-reports/sb.xml", command: "node producer.mjs" };
  const policy = value => { mkdirSync(path.join(ctx.root, "quality"), { recursive: true }); writeFileSync(path.join(ctx.root, "quality/policy.json"), JSON.stringify({ schemaVersion: 1, project: ctx.project, checks: [value] })); };
  for (const sourceRoots of [null, [], "src/main/java", [1], ["../outside"], [outside.root], ["C:/outside"], ["missing"], [file], ["external"], ["src/main/java", "src/main/java"]]) {
    policy({ ...check, sourceRoots });
    assert.throws(() => loadConfig(ctx.root));
    assert.equal((await runGate({ argv: ["--root", ctx.root] })).exitCode, 2);
  }
  policy({ ...check, tool: "raw-json", format: undefined, sourceRoots: ["src/main/java"] });
  assert.throws(() => loadConfig(ctx.root), /仅允许 java-xml/);
  assert.throws(() => parseJavaReport(spot(bug().replace("sample/Domain.java", "sample/External.java")), "spotbugs", ctx), /符号链接/);
  assert.equal(readFileSync(path.join(outside.root, "sample/Domain.java"), "utf8"), "outside sentinel");
  assert.throws(() => readFileSync(path.join(ctx.root, "EXECUTED")), /ENOENT/);
});

test("真实Gate执行透传sourceRoots并归档parser版本；XML自报不证明外部引擎核验", async t => {
  const check = { id: "SB", tool: "java-xml", format: "spotbugs", profiles: ["standard"], file: "quality-reports/sb.xml", command: "node producer.mjs", sourceRoots: ["pl/src/main/java"] };
  const ctx = fixture(t, { "pl/src/main/java/sample/Domain.java": "class Domain {}", "quality/policy.json": { schemaVersion: 1, project: "java-triage", enforceWarnings: false, checks: [check] },
    "producer.mjs": `import{writeFileSync}from'node:fs';writeFileSync('quality-reports/sb.xml',${JSON.stringify(spot(bug()))});` });
  const result = await runGate({ argv: ["--root", ctx.root] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.findings[0].file, "pl/src/main/java/sample/Domain.java");
  assert.equal(result.summary.findings[0].severity, "warning");
  assert.equal(result.summary.checks[0].parserMetadata.parser, "java-xml-v2");
  assert.equal(result.summary.checks[0].parserMetadata.engineVersion, "4.10.4");
  assert.equal(result.summary.checks[0].parserMetadata.reportedVersionVerified, false);
  assert.equal(result.summary.checks[0].toolVersionVerified, false);
  assert.equal(result.summary.checks[0].toolVersion, "unknown");
  assert.deepEqual(result.summary.checks[0].parserMetadata.sourceRoots, check.sourceRoots);
  const p3c = fixture(t, { [file]: "class Domain {}", "p3c.xml": pmd("NeedBraceRule").replace("7.17.0", "6.55.0") });
  assert.equal((await javaRun({ format: "p3c", file: "p3c.xml" }, p3c)).findings[0].ruleId, "P3C/NeedBraceRule");
});
