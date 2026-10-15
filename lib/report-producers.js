import path from "node:path";
import { safePath, fileHash } from "./source-state.js";
import { runCommand, redactLog } from "./exec.js";
import { sha256 } from "./util.js";
import { reportPaths, cleanReportOutputs, bindProducedReports, validateReportInventory } from "./report-selection.js";

// Explicit, per-run production only. Never reuse a prior invocation's report.
export function createReportProducers(checks, ctx) {
  const outputs = new Map();
  for (const check of checks) for (const relative of reportPaths(check)) {
    const file = safePath(ctx.root, relative);
    if (outputs.has(file) && (check.command || outputs.get(file).command)) throw new Error(`报告路径有多个消费者写入: ${relative}`);
    outputs.set(file, check);
  }
  const groups = new Map();
  for (const check of checks.filter((c) => c.producer)) {
    const group = groups.get(check.producer) || { checks: [], promise: null, command: check.command,
      tool: check.tool, timeoutMs: Number(check.timeoutMs) || 600000 };
    group.checks.push(check);
    groups.set(check.producer, group);
  }
  for (const group of groups.values()) {
    for (const check of group.checks) {
      for (const relative of reportPaths(check)) {
        const file = safePath(ctx.root, relative);
        if (checks.flatMap((c) => reportPaths(c)).filter((p) => path.resolve(ctx.root, p) === file).length !== 1) throw new Error(`共享生产报告路径有多个消费者写入: ${relative}`);
      }
      for (const dir of check.reportDirs || []) {
        if (checks.some((c) => c.id !== check.id && reportPaths(c).some((p) => path.dirname(safePath(ctx.root, p)) === safePath(ctx.root, dir)))) {
          throw new Error(`JUnit 报告目录有多个消费者清理/写入: ${dir}`);
        }
      }
    }
  }
  return groups;
}

async function produce(group, ctx) {
  const files = group.checks.flatMap((c) => reportPaths(c).map((p) => safePath(ctx.root, p)));
  const started = Date.now();
  group.record = { eventId: ctx.eventId, commitSha: ctx.commitSha, sourceDigest: ctx.sourceDigest || null,
    commandHash: sha256(group.command), commandRuns: 0, status: "running" };
  try {
    cleanReportOutputs(group.checks, ctx);
    group.record.commandRuns = 1;
    const r = await runCommand(group.command, { cwd: ctx.root, timeoutMs: group.timeoutMs,
      env: { ...process.env, WL_GATE_EVENT_ID: ctx.eventId, WL_GATE_COMMIT_SHA: ctx.commitSha } });
    const diagnostic = redactLog(r.stderr || r.stdout).trim().slice(-1000);
    group.record.exitCode = r.code;
    if (r.timedOut || !(group.tool === "junit" ? [0, 1].includes(r.code) : r.code === 0)) throw new Error(`共享报告生产命令失效（exit=${r.code}）${diagnostic ? `: ${diagnostic}` : ""}`);
    for (const check of group.checks) validateReportInventory(check, ctx);
    const reports = bindProducedReports(files, ctx);
    const hashes = new Map(reports.map((report) => [safePath(ctx.root, report.file), report.sha256]));
    group.record.reports = reports;
    return { hashes, reports, exitCode: r.code, durationMs: Date.now() - started, commandHash: sha256(group.command), diagnostic };
  } catch (e) {
    group.record.status = "invalid";
    throw e;
  } finally {
    if (group.record.status === "running") group.record.status = "ok";
    group.record.durationMs = Date.now() - started;
  }
}

export async function prepareSharedReport(check, ctx) {
  const group = ctx.reportProducers?.get(check.producer);
  if (!group) throw new Error("共享生产者未绑定本次 Gate 运行");
  const reused = group.promise !== null;
  if (!group.promise) group.promise = produce(group, ctx);
  const result = await group.promise;
  validateReportInventory(check, ctx);
  const files = reportPaths(check).map((p) => safePath(ctx.root, p));
  for (const file of files) if (fileHash(file) !== result.hashes.get(file)) throw new Error("共享生产报告在消费前发生变化，拒绝复用");
  const reports = files.map((file) => ({ file: path.relative(ctx.root, file).split(path.sep).join("/"), sha256: result.hashes.get(file) }));
  return { file: files[0], files, exitCode: result.exitCode, diagnostic: result.diagnostic,
    production: { producer: check.producer, eventId: ctx.eventId, commandHash: result.commandHash,
      commitSha: ctx.commitSha, sourceDigest: ctx.sourceDigest || null, reports,
      reportHash: reports.length === 1 ? reports[0].sha256 : null, durationMs: result.durationMs, reused } };
}
