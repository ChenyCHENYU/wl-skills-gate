import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/onboarding/legacy");
const normalize = (value) => value.replaceAll("\r\n", "\n");
export function unmanagedHook(value) {
  const begin = "# wl-quality-onboarding:begin v1", end = "# wl-quality-onboarding:end";
  const text = normalize(value), start = text.indexOf(begin), finish = text.indexOf(end);
  if (start < 0 && finish < 0) return text;
  if (start < 0 || finish < start || text.indexOf(begin, start + begin.length) >= 0) throw new Error("既有Gate Hook标识损坏，拒绝迁移");
  return text.slice(0, start) + text.slice(finish + end.length).replace(/^\n/, "");
}
export function knownLegacy(kind, action, previous, readSource) {
  const source = path.join(ROOT, `${kind}-${action}.sh`);
  let reference; try { reference = readSource(source, "已核对旧受管Hook迁移指纹"); } catch { return false; }
  return unmanagedHook(previous) === normalize(reference);
}
export function migrateFrontendHook(action, previous, readSource) {
  if (!["pre-commit", "pre-push"].includes(action) || !knownLegacy("frontend", action, previous, readSource)) return previous;
  const tag = action === "pre-commit" ? "# wl-skills-hook-v2" : "# wl-skills-prepush-hook-v1";
  return `#!/usr/bin/env sh\n${action === "pre-commit" ? "pnpm exec lint-staged\n" : ""}${tag}\n# 同类规范由Gate统一调度；保留兼容标识，避免规则包重复安装旧块。\n`;
}
export function migrateLintStaged(pkg) {
  const config = pkg["lint-staged"]; const changes = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return changes;
  for (const [pattern, commands] of Object.entries(config)) {
    const transform = (command) => {
      const next = command === "eslint --fix" ? "eslint" : command === "prettier --write" ? "prettier --check" : command;
      if (next !== command) changes.push({ pattern, before: command, after: next });
      return next;
    };
    if (typeof commands === "string") config[pattern] = transform(commands);
    else if (Array.isArray(commands) && commands.every((value) => typeof value === "string")) config[pattern] = commands.map(transform);
  }
  return changes;
}
export function fixedLocalBdCommitHook() {
  return ['#!/bin/sh', 'set -eu', 'repo_root="$(git rev-parse --show-toplevel)"',
    'package_cli="$repo_root/quality-tools/node_modules/@agile-team/wl-skills-bd/bin/wl-skills-bd.js"',
    'if [ ! -f "$package_cli" ]; then echo "固定BD提交校验器缺失，检查不会跳过" >&2; exit 2; fi',
    'exec node "$package_cli" commit validate --file "$1" --target "$repo_root"', ''].join("\n");
}
