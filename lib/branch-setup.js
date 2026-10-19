import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { controlledPath } from "./control-store.js";
import { loadCiSourceConfig } from "./ci-source.js";
import { stableStringify, sha256 } from "./util.js";
const branches = ["dev", "sit", "uat", "pre", "prd", "main"],
  json = (value) => JSON.stringify(value, null, 2) + "\n";
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
export function planBranchSetup({ configFile }) {
  configFile = controlledPath(configFile);
  const root = path.dirname(configFile),
    inputs = new Map(),
    changes = new Map();
  const inside = (file) => {
    file = controlledPath(file);
    const relative = path.relative(root, file);
    assert(
      relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative),
      "多分支配置须位于批准配置目录内，不能修改项目/密钥/状态目录"
    );
    return file;
  };
  const read = (file) => {
    file = inside(file);
    const bytes = readFileSync(file);
    inputs.set(file, sha256(bytes));
    const value = JSON.parse(bytes);
    assert(!/-----BEGIN .*PRIVATE KEY-----/.test(bytes.toString()), "配置含内联私钥，先改为受控路径引用");
    return value;
  };
  const resolve = (base, file) => {
    assert(typeof file === "string" && file, "多分支接线缺少固定配置路径");
    return inside(path.resolve(path.dirname(base), file));
  };
  const seed = read(configFile);
  assert(
    seed.schemaVersion === 1 &&
      seed.kind === "quality-branch-setup" &&
      Array.isArray(seed.sourceIds) &&
      seed.sourceIds.length &&
      new Set(seed.sourceIds).size === seed.sourceIds.length,
    "多分支接线需schemaVersion/kind及无重复sourceIds"
  );
  const autoFile = resolve(configFile, seed.automationConfigFile),
    controlFile = resolve(configFile, seed.controlConfigFile),
    publishFile = resolve(configFile, seed.reviewPublishConfigFile),
    trustFile = resolve(configFile, seed.reviewTrustConfigFile);
  const auto = read(autoFile),
    control = read(controlFile),
    publisher = read(publishFile),
    trust = read(trustFile),
    govFile = resolve(autoFile, auto.governanceConfigFile),
    gov = read(govFile);
  assert(resolve(controlFile, control.governanceConfigFile) === govFile, "中央操作与采集必须使用同一治理配置");
  for (const [base, file] of [
    [autoFile, auto.stateFile],
    [autoFile, path.join(auto.dataDir, "automation-state.json")],
    [publishFile, publisher.stateFile],
  ]) {
    const state = controlledPath(path.resolve(path.dirname(base), file));
    assert(
      !existsSync(state) && !existsSync(state + ".lock"),
      "已有运行台账或锁；本助手只配置首次中央接线，不删除旧账。已运行服务须先完成受审计配置迁移"
    );
  }
  const propose = (file, value) => {
    file = inside(file);
    assert(!changes.has(file), "多个接线项试图覆盖同一配置");
    changes.set(file, { file, beforeHash: existsSync(file) ? sha256(readFileSync(file)) : null, content: json(value) });
  };
  const summary = [];
  for (const sourceId of seed.sourceIds) {
    assert(/^[A-Za-z0-9_.-]{1,90}$/.test(sourceId), "基础来源ID无效");
    const baseSource = auto.sources?.find((source) => source.id === sourceId);
    assert(baseSource?.review?.publication, "基础来源缺少Review及正式回流接线");
    const ciFile = resolve(autoFile, baseSource.configFile);
    read(ciFile);
    const ci = loadCiSourceConfig(ciFile),
      reviewFile = resolve(autoFile, baseSource.review.configFile),
      review = read(reviewFile),
      collectorFile = resolve(reviewFile, review.collectorConfigFile),
      collector = read(collectorFile);
    assert(
      resolve(reviewFile, review.controlConfigFile) === controlFile &&
        resolve(collectorFile, collector.ciConfigFile) === ciFile &&
        ci.project === collector.project,
      "基础CI、Review与中央项目接线不一致"
    );
    const project = ci.project,
      g = gov.projects?.[project],
      c = control.reviewPolicies?.[project],
      p = publisher.projects?.[project],
      releaseTrust = trust.projects?.[project];
    assert(
      !review.candidateContextPath || !branches.includes(ci.scope),
      "候选Review与最终目标分支须使用独立scope，不能丢弃候选上下文或在同scope重复采集；先由维护者确认候选scope"
    );
    assert(g?.scopes?.[ci.scope] && c && p && releaseTrust, "项目缺少治理scope、控制/签发/发布信任配置");
    assert(
      !c.additionalCollectorConfigFiles?.length && !p.additionalCollectorConfigFiles?.length,
      "已存在多分支登记，不能重复生成或覆盖"
    );
    const files = [],
      newSources = [];
    for (const branch of branches) {
      const reuse = ci.scope === branch;
      if (reuse)
        assert(
          ci.ref === branch || (ci.system === "jenkins" && seed.jenkinsJobs?.[sourceId]?.[branch]?.ref === ci.ref),
          "既有scope标签与实际ref不同，需先审阅适配"
        );
      const directory = path.join(root, "branches", sourceId, branch),
        targetCi = reuse ? ciFile : path.join(directory, "ci.json"),
        targetCollector = reuse ? collectorFile : path.join(directory, "collector.json"),
        targetReview = path.join(directory, "review-ci.json");
      const id = sourceId + "." + branch;
      assert(!auto.sources.some((source) => source.id === id), "分支来源ID已存在");
      const nextCi = structuredClone(ci);
      nextCi.scope = branch;
      nextCi.ref = branch;
      if (ci.system === "jenkins") {
        const job = seed.jenkinsJobs?.[sourceId]?.[branch];
        assert(
          job &&
            typeof job.ref === "string" &&
            typeof job.jobPath === "string" &&
            /^[a-f0-9]{64}$/.test(job.jobConfigHash || ""),
          "Jenkins各分支须提供已批准ref/jobPath/jobConfigHash，不猜测作业或权限"
        );
        Object.assign(nextCi, { ref: job.ref, jobPath: job.jobPath, jobConfigHash: job.jobConfigHash });
        nextCi.requiredJobs = [job.jobPath];
        nextCi.artifacts.job = job.jobPath;
        if (nextCi.actorSource) {
          assert(
            typeof job.actorSourceRef === "string" && job.actorSourceRef,
            "Jenkins上游作者关联须固定每分支actorSourceRef"
          );
          nextCi.actorSource.ref = job.actorSourceRef;
        }
      }
      const nextCollector = structuredClone(collector);
      nextCollector.ciConfigFile = targetCi;
      if (nextCollector.supplement)
        for (const key of ["governanceConfigFile", "authorizationPublicKeyFile"])
          nextCollector.supplement[key] = controlledPath(
            path.resolve(path.dirname(collectorFile), nextCollector.supplement[key])
          );
      const nextReview = structuredClone(review);
      nextReview.collectorConfigFile = targetCollector;
      nextReview.controlConfigFile = controlFile;
      nextReview.reviewPolicyFile = resolve(reviewFile, review.reviewPolicyFile);
      // Candidate promotion contexts have their own fixed source/target contract.
      // A final branch observation must not inherit another branch's candidate.
      delete nextReview.candidateContextPath;
      delete nextReview.sourceBranch;
      delete nextReview.targetBranch;
      assert(
        !g.scopes[branch] || stableStringify(g.scopes[branch]) === stableStringify(g.scopes[ci.scope]),
        "目标scope已有不同批准策略，不覆盖"
      );
      g.scopes[branch] = structuredClone(g.scopes[ci.scope]);
      const source = structuredClone(baseSource);
      source.id = id;
      source.configFile = targetCi;
      source.review.configFile = targetReview;
      source.review.outRoot = path.join(
        controlledPath(path.resolve(path.dirname(autoFile), baseSource.review.outRoot)),
        branch
      );
      for (const key of ["manifestDir", "publicKeyFile", "authorizationPublicKeyFile", "evidenceRoot"])
        source.review.publication[key] = controlledPath(
          path.resolve(path.dirname(autoFile), baseSource.review.publication[key])
        );
      newSources.push(source);
      if (!reuse) {
        files.push(targetCollector);
        propose(targetCi, nextCi);
        propose(targetCollector, nextCollector);
      }
      propose(targetReview, nextReview);
    }
    const oldPrimary = controlledPath(path.resolve(path.dirname(controlFile), c.collectorConfigFile));
    assert(
      oldPrimary === collectorFile &&
        controlledPath(path.resolve(path.dirname(publishFile), p.collectorConfigFile)) === collectorFile,
      "基础采集器不是本项目当前批准生产者"
    );
    // Retain the historic primary and scope for old records; each new branch has
    // its own scope so findings and approvals cannot close another branch.
    c.collectorConfigFile = collectorFile;
    c.additionalCollectorConfigFiles = files;
    p.collectorConfigFile = collectorFile;
    p.additionalCollectorConfigFiles = files;
    releaseTrust.collectorConfigFile = collectorFile;
    releaseTrust.additionalCollectorConfigFiles = files;
    releaseTrust.scope = "uat";
    for (const field of ["publicKeyFile", "authorizationPublicKeyFile", "controlCatalogFile"])
      if (releaseTrust[field])
        releaseTrust[field] = controlledPath(path.resolve(path.dirname(trustFile), releaseTrust[field]));
    const keepCandidate = (seed.keepBaseSource !== false || !!review.candidateContextPath) && !branches.includes(ci.scope);
    auto.sources = auto.sources.filter((source) => source.id !== sourceId || keepCandidate).concat(newSources);
    summary.push({
      project,
      branches: [...branches],
      retainedHistoricalScope: ci.scope,
      mode: "final-branch-observation",
      candidateMrPipeline: "既有MR必需Gate作业保留；此配置不把源分支流水线冒充合并结果",
    });
  }
  propose(autoFile, auto);
  propose(controlFile, control);
  propose(publishFile, publisher);
  propose(trustFile, trust);
  propose(govFile, gov);
  const plan = {
    schemaVersion: 1,
    kind: "quality-branch-setup-plan",
    status: "configuration-planned",
    root,
    configFile,
    implementationHash: sha256(readFileSync(fileURLToPath(import.meta.url))),
    inputs: [...inputs].map(([file, sha256]) => ({ file, sha256 })),
    files: [...changes.values()].map((file) => ({ ...file, afterHash: sha256(file.content) })),
    summary,
  };
  return { ...plan, planHash: sha256(stableStringify(plan)) };
}
export function applyBranchSetup({ configFile, expectPlanHash, confirm }) {
  assert(confirm === true, "多分支接线必须确认实际计划");
  const plan = planBranchSetup({ configFile });
  assert(plan.planHash === expectPlanHash, "多分支计划已变化，旧确认失效；零写入");
  const lock = controlledPath(path.join(plan.root, ".quality-branch-setup.lock"));
  mkdirSync(lock, { mode: 0o700 });
  const applied = [];
  try {
    for (const input of plan.inputs)
      assert(sha256(readFileSync(input.file)) === input.sha256, "应用前输入已变化；零写入");
    for (const file of plan.files) {
      assert((existsSync(file.file) ? sha256(readFileSync(file.file)) : null) === file.beforeHash, "应用前配置已变化");
      const before = existsSync(file.file) ? readFileSync(file.file) : null;
      mkdirSync(path.dirname(file.file), { recursive: true, mode: 0o700 });
      const temporary = path.join(lock, sha256(file.file));
      writeFileSync(temporary, file.content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, file.file);
      applied.push({ file: file.file, before });
    }
    for (const input of plan.inputs) {
      const changed = plan.files.find((file) => file.file === input.file);
      assert(
        sha256(readFileSync(input.file)) === (changed?.afterHash || input.sha256),
        "应用期间原始输入发生变化，回滚本轮配置"
      );
    }
    return {
      status: "configuration-applied",
      planHash: plan.planHash,
      summary: plan.summary,
      written: applied.length,
      localValidated: false,
      remoteValidated: false,
      nextAction:
        "运行同一助手的中央预检，再逐分支验收真实MR必需作业和最终合并SHA、群消息与独立Review。此步骤不改GitLab/Jenkins权限、不启动、不发送。",
    };
  } catch (error) {
    for (const item of applied.reverse())
      item.before === null ? rmSync(item.file) : writeFileSync(item.file, item.before);
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
