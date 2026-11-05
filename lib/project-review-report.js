import { renderQualityReportPage } from "./quality-report-page.js";
import { REVIEW_DIMENSIONS } from "./review.js";

const labels = { blocker: "极高", error: "严重", warning: "警告", info: "提示" };
const aliases = { "提交规范": "submission", "分支规范": "branch", "UI/交互": "ui", "UI与交互": "ui", "UI 与交互": "ui", "UI规范": "ui", "测试": "tests", "门禁监督": "scan", "质量门禁": "scan", "治理闭环": "governance" };
const checkLabels = { submission: "提交规范", branch: "分支校验", coding: "编码检查", ui: "界面与交互", tests: "必测用例", scan: "质量扫描", cicd: "构建与发布" };
function dimensionId(value) {
  return REVIEW_DIMENSIONS.find((d) => d.id === value || d.name === value)?.id || aliases[value] || null;
}

// A read-only presentation of existing evidence. It never authorizes repair,
// Review, merge, release, or issue closure, including when all evidence is ready.
function reviewView({ summary, dimensions = [], presentation = {} }, expectedStage) {
  if (summary?.run?.stage !== expectedStage) throw new Error(expectedStage === "local-hook" ? "项目内报告只接收local-hook；CI报告必须走第二道独立入口" : "流水线报告只接收ci；不能将项目Hook冒充流水线执行");
  const findings = (summary.findings || []).map((finding, index) => ({ ...finding, index, dimensionId: dimensionId(finding.dimension) }));
  const counts = Object.fromEntries(Object.keys(labels).map((level) => [level, findings.filter((f) => f.severity === level).length]));
  const evidence = new Map();
  for (const item of dimensions) {
    if (!REVIEW_DIMENSIONS.some((d) => d.id === item.id) || evidence.has(item.id)) throw new Error("九维展示证据存在未知或重复维度");
    evidence.set(item.id, item);
  }
  const rows = REVIEW_DIMENSIONS.map((dimension, index) => {
    const items = findings.filter((f) => f.dimensionId === dimension.id);
    const fact = evidence.get(dimension.id);
    const blocked = items.some((f) => ["blocker", "error"].includes(f.severity)) || (dimension.id === "scan" && ["blocked", "invalid"].includes(summary.decision?.status));
    const state = blocked ? "blocked" : items.some((f) => f.severity === "warning") ? "attention" : fact?.status === "evidence-ready" ? "ready" : "pending";
    const pendingLabel = fact?.status === "pending-na-approval" ? "是否适用待确认" : dimension.id === "review" ? "由技术经理审核" : dimension.id === "governance" ? "修复后核对闭环" : dimension.id === "cicd" && expectedStage === "local-hook" ? "由流水线继续检查" : "缺少检查结果";
    const stateLabel = { blocked: "发现阻断问题", attention: "发现警告问题", ready: "已有检查记录", pending: pendingLabel }[state];
    return { ...dimension, index: index + 1, items, fact, state, stateLabel };
  });
  const trace = summary.run.trace || {};
  const pendingChecks = rows.filter((d) => d.fact?.status !== "evidence-ready" && checkLabels[d.id] && !(expectedStage === "local-hook" && d.id === "cicd"));
  const pendingNames = pendingChecks.map((d) => checkLabels[d.id] + (d.fact?.status === "pending-na-approval" ? "适用性" : ""));
  const pendingMessage = pendingNames.length ? `尚缺：${pendingNames.slice(0, 3).join("、")}${pendingNames.length > 3 ? `等 ${pendingNames.length} 项` : ""}检查结果，具体见详情。` : "";
  return { summary, presentation, findings, counts, rows, unclassified: findings.filter((f) => !f.dimensionId), trace,
    pendingMessage,
    commit: trace.commits?.[0], blocked: counts.blocker + counts.error > 0 || ["blocked", "invalid"].includes(summary.decision?.status),
    displayOnly: true, approved: false };
}

export function projectReviewView(input) { return reviewView(input, "local-hook"); }
export function pipelineReviewView(input) { return reviewView(input, "ci"); }
export function renderProjectReviewReport(input) { return renderReviewReport(input, "local-hook"); }
export function renderPipelineReviewReport(input) { return renderReviewReport(input, "ci"); }

function renderReviewReport(input, stage) {
  return renderQualityReportPage(reviewView(input, stage), { stage });
}
