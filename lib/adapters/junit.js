import { parseXml } from "../xml.js";
import { prepareReport } from "../report-input.js";
import { reportPaths, readReportContent } from "../report-selection.js";
import { safePath } from "../source-state.js";

export const JUNIT_PARSER_VERSION = "junit-xml@2";

function caseResult(node) {
  const supported = ["error", "failure", "skipped", "system-out", "system-err", "properties"];
  if (node.children.some((c) => !supported.includes(c.name))) throw new Error("testcase 包含不支持的结果结构");
  for (const child of node.children) validateAuxiliary(child);
  const states = node.children.filter((c) => ["error", "failure", "skipped"].includes(c.name));
  if (states.length > 1) throw new Error("testcase 包含多个结果状态");
  if (typeof node.attrs.name !== "string" || !node.attrs.name.trim()) throw new Error("JUnit testcase 缺少可核验的 name");
  return { name: node.attrs.name, classname: node.attrs.classname || "", state: states[0] };
}

function validateAuxiliary(node) {
  if (node.name === "properties") {
    if (node.children.some((c) => c.name !== "property" || c.children.length)) throw new Error("JUnit properties 结构非法");
  } else if (node.children.length) throw new Error(`JUnit ${node.name} 不应包含嵌套标签`);
}

function suiteCases(node, suites) {
  const cases = [];
  for (const child of node.children) {
    if (child.name === "testcase") cases.push(caseResult(child));
    if (["testsuite", "testsuites"].includes(child.name)) cases.push(...suiteCases(child, suites));
    else if (child.name !== "testcase") {
      if (!["properties", "system-out", "system-err"].includes(child.name)) throw new Error("JUnit 套件含不支持的结构");
      validateAuxiliary(child);
    }
  }
  const actual = {
    tests: cases.length,
    failures: cases.filter((c) => c.state?.name === "failure").length,
    errors: cases.filter((c) => c.state?.name === "error").length,
    skipped: cases.filter((c) => c.state?.name === "skipped").length,
  };
  for (const [key, count] of Object.entries(actual)) {
    if (node.attrs[key] === undefined) continue;
    if (!/^\d+$/.test(node.attrs[key]) || Number(node.attrs[key]) !== count) {
      throw new Error(`JUnit ${key} 声明数 ${node.attrs[key]} 与实际 ${count} 不一致`);
    }
  }
  if (node.name === "testsuite") suites.push({ name: node.attrs.name || null, ...actual,
    passed: actual.tests - actual.failures - actual.errors - actual.skipped });
  return cases;
}

function parseDocument(file, relative, ctx) {
  const { content, sha256 } = readReportContent(file, ctx);
  ctx.junitParsedReports ||= new Map();
  const cached = ctx.junitParsedReports.get(relative);
  if (cached?.sha256 === sha256) return cached;
  const root = parseXml(content);
  if (!["testsuite", "testsuites"].includes(root.name)) throw new Error("JUnit 根元素必须是 testsuite/testsuites");
  const suites = [];
  const cases = suiteCases(root, suites).map((c) => ({ ...c, reportFile: relative }));
  const result = { cases, suites, sha256 };
  ctx.junitParsedReports.set(relative, result);
  return result;
}

function countCases(cases) {
  return { tests: cases.length, passed: cases.filter((c) => !c.state).length,
    failures: cases.filter((c) => c.state?.name === "failure").length,
    errors: cases.filter((c) => c.state?.name === "error").length,
    skipped: cases.filter((c) => c.state?.name === "skipped").length };
}

function assertUniqueCases(cases) {
  const seen = new Set();
  for (const c of cases) {
    const id = `${c.classname}#${c.name}`;
    if (seen.has(id)) throw new Error(`JUnit testcase 身份重复，参数化用例须保留完整参数名称: ${id}`);
    seen.add(id);
  }
}

