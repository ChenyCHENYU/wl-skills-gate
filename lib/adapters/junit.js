import { readFileSync } from "node:fs";
import { parseXml } from "../xml.js";
import { prepareReport } from "../report-input.js";

function caseResult(node) {
  const supported = ["error", "failure", "skipped", "system-out", "system-err", "properties"];
  if (node.children.some((c) => !supported.includes(c.name))) throw new Error("testcase 包含不支持的结果结构");
  for (const child of node.children) validateAuxiliary(child);
  const states = node.children.filter((c) => ["error", "failure", "skipped"].includes(c.name));
  if (states.length > 1) throw new Error("testcase 包含多个结果状态");
  return { name: node.attrs.name || "(unnamed)", classname: node.attrs.classname || "", state: states[0] };
}

function validateAuxiliary(node) {
  if (node.name === "properties") {
    if (node.children.some((c) => c.name !== "property" || c.children.length)) throw new Error("JUnit properties 结构非法");
  } else if (node.children.length) throw new Error(`JUnit ${node.name} 不应包含嵌套标签`);
}

function suiteCases(node) {
  const cases = [];
  for (const child of node.children) {
    if (child.name === "testcase") cases.push(caseResult(child));
    if (["testsuite", "testsuites"].includes(child.name)) cases.push(...suiteCases(child));
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
  return cases;
}

export async function run(check, ctx) {
  try {
    const { file, exitCode } = await prepareReport(check, ctx);
    const root = parseXml(readFileSync(file, "utf8"));
    if (!["testsuite", "testsuites"].includes(root.name)) throw new Error("JUnit 根元素必须是 testsuite/testsuites");
    const cases = suiteCases(root);
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
    if (!cases.length) push("JUNIT/ZERO-TESTS", check.file, "junit:zero-tests", "规定测试数为 0");
    for (const id of check.requiredTests || []) {
      if (!cases.some((c) => `${c.classname}#${c.name}` === id && !c.state)) {
        push("JUNIT/REQUIRED-NOT-PASSED", check.file, `junit:required:${id}`, `必测场景未成功执行: ${id}`);
      }
    }
    if (exitCode !== 0 && !findings.length) throw new Error("测试命令非零退出，但报告没有失败证据");
    return { status: "ok", findings, toolVersion: "junit-xml@1",
      note: `tests=${cases.length} failed=${cases.filter((c) => c.state?.name === "failure").length} errors=${cases.filter((c) => c.state?.name === "error").length} skipped=${cases.filter((c) => c.state?.name === "skipped").length}` };
  } catch (e) { return { status: "invalid", reason: `JUnit 检查失效: ${e.message}` }; }
}
