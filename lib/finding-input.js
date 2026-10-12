import { findingFingerprint } from "./fingerprint.js";

const SEVERITIES = new Set(["blocker", "error", "warning", "info"]);

export function parseFindingsPayload(data, source, check, ctx) {
  if (data?.displayOnly === true || data?.response?.truncated === true || data?.page?.nextCursor != null) return { status: "invalid", reason: `${source} 是阅读视图或未完整分页的结果，不能作为完整门禁输入` };
  const list = Array.isArray(data) ? data : Array.isArray(data?.findings) ? data.findings : null;
  if (!list) return { status: "invalid", reason: `结果结构错误: ${source} 需为 findings 数组或 {findings:[]}` };
  const findings = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i] || {};
    const missing = ["ruleId", "severity", "file", "message"].filter(
      (k) => raw[k] === undefined || raw[k] === null || raw[k] === ""
    );
    if (missing.length) return { status: "invalid", reason: `${source} findings[${i}] 缺少必填字段: ${missing.join(",")}` };
    if (!SEVERITIES.has(raw.severity)) return { status: "invalid", reason: `${source} findings[${i}] severity 非法: ${raw.severity}` };
    const f = {
      ruleId: String(raw.ruleId),
      severity: raw.severity,
      file: String(raw.file),
      line: raw.line == null ? null : Number(raw.line),
      message: String(raw.message),
      dimension: raw.dimension || check.dimension || "未分类",
      autoFixable: !!raw.autoFixable,
      fixCommand: null,
      fixerId: raw.fixerId || null,
      baselineAllowed: check.baselineAllowed !== false && raw.baselineAllowed !== false,
      suggestion: raw.suggestion || null,
      context: raw.context || null,
    };
    if (f.line !== null && (!Number.isInteger(f.line) || f.line < 1)) return { status: "invalid", reason: `${source} findings[${i}] line 非法` };
    f.fingerprint = findingFingerprint(ctx.project, f);
    findings.push(f);
  }
  return { status: "ok", findings, toolVersion: (data && data.toolVersion) || "unknown" };
}
