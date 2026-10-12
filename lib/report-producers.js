import path from "node:path";
import { mkdirSync, rmSync, lstatSync } from "node:fs";
import { safePath, fileHash } from "./source-state.js";
import { runCommand, redactLog } from "./exec.js";
import { sha256 } from "./util.js";

// Explicit, per-run production only. Never reuse a prior invocation's report.
export function createReportProducers(checks, ctx) {
  const groups = new Map();
  for (const check of checks.filter((c) => c.producer)) {
    const group = groups.get(check.producer) || { checks: [], promise: null, command: check.command, timeoutMs: Number(check.timeoutMs) || 600000 };
    group.checks.push(check);
    groups.set(check.producer, group);
  }
  for (const group of groups.values()) {
    for (const check of group.checks) {
      const file = safePath(ctx.root, check.file);
      if (checks.filter((c) => c.file && path.resolve(ctx.root, c.file) === file).length !== 1) throw new Error(`共享生产报告路径有多个消费者写入: ${check.file}`);
    }
  }
  return groups;
}

async function produce(group, ctx) {
  const files = group.checks.map((c) => safePath(ctx.root, c.file));
  for (const file of files) { rmSync(file, { force: true }); mkdirSync(path.dirname(file), { recursive: true }); }
  const started = Date.now();
  group.record = { eventId: ctx.eventId, commandHash: sha256(group.command), commandRuns: 1, status: "running" };
  try {
    const r = await runCommand(group.command, { cwd: ctx.root, timeoutMs: group.timeoutMs,
      env: { ...process.env, WL_GATE_EVENT_ID: ctx.eventId, WL_GATE_COMMIT_SHA: ctx.commitSha } });
    const diagnostic = redactLog(r.stderr || r.stdout).trim().slice(-1000);
    if (r.timedOut || r.code !== 0) throw new Error(`共享报告生产命令失效（exit=${r.code}）${diagnostic ? `: ${diagnostic}` : ""}`);
    const hashes = new Map();
    for (const file of files) {
      if (!lstatSync(file).isFile()) throw new Error("共享生产报告不是普通文件");
      safePath(ctx.root, path.relative(ctx.root, file));
      hashes.set(file, fileHash(file));
    }
    return { hashes, durationMs: Date.now() - started, commandHash: sha256(group.command), diagnostic };
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
  const file = safePath(ctx.root, check.file);
  if (fileHash(file) !== result.hashes.get(file)) throw new Error("共享生产报告在消费前发生变化，拒绝复用");
  return { file, exitCode: 0, diagnostic: result.diagnostic,
    production: { producer: check.producer, eventId: ctx.eventId, commandHash: result.commandHash,
      reportHash: result.hashes.get(file), durationMs: result.durationMs, reused } };
}
