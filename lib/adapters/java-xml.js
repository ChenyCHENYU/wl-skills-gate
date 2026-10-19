import { statSync } from "node:fs";
import { parseXml } from "../xml.js";
import { prepareReport } from "../report-input.js";
import { parseFindingsPayload } from "../finding-input.js";
import { projectFile } from "../native-input.js";
import { safePath } from "../source-state.js";
import { classifyJavaRisk, JAVA_RISK_POLICY_VERSION } from "../java-risk-policy.js";
import { spotbugsSourceFile, validateJavaSourceRoots } from "../java-source-map.js";
import { readReportContent } from "../report-selection.js";

export const JAVA_XML_PARSER_VERSION = "java-xml-v2";
function nodes(node, name) {
  return [...(node.name === name ? [node] : []), ...node.children.flatMap((child) => nodes(child, name))];
}
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Java 报告缺少 ${label}`);
  return value;
}
function line(value) {
  if (value == null || value === "" || value === "0" || value === "-1") return null;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error("Java 报告行号非法");
  return Number(value);
}

function sourceFile(file, root) {
  const relative = projectFile(file, root);
  if (!statSync(safePath(root, relative)).isFile()) throw new Error(`Java 源定位不是普通文件: ${relative}`);
  return relative;
}
function priority(value, max, engine) {
  if (value == null) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${engine} priority 非法`);
  return Number(value);
}
function primaryAnnotation(bug, name) {
  const candidates = bug.children.filter(node => node.name === name);
  const marked = candidates.filter(node => node.attrs.primary === "true");
  const selected = marked.length ? marked : candidates;
  if (selected.length > 1) throw new Error(`SpotBugs primary ${name} 身份歧义`);
  return selected[0] || null;
}
function memberIdentity(node) {
  return node ? { className: node.attrs.classname || null, name: node.attrs.name || null,
    signature: node.attrs.signature || null, isStatic: node.attrs.isStatic || null } : null;
}
function sourceAnnotation(bug, primary) {
  const direct = bug.children.filter(node => node.name === "SourceLine" && node.attrs.sourcepath);
  const all = nodes(bug, "SourceLine").filter(node => node.attrs.sourcepath);
  const candidates = [direct.filter(node => node.attrs.primary === "true"), direct,
    ...[primary.field, primary.method, primary.class].map(node => node ? nodes(node, "SourceLine").filter(item => item.attrs.sourcepath) : []),
    all.filter(node => node.attrs.primary === "true"), all].find(list => list.length) || [];
  const identities = new Set(candidates.map(node => JSON.stringify([node.attrs.sourcepath, node.attrs.start || null, node.attrs.classname || null])));
  if (identities.size !== 1) throw new Error("SpotBugs 主源定位缺失或歧义，不能任取第一个 SourceLine");
  return candidates[0];
}

