import path from "node:path";
import { runCommand, quote } from "../exec.js";

export async function run(check, ctx) {
  const binPath = check.bin || path.join(ctx.root, "node_modules", ".bin", "vue-tsc");
  const args = check.args || "--noEmit";
  const command = `${quote(binPath)} ${args}`;
  const r = await runCommand(command, { cwd: ctx.root, timeoutMs: Number(check.timeoutMs) || 600000 });
  if (r.timedOut) return { status: "invalid", reason: "类型检查执行超时（工具异常，按 invalid 处理）" };
  if (r.code === null || r.code === 126 || r.code === 127) {
    return {
      status: "invalid",
      reason: `类型检查器不可用: ${binPath}（退出码 ${r.code}）。请先安装：npm i -D vue-tsc typescript，或在 policy 中配置实际 bin；失败关闭，不降级为 warning`,
    };
  }
  if (r.code === 0) return { status: "ok", findings: [], toolVersion: binPath };
  if (![1, 2].includes(r.code)) return { status: "invalid", reason: `类型检查异常退出（${r.code}）` };
  const output = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
  return {
    status: "ok",
    findings: [
      {
        ruleId: "TS/TYPEERROR",
        severity: "error",
        file: "(project)",
        line: null,
        message: `类型检查失败，首批输出:\n${output.slice(0, 1500)}`,
        dimension: check.dimension || "编码规范",
        autoFixable: false,
        baselineAllowed: false,
        fixCommand: null,
        context: "typecheck-exit-1",
      },
    ],
    toolVersion: binPath,
  };
}
