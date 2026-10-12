import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runGate } from "../../lib/run.js";
import { loadConfig } from "../../lib/config.js";
import { collect } from "../../lib/collect.js";
import { findingFingerprint } from "../../lib/fingerprint.js";
import { buildFixPlan, applyFixPlan } from "../../lib/fix.js";
import { verifyArtifact } from "../../lib/verify-artifact.js";
import { createArtifactManifest, signGateProof, verifyProof, signRecord } from "../../lib/evidence.js";
import { git } from "../../lib/source-state.js";
import { sha256 } from "../../lib/util.js";
import { validateCommitMessage } from "../../lib/commit-message.js";
import { runCommand } from "../../lib/exec.js";
import { applyPromotion } from "../../lib/promote.js";
import * as junit from "../../lib/adapters/junit.js";

const gateVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

function fixture(t, checks, files = {}, policy = {}, withGit = false) {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-hardening-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = { "quality/policy.json": JSON.stringify({ schemaVersion: 1, project: "hardening", checks, ...policy }),
    ".gitignore": "quality-reports/\nnode_modules/\ntarget/\ndist/\n", ...files };
  for (const [p, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), typeof content === "string" ? content : JSON.stringify(content));
  }
  if (withGit) {
    git(["init", "-q"], root);
    git(["add", "-A"], root);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], root);
  }
  return root;
}

const raw = { id: "RAW", tool: "raw-json", profiles: ["standard"], file: "input.json" };
const finding = { ruleId: "DEMO/R", severity: "error", file: "src.txt", message: "bad", context: "read" };
const scan = { id: "SCAN", tool: "cmd-json", profiles: ["standard", "release"], command: "node scan.mjs", versionCommand: "node --version" };
const scanFiles = { "scan.mjs": `console.log(JSON.stringify({toolVersion:'scanner@1',findings:[]}));`,
  "quality/rules.lock.json": { lockVersion: 1, "wl-skills-gate": gateVersion, tools: { SCAN: process.version } }, "src.txt": "source" };

test("blocker、类型、关键测试失败不能放入基线或豁免", () => {
  for (const f of [{ ...finding, severity: "blocker" }, { ...finding, ruleId: "TS/TYPEERROR" }, { ...finding, ruleId: "JUNIT/FAILED" }]) {
    const r = collect({ project: "p", findings: [f], baselineItems: [{ fingerprint: findingFingerprint("p", f) }],
      waivers: [{ id: "W", ruleId: f.ruleId, expiresAt: "2099-01-01" }] });
    assert.equal(r.counts.blockingNew, 1);
    assert.equal(r.findings[0].status, "new");
  }
});

test("同指纹按最高风险合并，与输入顺序无关", () => {
  for (const severities of [["warning", "blocker"], ["blocker", "warning"]]) {
    const r = collect({ project: "p", findings: severities.map((severity) => ({ ...finding, severity })) });
    assert.equal(r.findings[0].severity, "blocker");
    assert.equal(r.counts.blockingNew, 1);
  }
});

test("历史问题扩张或严重程度升高时重新阻断", () => {
  const b = { fingerprint: findingFingerprint("p", finding), severity: "warning", occurrenceCount: 1 };
  assert.equal(collect({ project: "p", findings: [{ ...finding }], baselineItems: [b] }).counts.blockingNew, 1);
  b.severity = "error";
  assert.equal(collect({ project: "p", findings: [{ ...finding }, { ...finding, line: 2 }], baselineItems: [b] }).counts.blockingNew, 1);
});

test("增量扫描不能标记未出现的历史问题已修复", () => {
  const b = [{ fingerprint: "missing" }];
  assert.deepEqual(collect({ project: "p", findings: [], baselineItems: b }).baselineResolvedPending, []);
  assert.deepEqual(collect({ project: "p", findings: [], baselineItems: b, fullScan: true }).baselineResolvedPending, ["missing"]);
});

test("自批豁免无效；非数组豁免失败关闭", (t) => {
  const root = fixture(t, [raw], { "input.json": { findings: [] }, "quality/waivers.json": [{ id: "W", ruleId: "R", owner: "a", approver: "a", reason: "r", expiresAt: "2099-01-01" }] });
  assert.equal(loadConfig(root).waivers.length, 0);
  assert.match(loadConfig(root).invalidWaivers[0].reason, /不能相同/);
  writeFileSync(path.join(root, "quality/waivers.json"), "{}");
  assert.throws(() => loadConfig(root), /数组/);
});

