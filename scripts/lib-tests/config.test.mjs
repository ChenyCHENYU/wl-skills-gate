import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../../lib/config.js";

function mkroot(policyText, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-cfg-"));
  mkdirSync(path.join(root, "quality"), { recursive: true });
  writeFileSync(path.join(root, "quality", "policy.yml"), policyText);
  for (const [file, content] of Object.entries(extra)) {
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

const goodPolicy = `schemaVersion: 1
project: t
checks:
  - id: RAW
    tool: raw-json
    profiles: [standard]
    file: inputs/r.json
`;

test("缺 policy 失败关闭", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-cfg-"));
  assert.throws(() => loadConfig(root), ConfigError);
});

test("缺 project / 未知工具 / 重复 id 报错", () => {
  assert.throws(() => loadConfig(mkroot("schemaVersion: 1\nchecks:\n  - id: R\n    tool: raw-json\n    profiles: [standard]\n")), (e) =>
    e.message.includes("project")
  );
  assert.throws(
    () => loadConfig(mkroot("schemaVersion: 1\nproject: t\nchecks:\n  - id: R\n    tool: nope\n    profiles: [standard]\n")),
    (e) => e.message.includes("未注册工具")
  );
  assert.throws(
    () =>
      loadConfig(
        mkroot(
          "schemaVersion: 1\nproject: t\nchecks:\n  - id: R\n    tool: raw-json\n    profiles: [standard]\n    file: a.json\n  - id: R\n    tool: raw-json\n    profiles: [standard]\n    file: b.json\n"
        )
      ),
    (e) => e.message.includes("重复")
  );
});

test("required:false 缺 naReason 报错，带则通过", () => {
  const without = `schemaVersion: 1
project: t
checks:
  - id: R
    tool: raw-json
    profiles: [standard]
    file: a.json
    required: false
`;
  assert.throws(() => loadConfig(mkroot(without)), (e) => e.message.includes("naReason"));
  const withReason = without + "    naReason: 演示登记\n";
  assert.doesNotThrow(() => loadConfig(mkroot(withReason)));
});

test("releaseRequires 引用未声明检查报错；合法值通过", () => {
  const bad = goodPolicy.replace("project: t", "project: t\nreleaseRequires: [NOT-DECLARED]");
  assert.throws(() => loadConfig(mkroot(bad)), (e) => e.message.includes("releaseRequires"));
  const ok = goodPolicy.replace("project: t", "project: t\nreleaseRequires: [RAW]");
  assert.doesNotThrow(() => loadConfig(mkroot(ok)));
});

test("blockerWaivers 非法值报错；enforceWarnings 字符串强转", () => {
  assert.throws(() => loadConfig(mkroot(goodPolicy.replace("project: t", "project: t\nblockerWaivers: yes"))), (e) =>
    e.message.includes("blockerWaivers")
  );
  const cfg = loadConfig(mkroot(goodPolicy.replace("project: t", 'project: t\nenforceWarnings: "true"')));
  assert.equal(cfg.policy.enforceWarnings, true);
});

test("waivers 无效记录按索引标记，不连坐同 id", () => {
  const waivers = `- id: WA
  ruleId: R
  reason: x
  owner: "1"
  expiresAt: "2099-01-01"
- id: WA
  ruleId: R2
  reason: y
  owner: "1"
  approver: "2"
  expiresAt: "2099-01-01"
`;
  const cfg = loadConfig(mkroot(goodPolicy, { "quality/waivers.yml": waivers }));
  assert.equal(cfg.invalidWaivers.length, 1);
  assert.equal(cfg.waivers.length, 1);
});

test("结束后清理临时目录", () => {
  const root = mkroot(goodPolicy);
  assert.doesNotThrow(() => loadConfig(root));
  rmSync(root, { recursive: true, force: true });
});
