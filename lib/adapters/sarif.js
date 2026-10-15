import { exists } from "../util.js";
import { findingFingerprint } from "../fingerprint.js";
import { prepareReport } from "../report-input.js";
import { readReportContent } from "../report-selection.js";

const LEVEL = { error: "error", warning: "warning" };

export async function run(check, ctx) {
  if (!check.file) return { status: "invalid", reason: "sarif 检查缺少 file（SARIF 路径）" };
  let input;
  try { input = await prepareReport(check, ctx); } catch (e) { return { status: "invalid", reason: e.message }; }
  const file = input.file;
  if (!exists(file)) return { status: "invalid", reason: `结果文件缺失: ${check.file}（失败关闭）` };
  let data;
  try {
    data = JSON.parse(readReportContent(file, ctx).content);
  } catch (e) {
    return { status: "invalid", reason: `SARIF 文件损坏或无法解析: ${check.file}` };
  }
  if (!Array.isArray(data.runs) || !data.runs.length) {
    return { status: "invalid", reason: `SARIF 缺少 runs 数组: ${check.file}` };
  }
  const findings = [];
  if (data.version !== "2.1.0") return { status: "invalid", reason: "只接受 SARIF 2.1.0 报告" };
  let toolVersion = "unknown";
  for (const run of data.runs) {
    const driver = (run.tool && run.tool.driver) || {};
    if (run === data.runs[0]) toolVersion = `${driver.name || "sarif"}@${driver.version || "?"}`;
    const rules = Array.isArray(driver.rules) ? driver.rules : [];
    if (!Array.isArray(run.results) || run.invocations?.some((i) => i.executionSuccessful === false)) {
      return { status: "invalid", reason: "SARIF 缺少 results 或工具执行失败" };
    }
    const results = run.results;
    for (const r of results) {
      const ruleId =
        typeof r.ruleId === "string" && r.ruleId ? r.ruleId : (rules[r.ruleIndex] && rules[r.ruleIndex].id) || "UNKNOWN-RULE";
      const loc = r.locations && r.locations[0] && r.locations[0].physicalLocation;
      const uri = (loc && loc.artifactLocation && loc.artifactLocation.uri) || "(unknown)";
      const f = {
        ruleId: `SARIF/${ruleId}`,
        severity: LEVEL[r.level || rules[r.ruleIndex]?.defaultConfiguration?.level || "warning"] || "info",
        file: uri,
        line: (loc && loc.region && loc.region.startLine) || null,
        message: (r.message && r.message.text) || "(无消息)",
        dimension: check.dimension || "扫描与门禁",
        autoFixable: false,
        fixCommand: null,
        suggestion: null,
        context: `sarif:${ruleId}:${uri}`,
      };
      f.fingerprint = findingFingerprint(ctx.project, f);
      findings.push(f);
    }
  }
  if (input.exitCode !== 0 && !findings.length) return { status: "invalid", reason: "SARIF 命令非零退出却无失败证据" };
  return { status: "ok", findings, production: input.production, toolVersion };
}