test("类型/测试检查不能降为可选，blocker allow 配置被拒绝", (t) => {
  for (const tool of ["typecheck", "junit"]) {
    assert.throws(() => loadConfig(fixture(t, [{ id: "C", tool, profiles: ["standard"], required: false, naReason: "skip" }])), /不得降级/);
  }
  assert.throws(() => loadConfig(fixture(t, [raw], {}, { blockerWaivers: "allow" })), /只允许 reject/);
});

for (const [name, xml, status] of [
  ["关键测试跳过", '<testsuite tests="1"><testcase name="core"><skipped/></testcase></testsuite>', "blocked"],
  ["截断 XML", '<testsuite tests="1" failures="1">', "invalid"],
  ["声明失败但没有用例", '<testsuite tests="1" failures="1"></testsuite>', "invalid"],
  ["零用例", '<testsuite tests="0"/>', "blocked"],
  ["嵌套套件和单引号属性", "<testsuites tests='1'><testsuite tests='1'><testcase name='ok'/></testsuite></testsuites>", "passed"],
  ["未知实体", '<testsuite><testcase name="&unknown;"/></testsuite>', "invalid"],
  ["多个根", '<testsuite/><testsuite/>', "invalid"],
  ["DTD", '<!DOCTYPE testsuite [<!ENTITY x "ok">]><testsuite/>', "invalid"],
]) test(`JUnit：${name}`, async (t) => {
  const root = fixture(t, [{ id: "TEST", tool: "junit", profiles: ["standard"], file: "input.xml" }], { "input.xml": xml });
  assert.equal((await runGate({ argv: ["--root", root] })).summary.decision.status, status);
});

test("JUnit 必测场景不能用其他通过用例充数", async (t) => {
  const root = fixture(t, [], { "input.xml": '<testsuite><testcase name="other" classname="Core"/></testsuite>' });
  const r = await junit.run({ file: "input.xml", requiredTests: ["Core#required"] }, { root, project: "p" });
  assert.ok(r.findings.some((f) => f.ruleId === "JUNIT/REQUIRED-NOT-PASSED"));
});

test("旧空报告加命令失败不得放行", async (t) => {
  const root = fixture(t, [{ id: "CMD", tool: "cmd-json", profiles: ["standard"], command: "exit 1", file: "quality-reports/old.json", okExitCodes: [0, 1] }], { "quality-reports/old.json": { findings: [] } });
  assert.equal((await runGate({ argv: ["--root", root] })).exitCode, 2);
  assert.equal(existsSync(path.join(root, "quality-reports/old.json")), false);
});

test("stdout 空报告与非零退出不一致时拒绝", async (t) => {
  const root = fixture(t, [{ ...scan, command: `node -e 'console.log(JSON.stringify({findings:[]}));process.exit(1)'`, okExitCodes: [0, 1] }]);
  assert.equal((await runGate({ argv: ["--root", root] })).exitCode, 2);
});

test("真实 checkout 不接受假 SHA、错误 head 或未知环境", async (t) => {
  const root = fixture(t, [scan], scanFiles, {}, true);
  for (const args of [["--sha", "f".repeat(40)], ["--base", "a".repeat(40), "--head", "f".repeat(40)], ["--env", "made-up-env"]]) {
    const r = await runGate({ argv: ["--root", root, ...args], root });
    assert.equal(r.exitCode, 2);
  }
});

test("release 缺环境、最低检查或实际工具版本时失败关闭", async (t) => {
  const root = fixture(t, [scan], scanFiles, {}, true);
  assert.equal((await runGate({ argv: ["--root", root, "--profile", "release"] })).exitCode, 2);
  assert.equal((await runGate({ argv: ["--root", root, "--profile", "release", "--env", "prd"] })).exitCode, 2);
  const missingLock = fixture(t, [scan], { ...scanFiles, "quality/rules.lock.json": { lockVersion: 1, "wl-skills-gate": gateVersion } }, { releaseRequires: ["SCAN"] }, true);
  const r = await runGate({ argv: ["--root", missingLock, "--profile", "release", "--env", "prd"] });
  assert.equal(r.exitCode, 2); assert.match(r.summary.checks[0].reason, /版本锁/);
});

