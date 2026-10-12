import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSummaryAgainstSchema, DEFAULT_SCHEMA_FILE } from "../../lib/validate-report.js";
import { readJson } from "../../lib/util.js";

const schema = readJson(DEFAULT_SCHEMA_FILE);

const validSummary = {
  schemaVersion: 1,
  run: { project: "t", profile: "standard", startedAt: "x", durationMs: 1, commitSha: "s", tool: "t", eventId: "e" },
  checks: [{ checkId: "C1", status: "ok" }],
  findings: [{ fingerprint: "f", ruleId: "R", severity: "error", file: "a.ts", status: "new" }],
  decision: { status: "passed", reasons: [] },
};

test("合法 summary 零错误", () => {
  assert.deepEqual(validateSummaryAgainstSchema(validSummary, schema), []);
});

test("decision 枚举与必填字段校验", () => {
  const bad = JSON.parse(JSON.stringify(validSummary));
  bad.decision.status = "green";
  const errs = validateSummaryAgainstSchema(bad, schema);
  assert.ok(errs.some((e) => e.includes("不在枚举")));
  const missing = JSON.parse(JSON.stringify(validSummary));
  delete missing.decision;
  assert.ok(validateSummaryAgainstSchema(missing, schema).some((e) => e.includes("缺少必填字段")));
});

test("schemaVersion const 与 findings 嵌套校验", () => {
  const bad = JSON.parse(JSON.stringify(validSummary));
  bad.schemaVersion = 2;
  assert.ok(validateSummaryAgainstSchema(bad, schema).some((e) => e.includes("const")));
  const f = JSON.parse(JSON.stringify(validSummary));
  f.findings[0].severity = "fatal";
  assert.ok(validateSummaryAgainstSchema(f, schema).some((e) => e.includes("severity")));
});
