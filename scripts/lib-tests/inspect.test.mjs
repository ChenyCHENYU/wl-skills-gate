import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectReport } from "../../lib/inspect.js";

const cli = fileURLToPath(new URL("../../bin/wl-skills-gate.js", import.meta.url));
function finding(i, extra = {}) {
  return { fingerprint: `fingerprint-${i}`, ruleId: "STYLE/size", severity: "warning", status: "new",
    file: `src/中文目录/File${i}.java`, line: i + 1, message: `建议核实 ${i}`, ...extra };
}
function report(findings = [], extra = {}) {
  return { schemaVersion: 1,
    run: { project: "token-fixture", eventId: "event", profile: "standard", startedAt: "2026-10-12T00:00:00.000Z",
      durationMs: 120, commitSha: "a".repeat(40), tool: "wl-skills-gate@0.5.2", sourceBound: false },
    policy: { enforceWarnings: false }, checks: [{ checkId: "SCAN", status: "ok", durationMs: 110 }],
    findings, decision: { status: "passed", reasons: [] }, ...extra };
}
function fixture(t, value) {
  const dir = mkdtempSync(path.join(tmpdir(), "wl-gate-inspect-"));
  const file = path.join(dir, "quality-summary.json");
  writeFileSync(file, JSON.stringify(value));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file };
}

test("摘要按完整报告计数，明细过滤不能改变阻断结论或漏掉底线", (t) => {
  const findings = [finding(0, { severity: "error", status: "existing" }), finding(1),
    finding(2, { severity: "error", ruleId: "SEC/auth", status: "waived" }), finding(3, { severity: "error", status: "expired" })];
  const { file } = fixture(t, report(findings, { decision: { status: "blocked", reasons: ["风险未处置"] } }));
  const summary = inspectReport(file);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.result.totals.findings, 4);
  assert.equal(summary.result.totals.blocking, 2);
  assert.equal(summary.result.findings.length, 0);
  const filtered = inspectReport(file, { view: "findings", severity: "info" });
  assert.equal(filtered.exitCode, 1);
  assert.equal(filtered.result.decision.status, "blocked");
  assert.equal(filtered.result.page.selectedTotal, 0);
  assert.equal(filtered.result.totals.blocking, 2);
  const all = inspectReport(file, { view: "findings" }).result.findings;
  assert.deepEqual(new Set(all.slice(0, 2).map((f) => f.fingerprint)), new Set(["fingerprint-2", "fingerprint-3"]));
  assert.ok(all.slice(0, 2).every((f) => f.blocking));
});

test("UTF-8 字节预算含换行，长描述裁剪可见，保留精确定位和全量计数", (t) => {
  const findings = Array.from({ length: 500 }, (_, i) => finding(i, { message: "中文风险😀".repeat(2000), suggestion: "处理建议".repeat(300) }));
  const { file } = fixture(t, report(findings));
  const before = readFileSync(file);
  const result = inspectReport(file, { view: "findings", limit: 100, maxBytes: 4096 });
  assert.ok(Buffer.byteLength(result.text) <= 4096);
  assert.equal(result.result.response.bytes, Buffer.byteLength(result.text));
  assert.ok(result.result.page.returned > 0);
  assert.ok(result.result.page.returned < 100);
  assert.equal(result.result.totals.findings, 500);
  assert.equal(result.result.response.detailsTruncated, true);
  assert.equal(result.result.findings[0].file, findings[0].file);
  assert.equal(result.result.findings[0].fingerprint, findings[0].fingerprint);
  assert.ok(result.result.findings[0].message.endsWith("[truncated]"));
  assert.ok(!result.text.includes("�"));
  assert.deepEqual(readFileSync(file), before);
});

test("分页不重跑生产者、无写入，所有问题恰好一次并绑定报告和筛选", (t) => {
  const { file, dir } = fixture(t, report(Array.from({ length: 47 }, (_, i) => finding(i))));
  const source = readFileSync(file);
  const names = readdirSync(dir);
  const seen = [];
  let cursor;
  do {
    const r = inspectReport(file, { view: "findings", limit: 7, maxBytes: 4096, cursor });
    assert.ok(Buffer.byteLength(r.text) <= 4096);
    seen.push(...r.result.findings.map((f) => f.fingerprint));
    cursor = r.result.page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 47);
  assert.equal(new Set(seen).size, 47);
  assert.deepEqual(readdirSync(dir), names);
  assert.deepEqual(readFileSync(file), source);
  cursor = inspectReport(file, { view: "findings", limit: 1 }).result.page.nextCursor;
  assert.throws(() => inspectReport(file, { view: "findings", cursor, status: "existing" }), /筛选条件已变化/);
  writeFileSync(file, `${source}\n`);
  assert.throws(() => inspectReport(file, { view: "findings", cursor }), /报告或筛选条件已变化/);
});

