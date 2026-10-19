import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { planBranchSetup, applyBranchSetup } from "../../lib/branch-setup.js";
import { loadCiSourceConfig } from "../../lib/ci-source.js";
const branches = ["dev", "sit", "uat", "pre", "prd", "main"],
  read = (file) => JSON.parse(readFileSync(file, "utf8"));
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-branch-setup-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
  put("setup.json", {
    schemaVersion: 1,
    kind: "quality-branch-setup",
    automationConfigFile: "automation.json",
    controlConfigFile: "control.json",
    reviewPublishConfigFile: "publisher.json",
    reviewTrustConfigFile: "trust.json",
    sourceIds: ["frontend"],
  });
  put("automation.json", {
    governanceConfigFile: "governance.json",
    stateFile: "state.json",
    dataDir: "runtime",
    sources: [
      {
        id: "frontend",
        configFile: "ci.json",
        actors: { 1: "author" },
        since: "2026-10-15T00:00:00Z",
        review: {
          configFile: "review-ci.json",
          outRoot: "evidence",
          publication: {
            manifestDir: "manifests",
            publicKeyFile: "review.pem",
            authorizationPublicKeyFile: "authorization.pem",
            evidenceRoot: "evidence",
          },
        },
      },
    ],
  });
  put("governance.json", {
    projects: { demo: { scopes: { standard: { requiredChecks: ["CHECK"], policyHash: "a".repeat(64) } } } },
  });
  put("control.json", {
    governanceConfigFile: "governance.json",
    reviewPolicies: { demo: { collectorConfigFile: "collector.json", evidenceRoot: "evidence" } },
  });
  put("publisher.json", {
    stateFile: "publisher-state.json",
    projects: { demo: { collectorConfigFile: "collector.json" } },
  });
  put("trust.json", { projects: { demo: { collectorConfigFile: "collector.json" } } });
  put("ci.json", {
    schemaVersion: 1,
    system: "gitlab",
    project: "demo",
    scope: "standard",
    baseUrl: "https://gitlab.example.invalid",
    projectId: 1,
    trustedRunnerIds: [2],
    tokenEnv: "CI_TOKEN",
    ref: "dev",
    requiredJobs: ["quality"],
    artifacts: { job: "quality", paths: ["quality/summary.json"] },
    qualitySummary: "quality/summary.json",
  });
  put("collector.json", {
    schemaVersion: 1,
    project: "demo",
    ciConfigFile: "ci.json",
    reviewPolicyHash: "a".repeat(64),
    allowedAuthorIds: ["author"],
    evidence: [],
  });
  put("review-ci.json", {
    collectorConfigFile: "collector.json",
    controlConfigFile: "control.json",
    reviewPolicyFile: "review-policy.json",
    candidateContextPath: "review/candidate.json",
    sourceBranch: "feature",
    targetBranch: "dev",
  });
  return { root, put, configFile: path.join(root, "setup.json") };
}
test("一个交互计划自动生成六分支CI/Review/治理/签发接线；预览只读、确认后逐项落地", (t) => {
  const f = fixture(t),
    plan = planBranchSetup(f);
  assert.equal(plan.summary[0].branches.length, 6);
  assert.equal(existsSync(path.join(f.root, "branches")), false);
  assert.throws(() => applyBranchSetup({ ...f, expectPlanHash: plan.planHash, confirm: false }), /确认/);
  const result = applyBranchSetup({ ...f, expectPlanHash: plan.planHash, confirm: true });
  assert.equal(result.status, "configuration-applied");
  assert.equal(result.remoteValidated, false);
  const auto = read(path.join(f.root, "automation.json"));
  assert.equal(auto.sources.length, 7);
  assert.equal(auto.sources.find((source) => source.id === "frontend").review.configFile, "review-ci.json");
  for (const [index, source] of auto.sources.filter((source) => source.id !== "frontend").entries()) {
    const ci = loadCiSourceConfig(source.configFile),
      review = read(source.review.configFile);
    assert.equal(ci.scope, branches[index]);
    assert.equal(ci.ref, branches[index]);
    assert.equal(read(review.collectorConfigFile).ciConfigFile, source.configFile);
    assert.equal(review.controlConfigFile, path.join(f.root, "control.json"));
    assert.equal(review.candidateContextPath, undefined);
  }
  assert.equal(read(path.join(f.root, "control.json")).reviewPolicies.demo.additionalCollectorConfigFiles.length, 6);
  assert.equal(read(path.join(f.root, "trust.json")).projects.demo.scope, "uat");
  assert.throws(() => planBranchSetup(f), /基础来源缺少|已存在多分支/); // no accidental second expansion
});
test("输入变化、已有运行台账或缺Jenkins分支固定作业均零写入", (t) => {
  const f = fixture(t),
    plan = planBranchSetup(f),
    ci = read(path.join(f.root, "ci.json"));
  f.put("ci.json", { ...ci, ref: "sit" });
  assert.throws(() => applyBranchSetup({ ...f, expectPlanHash: plan.planHash, confirm: true }), /旧确认失效/);
  assert.equal(existsSync(path.join(f.root, "branches")), false);
  f.put("state.json", {});
  assert.throws(() => planBranchSetup(f), /不删除旧账/);
  rmSync(path.join(f.root, "state.json"));
  f.put("ci.json", {
    ...ci,
    system: "jenkins",
    ref: "origin/dev",
    jobPath: "quality/base",
    jobConfigHash: "a".repeat(64),
    userEnv: "CI_USER",
    requiredJobs: ["quality/base"],
    artifacts: { job: "quality/base", paths: ["quality/summary.json"] },
  });
  assert.throws(() => planBranchSetup(f), /Jenkins各分支/);
  const seed = read(f.configFile);
  seed.jenkinsJobs = {
    frontend: Object.fromEntries(
      branches.map((branch) => [
        branch,
        { ref: "origin/" + branch, jobPath: "quality/" + branch, jobConfigHash: "b".repeat(64) },
      ])
    ),
  };
  f.put("setup.json", seed);
  const ready = planBranchSetup(f);
  assert.equal(ready.summary[0].branches.length, 6);
  assert.equal(existsSync(path.join(f.root, "branches")), false);
});
test("基础采集器已使用目标分支scope时复用批准文件，不重复登记相同scope", (t) => {
  const f = fixture(t),
    ci = read(path.join(f.root, "ci.json")),
    g = read(path.join(f.root, "governance.json"));
  ci.scope = "dev";
  const review = read(path.join(f.root, "review-ci.json"));
  delete review.candidateContextPath;
  delete review.sourceBranch;
  delete review.targetBranch;
  f.put("review-ci.json", review);
  g.projects.demo.scopes.dev = g.projects.demo.scopes.standard;
  f.put("ci.json", ci);
  f.put("governance.json", g);
  const plan = planBranchSetup(f);
  applyBranchSetup({ ...f, expectPlanHash: plan.planHash, confirm: true });
  const control = read(path.join(f.root, "control.json")),
    auto = read(path.join(f.root, "automation.json"));
  assert.equal(control.reviewPolicies.demo.additionalCollectorConfigFiles.length, 5);
  assert.equal(auto.sources.find((source) => source.id === "frontend.dev").configFile, path.join(f.root, "ci.json"));
});
test("没有候选字段的验证分支默认也保留；明确选定后才能移除基础来源",t=>{
 for(const keep of [true,false]){
  const f=fixture(t),review=read(path.join(f.root,"review-ci.json"));delete review.candidateContextPath;f.put("review-ci.json",review);
  const seed=read(f.configFile);seed.keepBaseSource=keep;f.put("setup.json",seed);
  const plan=planBranchSetup(f);applyBranchSetup({...f,confirm:true,expectPlanHash:plan.planHash});const auto=read(path.join(f.root,"automation.json"));
  assert.equal(auto.sources.length,keep?7:6);assert.equal(auto.sources.some(source=>source.id==="frontend"),keep);
 }
});