test("受控检查拒绝脏工作区和检查期间源码变化", async (t) => {
  const root = fixture(t, [{ ...scan, command: "node scan.mjs" }], { ...scanFiles, "scan.mjs": `import fs from 'node:fs';fs.writeFileSync('src.txt','changed');console.log(JSON.stringify({toolVersion:'scanner@1',findings:[]}));` }, {}, true);
  const sha = git(["rev-parse", "HEAD"], root);
  assert.equal((await runGate({ argv: ["--root", root, "--sha", sha] })).exitCode, 2);
  assert.equal((await runGate({ argv: ["--root", root, "--sha", sha] })).exitCode, 2);
});

test("普通本地检查也拒绝边扫描边改源码的假通过", async (t) => {
  const root = fixture(t, [scan], { ...scanFiles, "scan.mjs": `import fs from 'node:fs';fs.writeFileSync('src.txt','changed');console.log(JSON.stringify({findings:[]}));` });
  const r = await runGate({ argv: ["--root", root] });
  assert.equal(r.exitCode, 2);
  assert.ok(r.summary.checks.some((c) => c.checkId === "GATE/SOURCE-DRIFT" && c.status === "invalid"));
});

test("暂存区与工作区不一致时快检拒绝", async (t) => {
  const root = fixture(t, [{ id: "LINT", tool: "eslint", profiles: ["fast"] }], { "a.js": "initial" }, {}, true);
  writeFileSync(path.join(root, "a.js"), "bad staged"); git(["add", "a.js"], root);
  writeFileSync(path.join(root, "a.js"), "clean worktree");
  const r = await runGate({ argv: ["--root", root, "--profile", "fast", "--scope", "staged"] });
  assert.equal(r.exitCode, 2); assert.match(r.summary.checks[0].reason, /未暂存/);
});

test("实际版本与锁定版本不一致时失败关闭", async (t) => {
  const root = fixture(t, [scan], { ...scanFiles, "quality/rules.lock.json": { tools: { SCAN: "scanner@2" } } });
  assert.equal((await runGate({ argv: ["--root", root] })).exitCode, 2);
});

function repairFixture(t, fixCode = "fs.writeFileSync('src.txt','good')", autoFixable = true) {
  return fixture(t, [scan], {
    "src.txt": "bad",
    "scan.mjs": `import fs from 'node:fs';console.log(JSON.stringify({toolVersion:'scanner@1',findings:fs.readFileSync('src.txt','utf8')==='bad'?[{ruleId:'DEMO/FIX',severity:'error',file:'src.txt',message:'bad',autoFixable:${autoFixable},fixerId:'replace-bad',fixCommand:'touch forbidden'}]:[]}));`,
    "fix.mjs": `import fs from 'node:fs';${fixCode};`,
  }, { fixers: [{ id: "replace-bad", ruleIds: ["DEMO/FIX"], files: ["src.txt"], command: "node fix.mjs" }] });
}

test("扫描后、预览前源码变化时拒绝用旧报告生成修复计划", async (t) => {
  const root = repairFixture(t);
  await runGate({ argv: ["--root", root] });
  writeFileSync(path.join(root, "src.txt"), "changed before preview");
  assert.throws(() => buildFixPlan(path.join(root, "quality-reports/quality-summary.json")), /当前源码/);
  assert.equal(existsSync(path.join(root, "quality-reports/repair")), false);
});

test("预览后代码或策略变化，应用零写入", async (t) => {
  for (const file of ["src.txt", "quality/policy.json"]) {
    const root = repairFixture(t);
    await runGate({ argv: ["--root", root] });
    const plan = buildFixPlan(path.join(root, "quality-reports/quality-summary.json"));
    writeFileSync(path.join(root, file), "changed after preview");
    await assert.rejects(applyFixPlan(plan.planFile, { root, confirm: true }), /预览后发生变化/);
    assert.equal(readFileSync(path.join(root, "src.txt"), "utf8"), file === "src.txt" ? "changed after preview" : "bad");
  }
});