function parseJavaDocument(xml, format, ctx, check) {
  const root = parseXml(xml);
  if (check.sourceRoots !== undefined) validateJavaSourceRoots(ctx.root, check.sourceRoots);
  const findings = [];
  // XML versions are reported evidence only; the separate versionCommand establishes external tool verification.
  const provenance = { producer: format.toUpperCase(), engine: format === "p3c" ? "PMD" : format.toUpperCase(),
    engineVersion: root.attrs.version || null, ruleProvider: format === "p3c" ? "P3C" : null,
    ruleProviderVersion: format === "p3c" ? root.attrs.p3cVersion || null : null };
  const push = (rule, file, at, message, native = {}, primary = null) => {
    const risk = classifyJavaRisk({ format, rule, category: native.category, priority: native.priority });
    const {endLine,...nativeEvidence}=native;
    findings.push({ ruleId: `${format.toUpperCase()}/${rule}`, file: sourceFile(file, ctx.root), line: line(at),
      endLine:line(at)===null ? null : native.endLine || null,
      message: required(message, "问题说明"), severity: risk.severity, baselineAllowed: risk.baselineAllowed,
      suggestion: risk.reason, context: JSON.stringify({ ...provenance, nativeRule: rule, native:nativeEvidence, primary,
        risk: { ...risk, policyVersion: JAVA_RISK_POLICY_VERSION } }) });
  };
  if (format === "checkstyle") {
    if (root.name !== "checkstyle" || !root.attrs.version || root.children.some((node) => node.name !== "file")) throw new Error("Checkstyle 版本、根元素或文件结构非法");
    for (const file of root.children) {
      required(file.attrs.name, "Checkstyle 文件名");
      for (const error of file.children) {
        if (error.name !== "error" || !["error", "warning", "info", "ignore"].includes(error.attrs.severity)) throw new Error("Checkstyle 结果结构非法");
        const source = required(error.attrs.source, "Checkstyle source");
        if (!source.startsWith("com.puppycrawl.tools.checkstyle.checks.")) throw new Error("Checkstyle 解析/运行错误不能作为风格提示");
        push(source, file.attrs.name, error.attrs.line, error.attrs.message, { severity: error.attrs.severity,
          priority: null, category: null, rank: null });
      }
    }
  } else if (format === "pmd" || format === "p3c") {
    if (root.name !== "pmd" || root.children.some((node) => node.name !== "file")) throw new Error("PMD 分析错误、配置错误或结构不受支持");
    for (const file of root.children) {
      required(file.attrs.name, "PMD 文件名");
      for (const violation of file.children) {
        if (violation.name !== "violation") throw new Error("PMD 文件结果结构非法");
        const rule = required(violation.attrs.rule, "PMD rule");
        push(rule, file.attrs.name, violation.attrs.beginline, violation.text.trim(), {
          priority: priority(violation.attrs.priority, 5, provenance.engine), category: violation.attrs.ruleset || null, rank: null,
          endLine:line(violation.attrs.endline),
        }, { packageName: violation.attrs.package || null, className: violation.attrs.class || null,
          method: violation.attrs.method ? { name: violation.attrs.method, signature: violation.attrs.signature || null } : null,
          field: violation.attrs.variable || violation.attrs.field ? { name: violation.attrs.variable || violation.attrs.field,
            signature: violation.attrs.signature || null } : null });
      }
    }
  } else if (format === "spotbugs") {
    if (root.name !== "BugCollection") throw new Error("SpotBugs 根元素非法");
    if (nodes(root, "MissingClass").length || nodes(root, "Error").length) throw new Error("SpotBugs 存在分析异常或缺失依赖类");
    const summary = nodes(root, "FindBugsSummary");
    const bugs = nodes(root, "BugInstance");
    if (summary.length !== 1 || !/^\d+$/.test(summary[0].attrs.total_classes || "") || Number(summary[0].attrs.total_classes) < 1
      || !/^\d+$/.test(summary[0].attrs.total_bugs || "") || Number(summary[0].attrs.total_bugs) !== bugs.length) {
      throw new Error("SpotBugs 空扫或汇总与实际缺陷不一致");
    }
    for (const errors of nodes(root, "Errors")) {
      if (errors.children.length || !/^0$/.test(errors.attrs.errors || "0") || !/^0$/.test(errors.attrs.missingClasses || "0")) {
        throw new Error("SpotBugs 存在分析异常或缺失依赖类");
      }
    }
    for (const bug of bugs) {
      const rule = required(bug.attrs.type, "SpotBugs type");
      const category = required(bug.attrs.category, "SpotBugs category");
      if (!/^[123]$/.test(bug.attrs.priority || "")) throw new Error("SpotBugs priority 非法");
      const primary = { class: primaryAnnotation(bug, "Class"), method: primaryAnnotation(bug, "Method"),
        field: primaryAnnotation(bug, "Field") };
      const source = sourceAnnotation(bug, primary);
      required(source?.attrs.sourcepath, "SpotBugs sourcepath");
      const sourcePath = spotbugsSourceFile(source.attrs.sourcepath, ctx.root, check.sourceRoots);
      const description = nodes(bug, "LongMessage")[0]?.text.trim() || nodes(bug, "ShortMessage")[0]?.text.trim();
      if (bug.attrs.rank !== undefined && (!/^\d+$/.test(bug.attrs.rank) || Number(bug.attrs.rank) < 1)) throw new Error("SpotBugs rank 非法");
      push(rule, sourcePath, source.attrs.start, description || rule, { priority: Number(bug.attrs.priority), category,
        endLine:line(source.attrs.end),
        rank: bug.attrs.rank === undefined ? null : Number(bug.attrs.rank) }, {
        className: primary.class?.attrs.classname || source.attrs.classname || null,
        method: memberIdentity(primary.method), field: memberIdentity(primary.field) });
    }
  } else throw new Error("未知 Java XML 类型");
  return { findings, parserMetadata: { parser: JAVA_XML_PARSER_VERSION, policyVersion: JAVA_RISK_POLICY_VERSION,
    ...provenance, reportedVersionVerified: false, sourceRoots: check.sourceRoots || (format === "spotbugs" ? ["src/main/java"] : null) } };
}

export function parseJavaReport(xml, format, ctx, check = {}) {
  return parseJavaDocument(xml, format, ctx, check).findings;
}

export async function run(check, ctx) {
  try {
    const { file, exitCode, diagnostic, production } = await prepareReport(check, ctx);
    // 静态报告生产目标应成功退出。编译/分析器失效不得用已有 findings 掩盖。
    if (exitCode !== 0) throw new Error(`Java 报告生产失败（exit=${exitCode}）${diagnostic ? `: ${diagnostic}` : ""}，不可用告警代替运行成功`);
    const { findings, parserMetadata } = parseJavaDocument(readReportContent(file, ctx).content, check.format, ctx, check);
    return { ...parseFindingsPayload({ findings }, check.file, check, ctx), production, parserMetadata,
      note: "Java 静态报告：确定缺陷阻断；风格/复杂度及低置信度风险提示；未执行业务测试" };
  } catch (e) { return { status: "invalid", reason: `Java 静态检查失效: ${e.message}` }; }
}