test("invalid 的工具诊断保留并脱敏；视图成功不能伪装检查通过", (t) => {
  const reason = "analysis failed token=super-secret password=private-pass";
  const { file } = fixture(t, report([], { checks: [{ checkId: "BROKEN", status: "invalid", reason }],
    decision: { status: "invalid", reasons: [reason] } }));
  const r = inspectReport(file);
  assert.equal(r.exitCode, 2);
  assert.equal(r.result.displayOnly, true);
  assert.equal(r.result.decision.status, "invalid");
  assert.equal(r.result.checks.byStatus.invalid, 1);
  assert.equal(r.result.checks.items[0].checkId, "BROKEN");
  assert.ok(!r.text.includes("super-secret"));
  assert.ok(!r.text.includes("private-pass"));
  assert.ok(r.text.includes("[REDACTED]"));
});

test("超出摘要预算的检查/原因明确记为省略，结论保持原样", (t) => {
  const { file } = fixture(t, report([], { checks: Array.from({ length: 20 }, (_, i) => ({ checkId: `C${i}`, status: "invalid", reason: "原因".repeat(500) })),
    decision: { status: "invalid", reasons: Array(20).fill("详细原因".repeat(500)) } }));
  const r = inspectReport(file, { maxBytes: 4096 });
  assert.ok(Buffer.byteLength(r.text) <= 4096);
  assert.equal(r.result.checks.items.length + r.result.checks.omitted, 20);
  assert.equal(r.result.decision.reasons.length + r.result.decision.reasonsOmitted, 20);
  assert.equal(r.result.checks.byStatus.invalid, 20);
  assert.equal(r.exitCode, 2);
});

test("未知参数、坏报告、非法预算/游标及不可容纳项均明确失败", (t) => {
  const { file } = fixture(t, report([finding(0)]));
  for (const options of [{ view: "full" }, { severity: "debug" }, { status: "fixed" }, { rule: " " },
    { maxBytes: 200 }, { maxBytes: 65537 }, { limit: 0 }, { limit: 1.5 }, { limit: 101 },
    { cursor: "bad" }, { view: "findings", cursor: "!!!" }, { view: "findings", cursor: "e30" }]) {
    assert.throws(() => inspectReport(file, options));
  }
  let r = spawnSync(process.execPath, [cli, "inspect", file, "--limit", "1", "--limit", "2"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /重复参数/);
  r = spawnSync(process.execPath, [cli, "inspect", file, "--unknown", "value"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  writeFileSync(file, JSON.stringify(report([finding(0, { file: "x".repeat(80000) })])));
  assert.throws(() => inspectReport(file, { view: "findings" }), /单项定位信息超出/);
  writeFileSync(file, JSON.stringify({ decision: { status: "passed", reasons: [] } }));
  assert.throws(() => inspectReport(file), /报告结构无效/);
  writeFileSync(file, "{bad}");
  assert.throws(() => inspectReport(file), /无法解析/);
  writeFileSync(file, Buffer.from([0x7b, 0xff, 0x7d]));
  assert.throws(() => inspectReport(file), /UTF-8/);
});

test("真实 CLI 输出机器摘要并保留 passed/blocked/invalid 退出码，规则查询不改原件", (t) => {
  const { file } = fixture(t, report([finding(0), finding(1, { ruleId: "STYLE/other" })]));
  for (const [status, expected] of [["passed", 0], ["blocked", 1], ["invalid", 2]]) {
    writeFileSync(file, JSON.stringify(report([finding(0), finding(1, { ruleId: "STYLE/other" })], { decision: { status, reasons: [] } })));
    const source = readFileSync(file);
    const r = spawnSync(process.execPath, [cli, "inspect", file, "--view", "findings", "--rule", "STYLE/other"], { encoding: "utf8" });
    assert.equal(r.status, expected, r.stderr);
    const value = JSON.parse(r.stdout);
    assert.equal(value.decision.status, status);
    assert.equal(value.page.selectedTotal, 1);
    assert.equal(value.totals.findings, 2);
    assert.equal(value.findings[0].ruleId, "STYLE/other");
    assert.equal(value.response.bytes, Buffer.byteLength(r.stdout));
    assert.deepEqual(readFileSync(file), source);
  }
});
