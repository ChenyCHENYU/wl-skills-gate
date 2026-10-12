import { test } from "node:test";
import assert from "node:assert/strict";
import { findingFingerprint } from "../../lib/fingerprint.js";

test("同输入指纹确定一致", () => {
  const f = { ruleId: "R1", file: "src/a.ts", message: "m" };
  assert.equal(findingFingerprint("p", f), findingFingerprint("p", f));
});

test("不同项目/规则/文件/消息产生不同指纹", () => {
  const f = { ruleId: "R1", file: "src/a.ts", message: "m" };
  assert.notEqual(findingFingerprint("p1", f), findingFingerprint("p2", f));
  assert.notEqual(findingFingerprint("p", { ...f, ruleId: "R2" }), findingFingerprint("p", f));
  assert.notEqual(findingFingerprint("p", { ...f, file: "src/b.ts" }), findingFingerprint("p", f));
});

test("提供 context 时行号变化不产生新指纹（稳定口径）", () => {
  const base = { ruleId: "R1", file: "src/a.ts", context: "Foo#bar" };
  const a = findingFingerprint("p", { ...base, line: 10, message: "x" });
  const b = findingFingerprint("p", { ...base, line: 99, message: "x" });
  assert.equal(a, b);
});

test("无 context 时按消息区分，行号不参与", () => {
  const a = findingFingerprint("p", { ruleId: "R1", file: "src/a.ts", line: 1, message: "same" });
  const b = findingFingerprint("p", { ruleId: "R1", file: "src/a.ts", line: 2, message: "same" });
  assert.equal(a, b);
  const c = findingFingerprint("p", { ruleId: "R1", file: "src/a.ts", line: 1, message: "other" });
  assert.notEqual(a, c);
});
