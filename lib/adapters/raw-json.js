import { exists } from "../util.js";
import { parseFindingsPayload } from "../finding-input.js";
import { prepareReport } from "../report-input.js";
import { readReportContent } from "../report-selection.js";

export async function run(check, ctx) {
  if (!check.file) return { status: "invalid", reason: "raw-json 检查缺少 file（结果文件路径）" };
  let input;
  try { input = await prepareReport(check, ctx); } catch (e) { return { status: "invalid", reason: e.message }; }
  const file = input.file;
  if (!exists(file)) {
    return { status: "invalid", reason: `结果文件缺失: ${check.file}（失败关闭，不等同于无问题）` };
  }
  let data;
  try {
    data = JSON.parse(readReportContent(file, ctx).content);
  } catch (e) {
    return { status: "invalid", reason: `结果文件损坏或无法解析: ${check.file}` };
  }
  const parsed = parseFindingsPayload(data, check.file, check, ctx);
  if (parsed.status === "invalid") return parsed;
  if (input.exitCode !== 0 && !parsed.findings.length) return { status: "invalid", reason: "命令非零退出却无失败证据" };
  const notes = [];
  if (data.decision || data.status || data.passed) {
    notes.push("输入含 decision/status/passed 类结论字段，已忽略，门禁结论一律按 findings 重算");
  }
  return { ...parsed, production: input.production, note: notes.join("; ") || null };
}
