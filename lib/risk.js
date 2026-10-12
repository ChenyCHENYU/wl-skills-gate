const RISK = { info: 0, warning: 1, error: 2, blocker: 3 };

export function highestSeverity(a, b) {
  return RISK[a] >= RISK[b] ? a : b;
}

export function immutableFailure(f) {
  return f.severity === "blocker" || f.baselineAllowed === false ||
    /^(?:TS\/|JUNIT\/|SEC\/|SECURITY\/|BUILD\/|ENV\/|DATA\/|GATE\/)/.test(f.ruleId);
}

export function blockingFinding(f, enforceWarnings = false) {
  const severityBlocks = f.severity === "blocker" || f.severity === "error" || (enforceWarnings && f.severity === "warning");
  return severityBlocks && (immutableFailure(f) || f.status === "new" || f.status === "expired");
}
