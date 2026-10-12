import path from "node:path";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { DEFAULT_SCHEMA_FILE, validateSummaryAgainstSchema } from "./validate-report.js";
import { sha256, stableStringify } from "./util.js";

const schema = JSON.parse(readFileSync(DEFAULT_SCHEMA_FILE, "utf8"));
const p = (values, percentile) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * percentile) - 1)] ?? null;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const add = (a, b) => { const total = a + b; if (!nonnegative(total)) throw new Error("成本计数总和超过安全整数范围"); return total; };

export function collectCost(directory, { usageFile } = {}) {
  const files = [];
  function walk(dir, depth = 0) {
    if (depth > 12) throw new Error("成本工件目录层级超限");
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("成本工件目录必须为普通目录");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("成本工件目录不能含符号链接");
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.name === "quality-summary.json") {
        if (!entry.isFile()) throw new Error("成本报告不是普通文件");
        files.push(file);
        if (files.length > 5000) throw new Error("成本工件超过 5000 份，请按时间窗口分批");
      }
    }
  }
  walk(path.resolve(directory));
  if (!files.length) throw new Error("未找到 quality-summary.json，不能生成零成本结论");
  const events = new Map();
  let duplicates = 0;
  for (const file of files.sort()) {
    if (lstatSync(file).size > 64 * 1024 * 1024) throw new Error("单份成本报告超过 64 MiB，请按时间窗口或项目拆分工件");
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s?.displayOnly === true || validateSummaryAgainstSchema(s, schema).length || s.run.durationMs < 0) throw new Error(`成本输入报告无效: ${file}`);
    const digest = sha256(stableStringify(s));
    const id = s.run.eventId || digest;
    if (events.has(id)) {
      if (events.get(id).digest !== digest) throw new Error("相同 eventId 存在冲突报告，拒绝统计");
      duplicates++;
    } else events.set(id, { summary: { run: s.run, policy: s.policy, decision: { status: s.decision.status },
      checks: s.checks.map(({ checkId, status, durationMs }) => ({ checkId, status, durationMs })),
      productions: s.productions }, digest }); // Do not retain complete findings across the time window.
  }
  const groups = new Map();
  const sameInputs = new Map();
  for (const { summary: s } of events.values()) {
    const key = JSON.stringify([s.run.project, s.run.profile]);
    const group = groups.get(key) || { project: s.run.project, profile: s.run.profile, samples: 0,
      decisions: { passed: 0, blocked: 0, invalid: 0 }, durations: [], checks: new Map(),
      sharedProducerCommandRuns: 0, productionEvidenceMissing: 0 };
    group.samples++;
    group.decisions[s.decision.status]++;
    group.durations.push(s.run.durationMs);
    if (Array.isArray(s.productions)) {
      for (const production of s.productions) {
        if (!nonnegative(production.commandRuns)) throw new Error("共享生产次数无效");
        group.sharedProducerCommandRuns = add(group.sharedProducerCommandRuns, production.commandRuns);
      }
    } else group.productionEvidenceMissing++;
    for (const check of s.checks) {
      const metric = group.checks.get(check.checkId) || { checkId: check.checkId, samples: 0, invalid: 0, durations: [] };
      metric.samples++;
      if (check.status === "invalid") metric.invalid++;
      if (typeof check.durationMs === "number" && Number.isFinite(check.durationMs) && check.durationMs >= 0) metric.durations.push(check.durationMs);
      group.checks.set(check.checkId, metric);
    }
    groups.set(key, group);
    if (s.run.sourceDigest && s.policy?.policyHash && s.policy?.ruleSetHash) {
      const input = JSON.stringify([s.run.project, s.run.profile, s.run.scope, s.run.base, s.run.head,
        s.run.commitSha, s.run.sourceDigest, s.run.targetEnv, s.policy.policyHash, s.policy.ruleSetHash, s.policy.baselineHash, s.policy.waiversHash]);
      sameInputs.set(input, (sameInputs.get(input) || 0) + 1);
    }
  }
  let aiUsage = { status: "unavailable", inputTokens: null, outputTokens: null, cachedInputTokens: null };
  if (usageFile) {
    const data = JSON.parse(readFileSync(usageFile, "utf8"));
    if (!Array.isArray(data) || !data.length) throw new Error("usage 必须为非空记录数组，缺失用量不要填零");
    const ids = new Set();
    let input = 0, output = 0, cached = 0, cachedKnown = true;
    for (const u of data) {
      if (!u || typeof u.id !== "string" || !u.id.trim() || ids.has(u.id) || typeof u.source !== "string" || !u.source.trim()
        || !nonnegative(u.inputTokens) || !nonnegative(u.outputTokens)
        || (u.cachedInputTokens != null && (!nonnegative(u.cachedInputTokens) || u.cachedInputTokens > u.inputTokens))) throw new Error("usage 记录缺来源/唯一 id，或 token 口径无效");
      ids.add(u.id); input = add(input, u.inputTokens); output = add(output, u.outputTokens);
      if (u.cachedInputTokens == null) cachedKnown = false; else cached = add(cached, u.cachedInputTokens);
    }
    aiUsage = { status: "supplied-unverified", records: data.length, inputTokens: input, outputTokens: output,
      cachedInputTokens: cachedKnown ? cached : null, totalTokens: add(input, output) };
  }
  return { schema: "wl-quality-cost.v1", displayOnly: true, generatedAt: new Date().toISOString(),
    reports: { files: files.length, uniqueEvents: events.size, duplicateCopies: duplicates },
    sameInputAdditionalRuns: [...sameInputs.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
    sameInputMeaning: "候选重复，可能是必需复验；不能用于跳过门禁。未绑定完整输入的报告不纳入此计数。",
    aiUsage,
    groups: [...groups.values()].map((g) => ({ ...g, durations: undefined,
      observedSharedProducerCommandRuns: g.sharedProducerCommandRuns,
      sharedProducerCommandRuns: g.productionEvidenceMissing ? null : g.sharedProducerCommandRuns,
      p50Ms: p(g.durations, 0.5), p95Ms: p(g.durations, 0.95),
      checks: [...g.checks.values()].map((c) => ({ ...c, durations: undefined,
        durationSamples: c.durations.length, p50Ms: p(c.durations, 0.5), p95Ms: p(c.durations, 0.95) })) })) };
}
