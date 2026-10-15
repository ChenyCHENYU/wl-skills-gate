import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { safePath } from "./source-state.js";

export function nodeRangeSatisfied(range, actual = process.versions.node) {
  if (typeof range !== "string" || !range.trim() || !/^\d+\.\d+\.\d+$/.test(actual)) return false;
  const current = actual.split(".").map(Number);
  const compare = (version) => { for (let i = 0; i < 3; i++) { const diff = current[i] - (version[i] || 0); if (diff) return Math.sign(diff); } return 0; };
  return range.split("||").some((alternative) => {
    const parts = alternative.trim().split(/\s+/);
    return parts.length > 0 && parts.every((part) => {
      if (["*", "x"].includes(part)) return true;
      const match = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.(?:\d+|x|\*)){0,2})$/.exec(part);
      if (!match) return false;
      const operator = match[1], strings = match[2].split("."), version = strings.map((v) => /^\d+$/.test(v) ? Number(v) : 0);
      const c = compare(version), explicit = strings.findIndex((v) => ["x", "*"].includes(v)), precision = explicit < 0 ? strings.length : explicit;
      const partialUpper = precision === 1 ? [version[0] + 1, 0, 0] : precision === 2 ? [version[0], (version[1] || 0) + 1, 0] : null;
      if (operator === ">=") return c >= 0; if (operator === "<=") return partialUpper ? compare(partialUpper) < 0 : c <= 0;
      if (operator === ">") return partialUpper ? compare(partialUpper) >= 0 : c > 0; if (operator === "<") return c < 0;
      if (operator === "^" || operator === "~") {
        const upper = operator === "~" ? precision === 1 ? [version[0] + 1, 0, 0] : [version[0], (version[1] || 0) + 1, 0] : version[0] > 0 ? [version[0] + 1, 0, 0] : (version[1] || 0) > 0 ? [0, version[1] + 1, 0] : [0, 0, (version[2] || 0) + 1];
        return c >= 0 && compare(upper) < 0;
      }
      return strings.every((v, i) => ["x", "*"].includes(v) || current[i] === Number(v));
    });
  });
}

export function onboardingEnvironment({ root, kind, manifestContent, nodeVersion = process.versions.node, executable = process.execPath }) {
  const packageFile = kind === "backend" ? "quality-tools/package.json" : "package.json";
  const file = safePath(root, packageFile);
  const pkg = JSON.parse(manifestContent || (existsSync(file) ? readFileSync(file, "utf8") : "{}"));
  const checks = [{ id: "NODE-ENVIRONMENT", range: ">=22.12.0", passed: nodeRangeSatisfied(">=22.12.0", nodeVersion) }];
  if (pkg.engines?.node !== undefined) checks.push({ id: "PROJECT-NODE-ENGINES", range: pkg.engines.node, passed: nodeRangeSatisfied(pkg.engines.node, nodeVersion) });
  return { executable, executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), nodeVersion, checks,
    blockers: checks.filter((check) => !check.passed).map((check) => ({ id: check.id, reason: `Node ${nodeVersion} 不满足批准范围 ${String(check.range)}；接入预检零写入，先使用符合项目与组合工具范围的固定环境`, nextOwner: "运维/工程工具维护者" })) };
}
