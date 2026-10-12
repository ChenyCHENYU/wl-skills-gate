import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

const DEFAULT_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];

export function validateCommitMessage(messageFile, root) {
  const { policy } = loadConfig(root);
  const first = readFileSync(messageFile, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)[0];
  const m = /^([a-z][a-z0-9-]*)\(([^()\r\n]+)\):\s+(.+?)\s*[-－—]\s*(\S.*)$/.exec(first);
  if (!m || !m[2].trim() || !m[3].trim() || /^[-－—]+$/.test(m[4].trim()) || !(policy.commitTypes || DEFAULT_TYPES).includes(m[1])) {
    return { ok: false, reason: "提交说明须为批准类型(范围): 功能点-具体修改，范围和两段说明均不得为空" };
  }
  return { ok: true };
}
