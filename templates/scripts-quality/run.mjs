#!/usr/bin/env node
try {
  const { runGate } = await import("@agile-team/wl-skills-gate/lib/run.js");
  const r = await runGate({ argv: process.argv.slice(2) });
  process.exitCode = r.exitCode;
} catch (e) {
  if (e && (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "MODULE_NOT_FOUND")) {
    console.error("[quality] 固定Gate未安装，请使用项目初始化任务恢复批准依赖；质量检查不会跳过。");
  } else {
    console.error(`[quality] 质量入口异常: ${e && e.message ? e.message : e}`);
  }
  process.exitCode = 2;
}
