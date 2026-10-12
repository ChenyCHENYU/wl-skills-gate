import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { safePath } from "./source-state.js";
import { runCommand, redactLog } from "./exec.js";
import { prepareSharedReport } from "./report-producers.js";

export async function prepareReport(check, ctx) {
  if (!check.file) throw new Error("检查缺少报告 file");
  if (check.producer) return prepareSharedReport(check, ctx);
  const file = safePath(ctx.root, check.file);
  if (!check.command) {
    if (ctx.requireFresh) throw new Error("受控检查必须在本次执行 command 产生新报告，禁止摄入未绑定的旧文件");
    return { file, exitCode: 0 };
  }
  rmSync(file, { force: true });
  mkdirSync(path.dirname(file), { recursive: true });
  const result = await runCommand(check.command, {
    cwd: ctx.root, timeoutMs: Number(check.timeoutMs) || 600000,
    env: { ...process.env, WL_GATE_EVENT_ID: ctx.eventId, WL_GATE_COMMIT_SHA: ctx.commitSha },
  });
  const diagnostic = redactLog(result.stderr || result.stdout).trim().slice(-1000);
  if (result.timedOut || ![0, 1].includes(result.code)) throw new Error(`报告生产命令失效（exit=${result.code}）${diagnostic ? `: ${diagnostic}` : ""}`);
  return { file, exitCode: result.code, diagnostic };
}
