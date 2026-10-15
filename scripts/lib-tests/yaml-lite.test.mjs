import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYamlLite, YamlLiteError } from "../../lib/yaml-lite.js";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../lib/config.js";

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

test("明确十进制整数解析且引号/日期保留字符串，超安全范围拒绝", () => {
  assert.deepEqual(parseYamlLite('timeoutMs: 600000\nquoted: "600000"\nzero: 0\nnegative: -2\nlist: [0, 1, 600000]\ndate: 2099-01-01\n'), {
    timeoutMs: 600000, quoted: "600000", zero: 0, negative: -2, list: [0, 1, 600000], date: "2099-01-01",
  });
  assert.throws(() => parseYamlLite("timeoutMs: 9007199254740993\n"), /安全范围/);
});

test("文档 Java 共享生产模板timeoutMs经loadConfig真实解析为整数", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-yaml-template-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "quality"));
  const snippet = readFileSync(new URL("../../templates/quality/java-static-checks.yml", import.meta.url), "utf8");
  writeFileSync(path.join(root, "quality/policy.yml"), `schemaVersion: 1\nproject: yaml-template\n${snippet}`);
  const config = loadConfig(root);
  assert.equal(config.policy.checks.length, 3);
  assert.ok(config.policy.checks.every((c) => c.timeoutMs === 600000 && Number.isInteger(c.timeoutMs)));
});
