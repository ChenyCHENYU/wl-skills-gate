import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, realpathSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { planOnboarding, applyOnboarding } from "../../lib/onboard.js";
import { runGate } from "../../lib/run.js";
import { produceReviewFacts } from "../../lib/review-facts.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const put = (root, file, value) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
};
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-onboard-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q"); git(root, "config", "user.name", "fixture"); git(root, "config", "user.email", "fixture@example.invalid");
  put(root, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><artifactId>fixture</artifactId></project>\n");
  put(root, "wl-produce-pl/wl-produce-pl-service/pom.xml", "<project><artifactId>wl-produce-pl-service</artifactId></project>\n");
  git(root, "add", "."); git(root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "chore(quality): 初始化接入-隔离证据链测试");
  return root;
}
const apply = (options, plan = planOnboarding(options)) => applyOnboarding({ ...options, planHash: plan.planHash, confirm: true });

test("后端接入从纳入批准计划的必需JUnit自动生成Review测试范围，重跑保持幂等", (t) => {
  const root = fixture(t), plan = planOnboarding({ root });
  const evidencePlan = JSON.parse(plan.files.find((file) => file.path === "quality/review-evidence.plan.json").afterContent);
  assert.deepEqual(evidencePlan.requiredTestCheckIds, ["BE-PL-UNIT"]);
  assert.equal(evidencePlan.project, "wl-produce");
  assert.equal(existsSync(path.join(root, "quality")), false);
  apply({ root }, plan);
  const second = planOnboarding({ root });
  assert.equal(second.files.find((file) => file.path === "quality/review-evidence.plan.json").action, "unchanged");
});

test("已有自有Review证据计划原字节及必测范围保持，不静默扩写或覆盖", (t) => {
  const root = fixture(t), custom = '{\n "schemaVersion": 1, "project": "wl-produce", "requiredTestCheckIds": ["BUSINESS-CONTRACT"], "evidence": []\n}\n';
  put(root, "quality/review-evidence.plan.json", custom);
  const plan = planOnboarding({ root });
  assert.equal(plan.hardConflicts.length, 0);
  assert.equal(plan.files.find((file) => file.path === "quality/review-evidence.plan.json").action, "unchanged");
  apply({ root }, plan);
  assert.equal(readFileSync(path.join(root, "quality/review-evidence.plan.json"), "utf8"), custom);
});

test("真实接入→Gate运行JUnit生产器→事实生产自动带入必测范围和原始报告", async (t) => {
  const root = fixture(t), assetRoot = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wl-onboard-facts-assets-"));
  t.after(() => rmSync(assetRoot, { recursive: true, force: true }));
  cpSync(path.join(PACKAGE_ROOT, "templates/onboarding"), assetRoot, { recursive: true });
  put(assetRoot, "backend/policy.yml", `schemaVersion: 1
project: wl-produce
releaseRequires: [ACTUAL-UNIT]
checks:
  - id: ACTUAL-UNIT
    tool: junit
    command: node scripts/produce-test.mjs
    files: [quality-reports/junit/TEST-actual.xml]
    reportDirs: [quality-reports/junit]
    requiredSuites: [fixture.ActualSuite]
    requiredTests: [fixture.ActualSuite#actual-case]
    versionCommand: node --version
    profiles: [standard, release]
`);
  const xml = '<testsuite name="fixture.ActualSuite" tests="1" failures="0" errors="0" skipped="0"><testcase classname="fixture.ActualSuite" name="actual-case"/></testsuite>\n';
  put(root, "scripts/produce-test.mjs", `import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('quality-reports/junit', { recursive: true });\nwriteFileSync('quality-reports/junit/TEST-actual.xml', ${JSON.stringify(xml)});\n`);
  apply({ root, assetRoot });
  put(root, "quality/rules.lock.json", { lockVersion: 1, "wl-skills-gate": JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"))).version, tools: { "ACTUAL-UNIT": process.version } });
  git(root, "add", "."); git(root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "chore(quality): 批准接入-真实生产器接线");
  const base = git(root, "rev-parse", "HEAD");
  put(root, "business.txt", "real candidate\n"); git(root, "add", "."); git(root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fix(quality): 修复业务-验证自动事实生产");
  const sha = git(root, "rev-parse", "HEAD"), result = await runGate({ argv: ["--root", root, "--sha", sha] });
  assert.equal(result.exitCode, 0, JSON.stringify(result.summary.checks));
  const produced = produceReviewFacts({ root, summaryFile: "quality-reports/quality-summary.json", planFile: "quality/review-evidence.plan.json", outDir: "quality-reports/review", baseSha: base });
  const tests = JSON.parse(readFileSync(path.join(produced.evidenceRoot, "tests.json")));
  assert.deepEqual(tests.requiredTestCheckIds, ["ACTUAL-UNIT"]);
  assert.equal(tests.checks[0].production.eventId, result.summary.run.eventId);
  assert.equal(tests.checks[0].testEvidence.requiredTests[0].passed, true);
  const raw = Buffer.from(tests.originals[0].rawBytesBase64, "base64");
  assert.equal(raw.toString(), xml);
  assert.equal(createHash("sha256").update(raw).digest("hex"), tests.originals[0].sha256);
  assert.equal(produced.missingEvidence.some((item) => item.type === "test-verification"), false);
  assert.equal(tests.businessAcceptance, "pending-independent-review");
  assert.equal(existsSync(path.join(produced.evidenceRoot, "ui.json")), false);
});
