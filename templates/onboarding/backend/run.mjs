#!/usr/bin/env node
// 放在 wl-produce/scripts/quality/run.mjs，从 wl-produce 仓库根运行。
try {
  const { runGate } = await import("../../quality-tools/node_modules/@agile-team/wl-skills-gate/lib/run.js");
  const result = await runGate({ argv: process.argv.slice(2) });
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(`[quality] 入口或依赖不可用：${error.message}`);
  process.exitCode = 2;
}
