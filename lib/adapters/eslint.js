import path from "node:path";
import { realpathSync } from "node:fs";
import { runCommand, quote } from "../exec.js";

const EXT = /\.(js|mjs|cjs|ts|tsx|jsx|vue)$/;
const ignoredMessage = (m) => !m.ruleId && /(?:file ignored|ignored because|no matching configuration)/i.test(m.message || "");

export async function run(check, ctx) {
  const mode = ctx.scope === "staged" ? "staged" : ctx.base && ctx.head ? "range" : "full";
  if (check.command && mode !== "full") {
    return { status: "invalid", reason: "配置 command 覆盖时不能使用 --scope staged 或 --base/--head，改用 bin + targets/args 保留范围语义" };
  }
  let requested = null;
  if (mode !== "full") {
    const command = mode === "staged"
      ? "git diff --cached --name-only -z --diff-filter=ACMR"
      : `git diff --name-only -z ${quote(`${ctx.base}...${ctx.head}`)} --diff-filter=ACMR`;
    const diff = await runCommand(command, { cwd: ctx.root });
    if (diff.code !== 0) return { status: "invalid", reason: `git diff 失败: ${diff.stderr || diff.spawnError || diff.code}` };
    const approvedTargets=check.targets||["."];
    requested = diff.stdout.split("\0").filter(Boolean).filter((file) => EXT.test(file) && approvedTargets.some(target=>target==="."||file===target||file.startsWith(target.replace(/\/$/,"")+"/")||path.matchesGlob(file,target)));
    if (!requested.length) return { status: "ok", findings: [], toolVersion: "eslint", note: `${mode} 范围无适用文件`,
      coverage: { mode, complete: true, noApplicableFiles: true, requestedFiles: [], scannedFiles: [], scannedFileCount: 0 } };
    if (mode === "staged") {
      const dirty = await runCommand("git diff --name-only -z", { cwd: ctx.root });
      if (dirty.code !== 0) return { status: "invalid", reason: "无法核验暂存文件与工作区一致性" };
      if (dirty.stdout.split("\0").some((file) => requested.includes(file))) return { status: "invalid", reason: "暂存文件还有未暂存修改，请完成暂存或撤销后检查" };
    }
  }
  const targets = check.targets || ["."];
  const binPath = check.bin || path.join(ctx.root, "node_modules", ".bin", "eslint");
  const cacheArgs = check.cache ? " --cache --cache-location node_modules/.cache/eslint" : "";
  const args = check.args ? ` ${check.args}` : "";
  const command = check.command || `${quote(binPath)}${args} --no-inline-config --format json${cacheArgs} ${(requested || targets).map(quote).join(" ")}`;
  const r = await runCommand(command, { cwd: ctx.root, timeoutMs: Number(check.timeoutMs) || 300000 });
  if (r.timedOut || r.truncated) return { status: "invalid", reason: r.truncated ? "eslint 输出超过上限" : "eslint 执行超时" };
  if (r.code === null || r.code === 126 || r.code === 127) return { status: "invalid", reason: `eslint 不可用（exit=${r.code}）: ${r.spawnError || r.stderr.slice(0, 500)}` };
  if (r.code >= 2) return { status: "invalid", reason: `eslint 异常退出（${r.code}）: ${r.stderr.slice(0, 500)}` };
  let report;
  try { report = JSON.parse(r.stdout); } catch { return { status: "invalid", reason: "eslint JSON 输出无法解析" }; }
  if (!Array.isArray(report)) return { status: "invalid", reason: "eslint 输出非数组" };
  const findings = [], scannedFiles = [], ignoredFiles = [];
  const physicalRoot = realpathSync(ctx.root);
  for (const entry of report) {
    if (!entry || typeof entry.filePath !== "string" || !entry.filePath || !Array.isArray(entry.messages)) return { status: "invalid", reason: "eslint 文件结果缺 filePath/messages" };
    if(entry.suppressedMessages?.length) return {status:"invalid",reason:"ESLint结果含源码内抑制，须走中央批准策略，不能用注释隐藏发现"};
    let reportedPath = path.resolve(ctx.root, entry.filePath);
    try { reportedPath = realpathSync(reportedPath); } catch (e) { if (e.code !== "ENOENT") return { status: "invalid", reason: `eslint 文件路径失效: ${e.message}` }; }
    const relative = path.relative(physicalRoot, reportedPath).split(path.sep).join("/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return { status: "invalid", reason: "eslint 文件结果超出项目范围" };
    if (entry.messages.some(ignoredMessage)) {
      if (!entry.messages.every(ignoredMessage)) return { status: "invalid", reason: "eslint 忽略标记与检查问题混合，报告不一致" };
      ignoredFiles.push(relative); continue;
    }
    scannedFiles.push(relative);
    for (const m of entry.messages) {
      if (typeof m.message !== "string" || ![1, 2].includes(m.severity)) return { status: "invalid", reason: "eslint message 结构异常" };
      findings.push({ ruleId: `ESLINT/${m.ruleId || "fatal"}`, severity: m.fatal || m.severity === 2 ? "error" : "warning",
        file: relative, line: m.line || null, message: m.message, dimension: check.dimension || "编码规范",
        autoFixable: !!m.fix, fixCommand: m.fix ? `${quote(binPath)}${args} --fix ${quote(relative)}` : null });
    }
  }
  const missing = requested?.filter((file) => !scannedFiles.includes(file)) || [];
  const coverage = { mode, complete: scannedFiles.length > 0 && !missing.length,
    targets: check.command ? null : targets, requestedFiles: requested, scannedFiles: [...new Set(scannedFiles)],
    scannedFileCount: new Set(scannedFiles).size, ignoredFiles };
  if (!coverage.complete) return { status: "invalid", coverage,
    reason: missing.length ? `eslint 未实际检查增量文件（忽略/配置缺失）: ${missing.slice(0, 10).join("、")}` : "eslint 实际扫描文件数为 0，拒绝空扫描通过" };
  if (r.code !== 0 && !findings.length) return { status: "invalid", coverage, reason: "eslint 非零退出却没有问题证据" };
  return { status: "ok", findings, toolVersion: "eslint", coverage, note: `${mode} 实际检查 ${coverage.scannedFileCount} 个文件` };
}
