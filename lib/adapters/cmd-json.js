import { exists } from "../util.js";
import { runCommand, redactLog } from "../exec.js";
import { parseFindingsPayload } from "../finding-input.js";
import { sha256 } from "../util.js";
import { safePath } from "../source-state.js";
import { normalizeNative } from "../native-input.js";
import { cleanReportOutputs, bindProducedReports, readReportContent } from "../report-selection.js";

export async function run(check, ctx) {
  if (!check.command) return { status: "invalid", reason: "cmd-json 检查缺少 command" };
  if (check.format && (ctx.scope || ctx.base || /(?:^|\s)--(?:quick|staged|changed|only|skip)(?:[\s=]|$)/.test(check.command))) {
    return { status: "invalid", reason: "原生报告转换当前只验收完整扫描；增量/规则裁剪须独立登记并提供覆盖证据" };
  }
  if (check.file) {
    try { cleanReportOutputs([check], ctx); }
    catch (e) { return { status: "invalid", reason: e.message }; }
  }
  const started = Date.now();
  const r = await runCommand(check.command, { cwd: ctx.root, timeoutMs: Number(check.timeoutMs) || 600000,
    stdoutFile: check.captureStdout ? safePath(ctx.root, check.file) : undefined,
    env: { ...process.env, WL_GATE_EVENT_ID: ctx.eventId, WL_GATE_COMMIT_SHA: ctx.commitSha } });
  if (r.timedOut) return { status: "invalid", reason: `cmd-json 执行超时: ${check.command.slice(0, 120)}` };
  const okCodes = Array.isArray(check.okExitCodes) ? check.okExitCodes.map(Number) : [0];
  if (r.code === null || !okCodes.includes(r.code)) {
    return {
      status: "invalid",
      reason: `命令异常退出 ${r.code}（允许 ${okCodes.join("/")}，其余按工具失效处理）: ${redactLog(r.stderr || r.stdout).slice(-1000)}`,
    };
  }
  let data;
  let production;
  if (check.file) {
    const file = safePath(ctx.root, check.file);
    if (!exists(file)) return { status: "invalid", reason: `结果文件缺失: ${check.file}` };
    try {
      const reports = bindProducedReports([file], ctx);
      data = JSON.parse(readReportContent(file, ctx).content);
      production = { producer: null, eventId: ctx.eventId, commitSha: ctx.commitSha, sourceDigest: ctx.sourceDigest || null,
        commandHash: sha256(check.command), reports, reportHash: reports[0].sha256, durationMs: Date.now() - started, reused: false };
    } catch (e) {
      return { status: "invalid", reason: `结果文件损坏或无法解析: ${check.file}` };
    }
  } else {
    try {
      data = JSON.parse(r.stdout);
    } catch (e) {
      return { status: "invalid", reason: "stdout 不是合法 JSON（cmd-json 契约：命令须输出统一 findings）" };
    }
  }
  let nativeNote;
  if (check.format) {
    try { const normalized = normalizeNative(data, check.format, ctx); data = normalized.data; nativeNote = normalized.note; }
    catch (e) { return { status: "invalid", reason: `原生报告失效: ${e.message}` }; }
  }
  const parsed = parseFindingsPayload(data, check.file || "stdout", check, ctx);
  if (parsed.status === "invalid") return parsed;
  if (r.code !== 0 && !parsed.findings.length) return { status: "invalid", reason: "非零退出却没有问题证据，拒绝空报告放行" };
  const notes = nativeNote ? [nativeNote] : [];
  if (data.decision || data.status || data.passed) notes.push("输入含结论字段，已忽略并按 findings 重算");
  return { ...parsed, production, note: notes.join("; ") || null };
}
