import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SCHEMA_FILE, validateSummaryAgainstSchema } from "./validate-report.js";
import { blockingFinding } from "./risk.js";
import { redactLog } from "./exec.js";
import { sha256 } from "./util.js";

const schema = JSON.parse(readFileSync(DEFAULT_SCHEMA_FILE, "utf8"));
const severities = ["blocker", "error", "warning", "info"];
const statuses = ["new", "existing", "waived", "expired"];

function integer(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} 必须为 ${min}～${max} 的整数`);
  return n;
}

function shortText(value, limit) {
  const text = redactLog(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…[truncated]` : text;
}

// Include the trailing newline and the byte-count field itself in the budget.
function encode(result) {
  for (let i = 0; i < 8; i++) {
    const text = `${JSON.stringify(result)}\n`;
    const bytes = Buffer.byteLength(text);
    if (result.response.bytes === bytes) return text;
    result.response.bytes = bytes;
  }
  throw new Error("无法计算报告视图字节预算");
}

function cursorFor(digest, selection, offset) {
  return Buffer.from(JSON.stringify({ digest, selection, offset })).toString("base64url");
}

function cursorOffset(cursor, digest, selection, total) {
  if (!cursor) return 0;
  if (typeof cursor !== "string" || cursor.length > 512 || !/^[\w-]+$/.test(cursor)) throw new Error("无效的报告游标");
  let value;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new Error("无效的报告游标"); }
  if (!value || value.digest !== digest || value.selection !== selection) throw new Error("报告或筛选条件已变化，请从第一页重新查看");
  if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset >= total) throw new Error("报告游标位置无效");
  return value.offset;
}

