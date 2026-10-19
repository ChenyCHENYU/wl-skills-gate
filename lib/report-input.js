import { lstatSync } from "node:fs";
import { safePath } from "./source-state.js";
import { runCommand, redactLog } from "./exec.js";
import { prepareSharedReport } from "./report-producers.js";
import { reportPaths, cleanReportOutputs, bindProducedReports, validateReportInventory } from "./report-selection.js";
import { sha256 } from "./util.js";

export async function prepareReport(check, ctx) {
  const paths = reportPaths(check);
  if (!paths.length) throw new Error("检查缺少报告 file/files");
  if (check.producer) return prepareSharedReport(check, ctx);
  const files = paths.map((p) => safePath(ctx.root, p));
  const file = files[0];
  if (!check.command) {
    if (ctx.requireFresh) throw new Error("受控检查必须在本次执行 command 产生新报告，禁止摄入未绑定的旧文件");
    validateReportInventory(check, ctx);
    for (let i = 0; i < files.length; i++) {
      try { if (!lstatSync(files[i]).isFile()) throw new Error("摄入报告不是普通文件"); }
      catch (e) { if (e.code === "ENOENT") throw new Error(`结果文件缺失: ${paths[i]}`); throw e; }
    }
    return { file, files, exitCode: 0 };
  }
  cleanReportOutputs([check], ctx);
  const started = Date.now();
  const result = await runCommand(check.command, {
    cwd: ctx.root, timeoutMs: Number(check.timeoutMs) || 600000,
    env: { ...process.env, NODE_TEST_CONTEXT:undefined, WL_GATE_EVENT_ID: ctx.eventId, WL_GATE_COMMIT_SHA: ctx.commitSha },
  });
  const diagnostic = redactLog(result.stderr || result.stdout).trim().slice(-1000);
  if (result.timedOut || ![0, 1].includes(result.code)) throw new Error(`报告生产命令失效（exit=${result.code}）${diagnostic ? `: ${diagnostic}` : ""}`);
  if ((check.tool === "java-xml" || ["checkstyle", "pmd", "p3c", "spotbugs"].includes(check.format)) && result.code !== 0) throw new Error(`Java 报告生产失败（exit=${result.code}）${diagnostic ? `: ${diagnostic}` : ""}，不可用告警代替运行成功`);
  validateReportInventory(check, ctx);
  const reports = bindProducedReports(files, ctx);
  return { file, files, exitCode: result.code, diagnostic,
    production: { producer: null, eventId: ctx.eventId, commitSha: ctx.commitSha,
      sourceDigest: ctx.sourceDigest || null, commandHash: sha256(check.command), reports,
      reportHash: reports.length === 1 ? reports[0].sha256 : null, durationMs: Date.now() - started, reused: false } };
}
