import { findingFingerprint } from "./fingerprint.js";
import { highestSeverity, immutableFailure, blockingFinding } from "./risk.js";

function escapeRx(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function pathMatches(pattern, file) {
  if (!pattern) return true;
  if (pattern === file) return true;
  const re = new RegExp(
    `^${String(pattern)
      .split("**")
      .map((seg) => escapeRx(seg).split("*").join("[^/]*"))
      .join(".*")}$`
  );
  return re.test(file);
}

function matchWaiver(finding, waivers, nowMs) {
  let best = null;
  for (const w of waivers) {
    if (String(w.ruleId) !== String(finding.ruleId)) continue;
    if (!pathMatches(w.path, finding.file)) continue;
    const expired = Date.parse(w.expiresAt) <= nowMs;
    if (!best || (best.expired && !expired)) best = { waiver: w, expired };
  }
  return best;
}

export function collect({
  project,
  findings,
  waivers = [],
  baselineItems = [],
  now = new Date(),
  enforceWarnings = false,
  fullScan = false,
}) {
  const baselineSet = new Set(baselineItems.map((i) => i.fingerprint));
  const map = new Map();
  for (const f of findings) {
    f.fingerprint = findingFingerprint(project, f);
    const prev = map.get(f.fingerprint);
    if (prev) {
      prev.duplicates += 1;
      prev.occurrences.push({ line: f.line ?? null, message: f.message });
      prev.severity = highestSeverity(prev.severity, f.severity);
      if (f.baselineAllowed === false) prev.baselineAllowed = false;
      continue;
    }
    f.duplicates = 0;
    f.occurrences = [{ line: f.line ?? null, message: f.message }];
    map.set(f.fingerprint, f);
  }
  const counts = { new: 0, existing: 0, waived: 0, expired: 0, blockingNew: 0 };
  const nowMs = now.getTime();
  for (const f of map.values()) {
    const w = matchWaiver(f, waivers, nowMs);
    const baseline = baselineItems.find((it) => it.fingerprint === f.fingerprint);
    if (w && !w.expired) {
      if (immutableFailure(f)) {
        f.status = "new";
        f.waiverRejected = w.waiver.id;
        counts.new += 1;
      } else {
        f.status = "waived";
        f.waiverId = w.waiver.id;
        counts.waived += 1;
      }
    } else if (w && w.expired) {
      f.status = "expired";
      f.waiverId = w.waiver.id;
      counts.expired += 1;
    } else if (baseline && !immutableFailure(f) && f.occurrences.length <= (baseline.occurrenceCount ?? 1) &&
      highestSeverity(f.severity, baseline.severity || "error") === (baseline.severity || "error")) {
      f.status = "existing";
      counts.existing += 1;
    } else {
      f.status = "new";
      counts.new += 1;
    }
    if (blockingFinding(f, enforceWarnings)) counts.blockingNew += 1;
  }
  const baselineResolvedPending = fullScan ? [...baselineSet].filter((fp) => !map.has(fp)) : [];
  return { findings: [...map.values()], counts, baselineResolvedPending };
}
