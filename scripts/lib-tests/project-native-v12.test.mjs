import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../../lib/adapters/project.js";
import { sha256 } from "../../lib/util.js";
import { planOnboarding, applyOnboarding } from "../../lib/onboard.js";
import { loadConfig } from "../../lib/config.js";
const put = (root, file, data) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
};
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-project-native-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const ctx = (root) => ({ root, eventId: "real-node", project: "fixture", commitSha: "unknown" });
test("项目真实Node测试的失败、跳过、零用例均不能冒充通过；计划修改失效", async (t) => {
  const root = fixture(t),
    plan = { schemaVersion: 1, testFiles: ["a.test.mjs"] };
  put(root, "quality/tests.json", plan);
  const check = {
    id: "TESTS",
    tool: "node-tests",
    plan: "quality/tests.json",
    planHash: sha256(readFileSync(path.join(root, "quality/tests.json"))),
  };
  for (const [body, rule] of [
    ['import test from "node:test";test("actual",()=>{});', null],
    ['import test from "node:test";test("actual",()=>{throw Error("bad")});', "JUNIT/FAILED"],
    ['import test from "node:test";test.skip("actual",()=>{});', "JUNIT/SKIPPED"],
    ["", "JUNIT/ZERO-TESTS"],
  ]) {
    put(root, "a.test.mjs", body);
    const result = await run(check, ctx(root));
    assert.equal(result.status, "ok", result.reason);
    if (rule)
      assert.ok(
        result.findings.some((f) => f.ruleId === rule),
        JSON.stringify(result)
      );
    else {
      assert.equal(result.findings.length, 0);
      assert.equal(result.testEvidence.counts.passed, 1);
    }
  }
  put(root, "quality/tests.json", { ...plan, testFiles: ["other.mjs"] });
  assert.equal((await run(check, ctx(root))).status, "invalid");
});
test("复合业务作业只运行一次Node测试，其他断言执行并保留日志；脚本漂移拒绝", async (t) => {
  const root = fixture(t),
    script = "node contract.mjs && node --test a.test.mjs";
  put(root, "package.json", { scripts: { "validate:steelmaking": script } });
  put(root, "contract.mjs", 'import {writeFileSync} from "node:fs";writeFileSync("contract-ran","yes");');
  put(root, "a.test.mjs", 'throw Error("must run only in paired Node check");');
  put(root, "quality/tests.json", { schemaVersion: 1, testFiles: ["a.test.mjs"] });
  const check = {
    id: "CONTRACT",
    tool: "project-script",
    script: "validate:steelmaking",
    scriptHash: sha256(script),
    omitNodeTests: true,
    nodeTestPlan: "quality/tests.json",
  };
  const result = await run(check, ctx(root));
  assert.equal(result.status, "ok", result.reason);
  assert.equal(result.findings.length, 0);
  assert.equal(readFileSync(path.join(root, "contract-ran"), "utf8"), "yes");
  assert.ok(result.production.reports.length);
  put(root, "package.json", { scripts: { "validate:steelmaking": "node contract.mjs" } });
  assert.equal((await run(check, ctx(root))).status, "invalid");
});
test("首次接入自动纳入既有业务作业；已接0.11预设批准后升级且保留自定义检查", (t) => {
  const root = fixture(t),
    git = (...args) =>
      execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "fixture");
  git("config", "user.email", "fixture@example.invalid");
  put(root, "package.json", {
    name: "fixture",
    packageManager: "pnpm@10.34.5",
    dependencies: { vue: "3" },
    devDependencies: { "@agile-team/wl-skills-kit": "2.33.1" },
    scripts: {
      "validate:deps": "node deps.mjs",
      "validate:steelmaking": "node contract.mjs && node --test a.test.mjs",
    },
  });
  put(root, "a.test.mjs", 'import test from "node:test";test("actual",()=>{});');
  put(root, "contract.mjs", "");
  put(root, "deps.mjs", "");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "seed");
  const apply = (options) => {
    const plan = planOnboarding(options);
    assert.equal(plan.hardConflicts.length, 0, JSON.stringify(plan.hardConflicts));
    return applyOnboarding({ ...options, planHash: plan.planHash, confirm: true });
  };
  apply({ root, registry: "https://registry.example.invalid/" });
  let policy = loadConfig(root).policy;
  assert.equal(policy.checks.length, 14);
  assert.ok(policy.checks.some((c) => c.tool === "node-tests"));
  const preset = JSON.parse(readFileSync(new URL("../../assets/quality-preset-0.11.json", import.meta.url))).frontend;
  preset.project = "fixture";
  preset.checks.push({
    id: "CUSTOM",
    tool: "typecheck",
    bin: "node",
    args: "--version",
    versionCommand: "node --version",
    profiles: ["standard", "release"],
  });
  preset.releaseRequires.push("CUSTOM");
  put(root, "quality/policy.yml", preset);
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "approved adopted config");
  const plan = planOnboarding({ root, registry: "https://registry.example.invalid/", allowDependencyUpdates: true });
  assert.equal(plan.hardConflicts.length, 0, JSON.stringify(plan.hardConflicts));
  assert.ok(plan.legacyMigrations.some((m) => m.kind === "approved-complete-detector-preset-upgrade"));
  applyOnboarding({
    root,
    registry: "https://registry.example.invalid/",
    allowDependencyUpdates: true,
    planHash: plan.planHash,
    confirm: true,
  });
  policy = loadConfig(root).policy;
  assert.equal(policy.checks.length, 15);
  assert.ok(policy.checks.some((c) => c.id === "CUSTOM"));
  assert.ok(policy.checks.some((c) => c.id === "FE-BUSINESS-TESTS"));
});
