import path from "node:path";
import { realpathSync } from "node:fs";

// 只转换已知报告契约，保留上游风险等级；缺失/裁剪证据不猜测通过。
const LEVELS = { blocker: "blocker", error: "error", warn: "warning", warning: "warning", info: "info", suggestion: "info", review: "warning" };
const BD_FLOOR = new Set(["B1", "B4", "B5", "B7", "B13", "B14", "B15", "B17", "B18", "B20", "B24", "B25", "B26", "B27", "B28", "B30", "B31"]);

export function projectFile(file, root) {
  if (typeof file !== "string" || !file.trim()) throw new Error("问题缺少文件定位");
  const physical = (value) => {
    try { return realpathSync(value); } catch { return path.resolve(value); }
  };
  const relative = path.isAbsolute(file) ? path.relative(physical(root), physical(file)) : file;
  if (!relative || relative.split(/[\\/]/).includes("..")) throw new Error("问题定位越出项目");
  return relative.replace(/\\/g, "/");
}

export function normalizeNative(input, format, ctx) {
  if (input?.displayOnly === true || input?.response?.truncated === true || input?.page?.nextCursor != null) throw new Error("阅读视图或未完整分页结果不能作为原生完整门禁输入");
  if (!input || !Array.isArray(input.issues)) throw new Error(`${format} 缺少 issues 数组`);
  if (format === "wl-bd") {
    if (input.schemaVersion !== 1 || input.coverage?.status !== "complete" || input.coverage?.scanComplete !== true
      || input.coverage?.mode !== "full" || !Array.isArray(input.execution?.checkedFiles) || !input.execution.checkedFiles.length) {
      throw new Error("BD 扫描不完整或缺少 coverage 证据");
    }
  } else {
    if (!["completed", "failed"].includes(input.executionStatus) || !["passed", "failed"].includes(input.validationStatus)) {
      throw new Error(`${format} 缺少实际执行回执或检查未验证`);
    }
    if (format === "wl-kit" && (!Array.isArray(input.summary?.checkedFiles) || !input.summary.checkedFiles.length || input.summary.astAvailable !== true)) {
      throw new Error("Kit 空扫或 AST 校验未完成");
    }
    if (format === "wl-ui" && (!Number.isInteger(input.summary?.fileCount) || input.summary.fileCount < 1)) throw new Error("UI 缺少实际扫描文件证据");
  }
  const prefix = { "wl-kit": "KIT", "wl-ui": "UI", "wl-bd": "BD" }[format];
  if (!prefix) throw new Error("未知原生报告类型");
  // 上游行内/文件豁免不能让 Gate 明确底线从报告消失。
  const restored = format === "wl-bd" && Array.isArray(input.suppressed)
    ? input.suppressed.filter((issue) => issue.severity === "error" && (BD_FLOOR.has(issue.rule) || issue.rule === "B32")) : [];
  const findings = [...input.issues, ...restored].map((issue) => {
    const rule = issue.rule || (format === "wl-kit" ? "UNCLASSIFIED" : null);
    const severity = LEVELS[issue.severity || issue.level];
    const message = issue.message || issue.description || issue.text;
    if (!rule || !severity || typeof message !== "string" || !message.trim()) throw new Error("原生问题缺少规则、等级或描述");
    const floor = severity === "error" && ((format === "wl-bd" && (BD_FLOOR.has(rule) || rule === "B32")) || rule === "SFC_PARSE");
    return { ruleId: `${prefix}/${rule}`, severity, message, file: projectFile(issue.file || issue.dir, ctx.root),
      line: issue.line ?? null, baselineAllowed: !floor, autoFixable: false,
      suggestion: issue.suggestion || null, context: issue.context || null };
  });
  if (format === "wl-ui") {
    for (const check of input.integration || []) {
      if (check.ok === true) continue;
      if (check.ok !== false || !check.id || !LEVELS[check.severity] || !check.description) throw new Error("UI 接入检查结构缺失");
      findings.push({ ruleId: `UI/INTEGRATION/${check.id}`, severity: LEVELS[check.severity],
        file: "package.json", message: check.description, baselineAllowed: false });
    }
  }
  if ((input.validationStatus === "failed" || input.ok === false) && !findings.length) throw new Error("上游失败却无问题证据");
  return { data: { findings, toolVersion: input.toolVersion || "unknown" }, note: `${format} 原生报告转换；完整扫描，保留风险等级，恢复底线豁免=${restored.length}，未经修复` };
}