export async function run(check, ctx) {
  try {
    const { files, exitCode, production } = await prepareReport(check, ctx);
    const paths = reportPaths(check);
    const documents = files.map((file, i) => ({ file: paths[i], ...parseDocument(file, paths[i], ctx) }));
    const cases = documents.flatMap((d) => d.cases);
    assertUniqueCases(cases);
    const findings = [];
    const push = (ruleId, file, context, message) => findings.push({
      ruleId, severity: "error", file, line: null, context, message,
      dimension: check.dimension || "测试规范", autoFixable: false, fixCommand: null, baselineAllowed: false,
    });
    for (const c of cases) {
      if (!c.state) continue;
      const ids = { error: "JUNIT/ERROR", failure: "JUNIT/FAILED", skipped: "JUNIT/SKIPPED" };
      push(ids[c.state.name], c.classname || "(junit)", `junit:${c.classname}#${c.name}`,
        `${c.name}: ${c.state.attrs.message || c.state.text.trim() || c.state.name}`);
    }
    for (const document of documents) {
      if (!document.cases.length) push("JUNIT/ZERO-TESTS", document.file, `junit:zero-tests:${document.file}`, "规定原始测试报告的测试数为 0");
      for (const suite of document.suites.filter((s) => !s.tests)) {
        push("JUNIT/ZERO-SUITE", document.file, `junit:zero-suite:${suite.name || "(unnamed)"}`, "JUnit 套件没有实际执行用例");
      }
    }
    for (const id of check.requiredTests || []) {
      if (!cases.some((c) => `${c.classname}#${c.name}` === id && !c.state)) {
        push("JUNIT/REQUIRED-NOT-PASSED", paths[0], `junit:required:${id}`, `必测场景未成功执行: ${id}`);
      }
    }
    const allSuites = documents.flatMap((d) => d.suites);
    for (const name of check.requiredSuites || []) {
      if (!allSuites.some((s) => s.name === name && s.tests > 0 && s.passed === s.tests)) {
        push("JUNIT/REQUIRED-SUITE-NOT-PASSED", paths[0], `junit:required-suite:${name}`, `必测套件未完整成功执行: ${name}`);
      }
    }
    const group = check.producer ? ctx.reportProducers?.get(check.producer) : null;
    const groupCases = group?.checks.length > 1 ? group.checks.flatMap((c) => reportPaths(c).flatMap((p) => parseDocument(safePath(ctx.root, p), p, ctx).cases)) : cases;
    assertUniqueCases(groupCases);
    if (exitCode !== 0) {
      // A shared test command may fail in another approved module. Read its
      // actual XML too; skipped/missing/zero tests are not compiler-failure proof.
      if (!groupCases.some((c) => ["failure", "error"].includes(c.state?.name))) {
        throw new Error("测试命令非零退出，但原始报告没有实际 failure/error 证据；skipped/缺必测不能掩盖生产失败");
      }
    }
    const counts = countCases(cases);
    return { status: "ok", findings, toolVersion: JUNIT_PARSER_VERSION, production,
      testEvidence: { parser: JUNIT_PARSER_VERSION, complete: true, reportDirs: check.reportDirs || [],
        files: documents.map((d) => ({ file: d.file, sha256: d.sha256, counts: countCases(d.cases), suites: d.suites })),
        counts, requiredTests: (check.requiredTests || []).map((id) => {
          const c = cases.find((item) => `${item.classname}#${item.name}` === id);
          return { id, passed: !!c && !c.state, reportFile: c?.reportFile || null };
        }), requiredSuites: (check.requiredSuites || []).map((name) => ({ name,
          passed: allSuites.some((s) => s.name === name && s.tests > 0 && s.passed === s.tests) })) },
      note: `reports=${files.length} tests=${counts.tests} failed=${counts.failures} errors=${counts.errors} skipped=${counts.skipped}` };
  } catch (e) { return { status: "invalid", reason: `JUnit 检查失效: ${e.message}` }; }
}