test("autoFixable=false 和报告内命令不能绕过白名单", async (t) => {
  const root = repairFixture(t, "fs.writeFileSync('src.txt','good')", false);
  await runGate({ argv: ["--root", root] });
  const plan = buildFixPlan(path.join(root, "quality-reports/quality-summary.json"));
  assert.equal(plan.plan.items[0].action, "manual");
  const r = await applyFixPlan(plan.planFile, { root, confirm: true });
  assert.equal(r.fixReport.applied.length, 0); assert.equal(r.fixReport.closed, false);
  assert.equal(existsSync(path.join(root, "forbidden")), false);
});

test("白名单机械修复复扫通过，仅进入待复验", async (t) => {
  const root = repairFixture(t);
  await runGate({ argv: ["--root", root] });
  const plan = buildFixPlan(path.join(root, "quality-reports/quality-summary.json"));
  const r = await applyFixPlan(plan.planFile, { root, confirm: true });
  assert.equal(r.exitCode, 0); assert.equal(r.fixReport.scanResolved, true); assert.equal(r.fixReport.closed, false);
  assert.equal(r.fixReport.nextState, "pending-verification");
});

for (const [name, code] of [
  ["失败命令", "fs.writeFileSync('src.txt','good');process.exit(1)"],
  ["越出文件白名单", "fs.writeFileSync('src.txt','good');fs.writeFileSync('unexpected.txt','side-effect')"],
]) test(`机械修复回滚：${name}`, async (t) => {
  const root = repairFixture(t, code);
  await runGate({ argv: ["--root", root] });
  const plan = buildFixPlan(path.join(root, "quality-reports/quality-summary.json"));
  const r = await applyFixPlan(plan.planFile, { root, confirm: true });
  assert.equal(r.exitCode, 2); assert.equal(r.fixReport.rolledBack, true);
  assert.equal(readFileSync(path.join(root, "src.txt"), "utf8"), "bad");
  assert.equal(existsSync(path.join(root, "unexpected.txt")), false);
});

test("复扫期间即使白名单内源码变化也回滚，不能依据过时扫描宣称修复", async (t) => {
  const root = repairFixture(t);
  const scanner = path.join(root, "scan.mjs");
  writeFileSync(scanner, readFileSync(scanner, "utf8") + "\nif(fs.readFileSync('src.txt','utf8')==='good')fs.writeFileSync('src.txt','changed-after-report');\n");
  await runGate({ argv: ["--root", root] });
  const plan = buildFixPlan(path.join(root, "quality-reports/quality-summary.json"));
  const r = await applyFixPlan(plan.planFile, { root, confirm: true });
  assert.equal(r.exitCode, 2);
  assert.equal(r.fixReport.rolledBack, true);
  assert.equal(r.fixReport.scanResolved, false);
  assert.deepEqual(r.fixReport.rescanChangedFiles, ["src.txt"]);
  assert.equal(readFileSync(path.join(root, "src.txt"), "utf8"), "bad");
});

test("晋级控制器缺少 record 时拒绝并留下审计", (t) => {
  const root = fixture(t, []);
  const r = applyPromotion({ outDir: path.join(root, "quality-reports/controller-audit") });
  assert.equal(r.exitCode, 2);
  assert.match(r.reasons.join(";"), /record/);
  assert.equal(JSON.parse(readFileSync(r.auditFile, "utf8")).decision, "invalid");
});

test("晋级控制器审计目录不可写时拒绝且不抛出清理异常", (t) => {
  const root = fixture(t, [], { "not-directory": "file" });
  const r = applyPromotion({ recordFile: path.join(root, "missing.json"), remoteUrl: "unused", outDir: path.join(root, "not-directory") });
  assert.equal(r.exitCode, 2);
  assert.match(r.reasons.join(";"), /审计/);
});

function keys(root) {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(root, "signer.key"); const publicKeyFile = path.join(root, "signer.pub");
  writeFileSync(privateKeyFile, pair.privateKey.export({ format: "pem", type: "pkcs8" }));
  writeFileSync(publicKeyFile, pair.publicKey.export({ format: "pem", type: "spki" }));
  return { privateKeyFile, publicKeyFile };
}

