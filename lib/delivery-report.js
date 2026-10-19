import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDeploymentLifecycle, loadDeploymentConfig } from "./deployment.js";
import { controlledPath, verifyReleaseSet, releaseDigest } from "./release-set.js";
import { loadGovernanceConfig } from "./governance.js";
import { managerReviewSatisfied } from "./review-responsibility.js";
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const json = (value) => JSON.stringify(value, null, 2) + "\n";
// A customer view derives from signed Review + signed release + actual smoke.
// It grants no new authorization and never manufactures an improvement delta.
export function createUatDeliveryReport(options) {
  const c = loadDeploymentConfig(options.configFile),
    execution = JSON.parse(readFileSync(controlledPath(options.executionFile), "utf8"));
  assert(
    c.environment === "uat" &&
      execution.environment === "uat" &&
      execution.action === "smoke" &&
      execution.status === "success",
    "UAT交付报告仅在真实UAT独立smoke成功后生成"
  );
  const output = controlledPath(options.outDir);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const scratch = path.join(output, ".verification-" + randomUUID());
  try {
    createDeploymentLifecycle({ ...options, project: c.projects[0], outDir: scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const verified = verifyReleaseSet({
    releaseSetFile: options.releaseSetFile,
    reviewConfigFile: c.reviewConfigFile,
    publicKeyFile: c.releasePublicKeyFile,
    expectIssuer: c.releaseIssuer,
    expectReleaseSetHash: options.expectReleaseSetHash,
    env: "uat",
    now: new Date(options.now ?? Date.now()),
    maxAgeMinutes: c.recoveryMaxAgeMinutes,
    allowHistoricalReview: true,
  });
  assert(
    verified.releaseSet.components.length === c.projects.length &&
      c.projects.every((project) => verified.releaseSet.components.some((component) => component.project === project)),
    "UAT报告组件集合与批准部署项目不同"
  );
  const governance = options.governanceConfigFile ? loadGovernanceConfig(options.governanceConfigFile) : null;
  const components = verified.releaseSet.components.map((component) => {
    const record = component.review.record,
      gateRef = record.content.evidence.find((e) => e.type === "gate-summary" && e.role !== "before");
    assert(gateRef && component.review.files[gateRef.file], "正式Review缺少本候选Gate原件，不能用零问题占位");
    const gate = JSON.parse(Buffer.from(component.review.files[gateRef.file].base64, "base64").toString("utf8"));
    assert(
      gate.run.project === component.project && gate.run.commitSha === component.sha,
      "UAT报告Gate原件项目/SHA不同"
    );
    const responsibility = governance?.projects[component.project];
    if (responsibility)
      assert(managerReviewSatisfied(responsibility, record), "UAT报告缺少本项目技术经理责任确认，不能补写署名");
    const manager = responsibility?.technicalManager || null,
      person = manager && governance.people?.[manager];
    return {
      project: component.project,
      scope: component.scope,
      sha: component.sha,
      artifactHash: component.artifactHash,
      manifestHash: component.manifestHash,
      authorId: record.authorId,
      reviewerId: record.reviewerId,
      technicalManager: manager
        ? {
            id: manager,
            name: person?.name || manager,
            independentlyConfirmed: record.reviewerId === manager && record.authorization.actorId === manager,
            managerIsExecutor: record.authorId === manager,
          }
        : null,
      review: {
        reviewDigest: record.reviewDigest,
        bodyDigest: record.bodyDigest,
        evidenceDigest: record.evidenceDigest,
        confirmedAt: record.authorization.createdAt,
        signedAt: record.signedAt,
        authorizationId: record.authorization.authorizationId,
        identitySource: record.authorization.identitySource,
        dimensions: record.content.dimensions,
        comparison: record.content.comparison || null,
        comparisonWarning: record.content.comparisonWarning || null,
      },
      quality: {
        checkedAt: gate.run.finishedAt || gate.run.startedAt,
        checks: gate.checks.map((check) => ({
          id: check.checkId,
          status: check.status,
          toolVersion: check.toolVersion,
          coverage: check.coverage || null,
          testEvidence: check.testEvidence || null,
        })),
        counts: Object.fromEntries(
          ["blocker", "error", "warning", "info"].map((level) => [
            level,
            gate.findings.filter((f) => f.severity === level).length,
          ])
        ),
        trace: gate.run.trace || null,
      },
    };
  });
  const report = {
    schemaVersion: 1,
    kind: "uat-delivery-report",
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    releaseSetId: verified.releaseSet.releaseSetId,
    releaseSetHash: options.expectReleaseSetHash,
    environment: "uat",
    deploymentId: execution.deploymentId,
    verification: {
      executionId: execution.executionId,
      executionFileHash: releaseDigest(readFileSync(options.executionFile)),
      actorId: execution.actorId,
      authorizationId: execution.authorizationId,
      createdAt: execution.createdAt,
      completedAt: execution.completedAt,
      checks: execution.checks,
      observationHash: execution.observationHash,
      recordUrl: execution.recordUrl,
    },
    components,
    authority:
      "仅汇总已经授权/验签的版本及实际UAT验证事实，不产生新批准、经理署名、发布授权或问题关闭。历史版本报告不表示环境此刻仍运行本版本。",
  };
  const rows = components
    .map(
      (component) =>
        `<h2>${esc(component.project)} · ${esc(component.scope)}</h2><p>SHA ${esc(component.sha)}</p><p>提交执行人 ${esc(component.authorId)}；独立Reviewer ${esc(component.reviewerId)}；确认 ${esc(component.review.confirmedAt)}；授权 ${esc(component.review.authorizationId)}</p><p>技术经理：${component.technicalManager ? esc(component.technicalManager.name) + "（" + (component.technicalManager.independentlyConfirmed ? "本轮独立确认已核验" : component.technicalManager.managerIsExecutor ? "经理为执行人，另由所列非作者独立复核" : "不冒充已取得经理本轮独立确认") + "）" : "未登记，不自动署名"}</p><p>当前质量：${Object.entries(
          component.quality.counts
        )
          .map(([level, count]) => `${esc(level)} ${count}`)
          .join(
            " · "
          )}</p>${component.review.comparison ? `<h3>修前/修后</h3><pre>${esc(json(component.review.comparison))}</pre>` : "<p>没有可同比的修前证据，不虚构改善数量；零问题仍保留实际覆盖和验证。</p>"}<table><tr><th>维度</th><th>适用</th><th>证据状态</th><th>证据</th></tr>${component.review.dimensions.map((d) => `<tr><td>${esc(d.name || d.id)}</td><td>${d.applicable ? "是" : "已批准不适用"}</td><td>${esc(d.status)}</td><td>${esc((d.evidenceIds || []).join(", "))}</td></tr>`).join("")}</table><details><summary>工具、范围、测试及完整追溯</summary><pre>${esc(json(component))}</pre></details>`
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><title>UAT版本交付Review · ${esc(report.releaseSetId)}</title><style>body{font:15px/1.7 system-ui;color:#172634;max-width:1100px;margin:36px auto;padding:0 20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd5dd;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:14px}h1{border-bottom:3px solid #087a7d}small{color:#536579}</style><h1>UAT版本交付Review</h1><p>${esc(report.releaseSetId)} · ${esc(report.generatedAt)} · 部署 ${esc(report.deploymentId)}</p><p>固定组合 ${esc(report.releaseSetHash)}</p><h2>UAT实际验证</h2><p>独立验证人 ${esc(execution.actorId)} · 执行 ${esc(execution.executionId)} · ${esc(execution.completedAt)}</p><ul>${execution.checks.map((check) => `<li>${esc(check.id)}：${esc(check.status)} · ${esc(check.evidenceHash)}</li>`).join("")}</ul>${rows}<small>${esc(report.authority)}</small>`;
  const contents = { "report.json": json(report), "report.html": html };
  const files = {};
  for (const [name, content] of Object.entries(contents)) {
    const file = controlledPath(path.join(output, name));
    if (existsSync(file)) assert(readFileSync(file, "utf8") === content, "已有UAT版本报告被修改或输入变化，拒绝覆盖");
    else writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    files[name] = { file, sha256: releaseDigest(content) };
  }
  return {
    kind: report.kind,
    releaseSetHash: report.releaseSetHash,
    jsonFile: files["report.json"].file,
    jsonHash: files["report.json"].sha256,
    htmlFile: files["report.html"].file,
    htmlHash: files["report.html"].sha256,
  };
}
