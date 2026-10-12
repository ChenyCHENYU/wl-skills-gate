import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectCost } from "../../lib/cost.js";

const cli = fileURLToPath(new URL("../../bin/wl-skills-gate.js", import.meta.url));
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wl-gate-cost-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, "quality-summary.json"), JSON.stringify(value));
  };
  return { dir, write };
}
function report(id, duration, status = "passed") {
  return { schemaVersion: 1,
    run: { eventId: id, project: "cost-fixture", profile: "standard", startedAt: "2026-10-12T00:00:00Z",
      durationMs: duration, commitSha: "a".repeat(40), tool: "wl-skills-gate@0.5.2", sourceDigest: "source" },
    policy: { policyHash: "policy", ruleSetHash: "rules" },
    checks: [{ checkId: "BE-STATIC", status: status === "invalid" ? "invalid" : "ok", durationMs: duration - 1 }],
    productions: [{ producer: "JAVA", commandRuns: 1 }], findings: [], decision: { status, reasons: [] } };
}

test("离线去重、分项目档位统计分位耗时，未知 token 保持 null", (t) => {
  const { dir, write } = setup(t);
  write("one", report("one", 100)); write("copy", report("one", 100));
  write("two", report("two", 200, "blocked")); write("three", report("three", 300, "invalid"));
  const metrics = collectCost(dir);
  assert.deepEqual(metrics.reports, { files: 4, uniqueEvents: 3, duplicateCopies: 1 });
  assert.equal(metrics.displayOnly, true);
  assert.equal(metrics.groups[0].p50Ms, 200); assert.equal(metrics.groups[0].p95Ms, 300);
  assert.deepEqual(metrics.groups[0].decisions, { passed: 1, blocked: 1, invalid: 1 });
  assert.equal(metrics.groups[0].sharedProducerCommandRuns, 3);
  assert.equal(metrics.groups[0].checks[0].invalid, 1);
  assert.equal(metrics.sameInputAdditionalRuns, 2);
  assert.equal(metrics.aiUsage.status, "unavailable"); assert.equal(metrics.aiUsage.inputTokens, null);
});

test("不同项目独立统计，旧报告缺生产证据和输入绑定时不推断零次或重复", (t) => {
  const { dir, write } = setup(t);
  const old = report("old", 50); delete old.productions; delete old.run.sourceDigest; delete old.checks[0].durationMs;
  const other = report("other", 80); other.run.project = "other"; other.run.profile = "fast";
  write("old", old); write("other", other);
  const metrics = collectCost(dir);
  const legacy = metrics.groups.find((g) => g.project === "cost-fixture");
  assert.equal(metrics.groups.length, 2); assert.equal(legacy.productionEvidenceMissing, 1);
  assert.equal(legacy.sharedProducerCommandRuns, null);
  assert.equal(legacy.checks[0].durationSamples, 0); assert.equal(legacy.checks[0].p50Ms, null);
  assert.equal(metrics.sameInputAdditionalRuns, 0);
});

test("宿主导出用量严格校验来源、去重和计数口径，缓存 token 不重复加总", (t) => {
  const { dir, write } = setup(t); write("one", report("one", 10));
  const usageFile = path.join(dir, "usage.json");
  const records = [{ id: "request-1", source: "fixture-unverified", inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 }];
  writeFileSync(usageFile, JSON.stringify(records));
  let usage = collectCost(dir, { usageFile }).aiUsage;
  assert.equal(usage.status, "supplied-unverified"); assert.equal(usage.totalTokens, 120); assert.equal(usage.cachedInputTokens, 50);
  records.push({ id: "request-2", source: "fixture-unverified", inputTokens: 10, outputTokens: 5 });
  writeFileSync(usageFile, JSON.stringify(records));
  assert.equal(collectCost(dir, { usageFile }).aiUsage.cachedInputTokens, null);
  for (const invalid of [[], [...records, records[0]], [{ ...records[0], source: "" }],
    [{ ...records[0], inputTokens: -1 }], [{ ...records[0], cachedInputTokens: 101 }],
    [{ ...records[0], inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }]]) {
    writeFileSync(usageFile, JSON.stringify(invalid));
    assert.throws(() => collectCost(dir, { usageFile }));
  }
});

test("空输入、冲突事件、坏报告、符号链接明确失败，CLI 只输出工件路径", (t) => {
  const { dir, write } = setup(t);
  assert.throws(() => collectCost(dir), /零成本/);
  write("one", report("one", 10)); write("conflict", report("one", 11));
  assert.throws(() => collectCost(dir), /冲突/);
  rmSync(path.join(dir, "conflict"), { recursive: true });
  const out = path.join(dir, "metrics.json");
  const result = spawnSync(process.execPath, [cli, "cost", dir, "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), `[cost] 已写入 ${out}`);
  assert.equal(JSON.parse(readFileSync(out)).reports.uniqueEvents, 1);
  const original = readFileSync(path.join(dir, "one/quality-summary.json"));
  const overwrite = spawnSync(process.execPath, [cli, "cost", dir, "--out", path.join(dir, "one/quality-summary.json")], { encoding: "utf8" });
  assert.equal(overwrite.status, 2); assert.deepEqual(readFileSync(path.join(dir, "one/quality-summary.json")), original);
  write("view", { ...report("view", 10), displayOnly: true }); assert.throws(() => collectCost(dir), /无效/);
  rmSync(path.join(dir, "view"), { recursive: true });
  write("bad", {}); assert.throws(() => collectCost(dir), /无效/);
  rmSync(path.join(dir, "bad"), { recursive: true });
  symlinkSync(path.join(dir, "one"), path.join(dir, "link"));
  assert.throws(() => collectCost(dir), /符号链接/);
});