async function releaseFixture(t) {
  const root = fixture(t, [scan], scanFiles, { releaseRequires: ["SCAN"] }, true);
  const sha = git(["rev-parse", "HEAD"], root);
  const r = await runGate({ argv: ["--root", root, "--sha", sha, "--profile", "release", "--env", "prd"] });
  assert.equal(r.exitCode, 0);
  const keyDir = mkdtempSync(path.join(tmpdir(), "wl-gate-key-")); t.after(() => rmSync(keyDir, { recursive: true, force: true }));
  const pair = keys(keyDir);
  mkdirSync(path.join(root, "dist")); writeFileSync(path.join(root, "dist/app.js"), "build-one");
  const manifestFile = path.join(root, "quality-reports/artifact-manifest.json");
  createArtifactManifest({ root, project: "hardening", env: "prd", artifacts: ["dist"], outFile: manifestFile });
  const o = { ...pair, summaryFile: path.join(root, "quality-reports/quality-summary.json"), sha,
    project: "hardening", profile: "release", env: "prd", expectPolicyHash: r.summary.policy.policyHash,
    expectRulesHash: r.summary.policy.ruleSetHash, issuer: "trusted-quality", expectIssuer: "trusted-quality",
    pipelineId: "101", jobId: "102", expectPipelineId: "101", expectJobId: "102", manifestFile, artifactRoot: root,
    attestationFile: path.join(root, "quality-reports/signed-proof.json") };
  writeFileSync(o.attestationFile, JSON.stringify(signGateProof(o)));
  return { root, options: o, summary: r.summary };
}

test("可信签名、真实 SHA、档位、环境及制品全部一致才部署放行", async (t) => {
  const { options } = await releaseFixture(t);
  assert.equal(verifyArtifact(options).ok, true);
});

test("两份 JSON 同时伪造并重算摘要仍拒绝", async (t) => {
  const { options, summary } = await releaseFixture(t);
  summary.checks[0].status = "invalid"; summary.decision.status = "passed";
  writeFileSync(options.summaryFile, JSON.stringify(summary));
  const proof = JSON.parse(readFileSync(options.attestationFile)); proof.reportDigest = sha256(JSON.stringify(summary));
  delete proof.signature; writeFileSync(options.attestationFile, JSON.stringify(proof));
  assert.equal(verifyArtifact(options).ok, false);
});

test("即使签名存在也独立拒绝失效检查", async (t) => {
  const { options, summary } = await releaseFixture(t);
  summary.checks[0].status = "invalid";
  writeFileSync(options.summaryFile, JSON.stringify(summary));
  const proof = JSON.parse(readFileSync(options.attestationFile)); proof.reportDigest = sha256(JSON.stringify(summary));
  writeFileSync(options.attestationFile, JSON.stringify(signRecord(proof, options.privateKeyFile)));
  assert.equal(verifyArtifact(options).ok, false);
});

test("缺少固定公钥、错误签发者、环境、策略或制品均拒绝", async (t) => {
  const { root, options } = await releaseFixture(t);
  for (const change of [{ publicKeyFile: null }, { expectIssuer: "other" }, { expectJobId: "999" }, { env: "pre" }, { expectPolicyHash: "f".repeat(64) }, { manifestFile: null }, { maxAgeMinutes: 0 }]) {
    assert.equal(verifyArtifact({ ...options, ...change }).ok, false);
  }
  writeFileSync(path.join(root, "dist/app.js"), "replaced-build");
  assert.equal(verifyArtifact(options).ok, false);
});

test("未来或缺失时间的签名证明拒绝", async (t) => {
  const { options } = await releaseFixture(t);
  const original = JSON.parse(readFileSync(options.attestationFile));
  for (const createdAt of [null, "2999-01-01T00:00:00Z", "2000-01-01T00:00:00Z"]) {
    writeFileSync(options.attestationFile, JSON.stringify(signRecord({ ...original, createdAt }, options.privateKeyFile)));
    assert.equal(verifyArtifact(options).ok, false);
  }
});

test("fast 档不能签发或充当 release 证明", async (t) => {
  const { options, summary } = await releaseFixture(t);
  summary.run.profile = "fast"; writeFileSync(options.summaryFile, JSON.stringify(summary));
  assert.throws(() => signGateProof({ ...options, profile: "fast" }), /档位/);
  assert.equal(verifyProof({ ...options, profile: "release" }).ok, false);
});

