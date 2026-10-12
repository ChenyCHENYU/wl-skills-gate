import { sha256 } from "./util.js";

export function findingFingerprint(project, finding) {
  const context = finding.context || finding.message || "";
  return sha256(["wl-gate-v1", project, finding.ruleId, finding.file, context].join("\u0000"));
}
