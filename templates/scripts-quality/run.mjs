#!/usr/bin/env node
try {
  const { runGate } = await import("@agile-team/wl-skills-gate/lib/run.js");
  const r = await runGate({ argv: process.argv.slice(2) });
  process.exitCode = r.exitCode;
} catch (e) {
  if (e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND")) {
    console.error("[quality] wl-skills-gate 未安装，无法执行质量检查。请先执行: npm i -D @agile-team/wl-skills-gate（失败关闭，不跳过）");
  } else {
    console.error(`[quality] 质量入口异常: ${e && e.message ? e.message : e}`);
  }
  process.exitCode = 2;
}