test("CLI 缺少参数值必须非零退出", () => {
  const r = spawnSync(process.execPath, [path.resolve("bin/wl-skills-gate.js"), "verify-artifact", "--public-key"], { encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /缺少值/);
});

test("构建前后源码快照必须与质量检查一致", async (t) => {
  const { root, options } = await releaseFixture(t);
  writeFileSync(path.join(root, "src.txt"), "changed-after-quality");
  assert.throws(() => createArtifactManifest({ root, project: "hardening", env: "prd", artifacts: ["dist"], outFile: options.manifestFile }), /干净/);
  const manifest = JSON.parse(readFileSync(options.manifestFile)); manifest.sourceDigest = "f".repeat(64);
  writeFileSync(options.manifestFile, JSON.stringify(manifest));
  assert.throws(() => signGateProof(options), /质量证据不一致/);
});

test("受控检查不能包含未提交的新增源码", async (t) => {
  const root = fixture(t, [scan], scanFiles, {}, true);
  const sha = git(["rev-parse", "HEAD"], root);
  writeFileSync(path.join(root, "new-source.js"), "untracked");
  assert.equal((await runGate({ argv: ["--root", root, "--sha", sha] })).exitCode, 2);
});

test("批准摘要绑定基线和例外，不能只批准 policy", async (t) => {
  const root = fixture(t, [scan], { ...scanFiles, "quality/baseline.json": { items: [{ fingerprint: "a".repeat(64), severity: "error", occurrenceCount: 1 }] } }, {}, true);
  const sha = git(["rev-parse", "HEAD"], root);
  assert.equal((await runGate({ argv: ["--root", root, "--sha", sha] })).exitCode, 2);
  const approved = loadConfig(root).baselineHash;
  const r = await runGate({ argv: ["--root", root, "--sha", sha, "--expect-baseline-hash", approved] });
  assert.equal(r.exitCode, 0);
  const o = { summaryFile: path.join(root, "quality-reports/quality-summary.json"), sha, project: "hardening", profile: "standard", expectPolicyHash: r.summary.policy.policyHash, expectRulesHash: r.summary.policy.ruleSetHash };
  assert.throws(() => signGateProof(o), /baselineHash/);
});

test("JSON policy 的提交类型和完整说明被实际核验", (t) => {
  const root = fixture(t, [raw], {}, { commitTypes: ["fix"] });
  const file = path.join(root, "message.txt");
  for (const [message, expected] of [["fix(炼钢): 停机-修复重复提交", true], ["feat(炼钢): 停机-新增功能", false], ["fix(炼钢): 随便写", false], ["fix(): 停机-修改", false], ["fix(炼钢): 停机-", false]]) {
    writeFileSync(file, message); assert.equal(validateCommitMessage(file, root).ok, expected);
  }
});

test("命令超时和输出超限均不能取得成功退出", async () => {
  const timed = await runCommand(`node -e 'setTimeout(()=>{},10000)'`, { timeoutMs: 100 });
  assert.equal(timed.timedOut, true); assert.notEqual(timed.code, 0);
  const large = await runCommand(`node -e 'process.stdout.write("x".repeat(10000))'`, { maxOutputBytes: 1000 });
  assert.equal(large.truncated, true); assert.notEqual(large.code, 0);
});

test("Code Quality 导出可供平台消费且风险/位置保留", async (t) => {
  const root = fixture(t, [raw], { "input.json": { findings: [{ ...finding, line: 7 }] } });
  await runGate({ argv: ["--root", root] });
  const result = JSON.parse(readFileSync(path.join(root, "quality-reports/code-quality/gl-code-quality-report.json")));
  assert.equal(result[0].severity, "major"); assert.equal(result[0].location.lines.begin, 7); assert.match(result[0].fingerprint, /^[a-f0-9]{64}$/);
});

test("畸形但看似通过的 JUnit 结构必须失效", async (t) => {
  const root = fixture(t, [], {});
  for (const xml of ['<?xml version="1.0"?><?xml version="1.0"?><testsuite><testcase name="ok"/></testsuite>', '<testsuite><testcase name="ok"><properties><failure/></properties></testcase></testsuite>', '<testsuite><testcase name="ok">]]></testcase></testsuite>']) {
    writeFileSync(path.join(root, "input.xml"), xml);
    assert.equal((await junit.run({ file: "input.xml" }, { root, project: "p" })).status, "invalid");
  }
});
