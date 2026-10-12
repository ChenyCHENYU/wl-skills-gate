import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYamlLite, YamlLiteError } from "../../lib/yaml-lite.js";

test("流式数组 + 行内注释正确剥离", () => {
  assert.deepEqual(parseYamlLite("p: [a, b] # 注释\n"), { p: ["a", "b"] });
  assert.deepEqual(parseYamlLite("p: [fast, standard, release]   # 说明"), { p: ["fast", "standard", "release"] });
});

test("重复键直接报错", () => {
  assert.throws(() => parseYamlLite("p: a\np: b\n"), YamlLiteError);
  assert.throws(() => parseYamlLite("checks:\n  - id: A\n    id: B\n"), YamlLiteError);
});

test("行内注释剥离且值内井号保留", () => {
  assert.equal(parseYamlLite("reason: 演示豁免 # 审批中\n").reason, "演示豁免");
  assert.equal(parseYamlLite("path: src/#anchor.vue\n").path, "src/#anchor.vue");
});

test("引号字符串与布尔/null", () => {
  assert.equal(parseYamlLite('o: "409322"\n').o, "409322");
  assert.equal(parseYamlLite("a: true\n").a, true);
  assert.equal(parseYamlLite("n: null\n").n, null);
});

test("顶层列表与嵌套字段", () => {
  const out = parseYamlLite("- id: W1\n  reason: r\n  expiresAt: 2099-01-01\n");
  assert.equal(out[0].id, "W1");
  assert.equal(out[0].expiresAt, "2099-01-01");
});

test("Tab 缩进报错", () => {
  assert.throws(() => parseYamlLite("a:\n\tb: 1\n"), YamlLiteError);
});