/** Read an existing report; never execute checks, alter evidence or invoke a model. */
export function inspectReport(file, options = {}) {
  const view = options.view ?? "summary";
  const status = options.status ?? "all";
  const severity = options.severity ?? "all";
  const rule = options.rule ?? null;
  if (!["summary", "findings"].includes(view)) throw new Error("--view 仅支持 summary / findings");
  if (!["all", ...statuses].includes(status)) throw new Error("--status 不合法");
  if (!["all", ...severities].includes(severity)) throw new Error("--severity 不合法");
  if (rule !== null && (typeof rule !== "string" || !rule.trim())) throw new Error("--rule 必须为非空规则编号");
  if (options.cursor && view !== "findings") throw new Error("--cursor 仅用于 --view findings");
  const limit = integer(options.limit, 20, 1, 100, "--limit");
  const maxBytes = integer(options.maxBytes, 12000, 4096, 65536, "--max-bytes");
  if (!file) throw new Error("缺少 quality-summary.json 路径");
  const reportFile = path.resolve(file);
  const bytes = readFileSync(reportFile);
  let raw;
  try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("报告必须为有效的 UTF-8 文本"); }
  let s;
  try { s = JSON.parse(raw); } catch { throw new Error("报告 JSON 无法解析"); }
  const errors = validateSummaryAgainstSchema(s, schema);
  if (errors.length) throw new Error(`报告结构无效: ${errors.slice(0, 3).map((e) => shortText(e, 160)).join("; ")}`);
  const digest = sha256(raw);
  const selection = sha256(JSON.stringify({ status, severity, rule }));
  const enforceWarnings = s.policy?.enforceWarnings === true;
  const totals = { findings: s.findings.length, blocking: 0,
    bySeverity: Object.fromEntries(severities.map((k) => [k, 0])),
    byStatus: Object.fromEntries(statuses.map((k) => [k, 0])) };
  const selected = [];
  for (const f of s.findings) {
    totals.bySeverity[f.severity]++;
    totals.byStatus[f.status]++;
    if (blockingFinding(f, enforceWarnings)) totals.blocking++;
    if ((status === "all" || f.status === status) && (severity === "all" || f.severity === severity) && (rule === null || f.ruleId === rule)) selected.push(f);
  }
  const active = (f) => Number(f.status === "new" || f.status === "expired");
  if (view === "findings") selected.sort((a, b) => Number(blockingFinding(b, enforceWarnings)) - Number(blockingFinding(a, enforceWarnings)) ||
    active(b) - active(a) || severities.indexOf(a.severity) - severities.indexOf(b.severity));
  const offset = cursorOffset(options.cursor, digest, selection, selected.length);
  const byStatus = { ok: 0, invalid: 0, degraded: 0 };
  for (const c of s.checks) byStatus[c.status]++;
  const result = {
    schema: "wl-gate-inspect.v1", displayOnly: true,
    report: { file: reportFile, digest },
    run: Object.fromEntries(["project", "eventId", "profile", "scope", "base", "head", "commitSha", "startedAt", "durationMs", "sourceBound", "targetEnv"].map((k) => [k, s.run[k] ?? null])),
    decision: { status: s.decision.status, reasons: s.decision.reasons.slice(0, 5).map((r) => shortText(r, 240)), reasonsOmitted: Math.max(0, s.decision.reasons.length - 5) },
    totals,
    checks: { total: s.checks.length, byStatus, omitted: Math.max(0, s.checks.length - 5),
      items: [...s.checks].sort((a, b) => Number(b.status !== "ok") - Number(a.status !== "ok") || (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 5).map((c) => ({
        checkId: c.checkId, status: c.status, durationMs: c.durationMs ?? null,
        reason: shortText(c.reason || c.note || "", 240),
        coverage: c.coverage ? { mode: c.coverage.mode, complete: c.coverage.complete, scannedFileCount: c.coverage.scannedFileCount } : null,
      })) },
    page: { view, filters: { status, severity, rule }, selectedTotal: selected.length, offset, limit, returned: 0, nextCursor: null },
    findings: [],
    response: { maxBytes, bytes: 0, detailsTruncated: false },
  };
  let text = encode(result);
  while (Buffer.byteLength(text) > maxBytes && (result.checks.items.length || result.decision.reasons.length)) {
    if (result.checks.items.length) { result.checks.items.pop(); result.checks.omitted++; }
    else { result.decision.reasons.pop(); result.decision.reasonsOmitted++; }
    text = encode(result);
  }
  if (view === "findings") {
    for (const f of selected.slice(offset, offset + limit)) {
      const message = shortText(f.message || "", 240);
      const suggestion = shortText(f.suggestion || "", 160);
      const detailsTruncated = message !== (f.message || "") || suggestion !== (f.suggestion || "");
      const item = { fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity, status: f.status,
        file: f.file, line: f.line ?? null, message, suggestion, occurrences: f.occurrences?.length ?? 1,
        blocking: blockingFinding(f, enforceWarnings), detailsTruncated };
      result.findings.push(item);
      result.page.returned = result.findings.length;
      const next = offset + result.page.returned;
      result.page.nextCursor = next < selected.length ? cursorFor(digest, selection, next) : null;
      result.response.detailsTruncated = result.findings.some((i) => i.detailsTruncated);
      text = encode(result);
      if (Buffer.byteLength(text) > maxBytes) {
        result.findings.pop();
        result.page.returned = result.findings.length;
        const nextOffset = offset + result.page.returned;
        result.page.nextCursor = nextOffset < selected.length ? cursorFor(digest, selection, nextOffset) : null;
        result.response.detailsTruncated = result.findings.some((i) => i.detailsTruncated);
        text = encode(result);
        break;
      }
    }
    if (!result.page.returned && offset < selected.length) throw new Error("单项定位信息超出视图预算，请提高 --max-bytes 或直接查看完整工件");
  }
  if (Buffer.byteLength(text) > maxBytes) throw new Error("报告元信息超出视图预算，请提高 --max-bytes 或直接查看完整工件");
  return { text, result, exitCode: { passed: 0, blocked: 1, invalid: 2 }[s.decision.status] };
}
