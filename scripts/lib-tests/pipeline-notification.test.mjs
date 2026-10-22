import { test } from "node:test";
import assert from "node:assert/strict";
import { pipelineCheckNotification } from "../../lib/pipeline-notification.js";
import { renderPipelineReviewReport, renderProjectReviewReport } from "../../lib/project-review-report.js";
import { riskCountsElement } from "../../lib/notification-style.js";

const buttons = (elements) => elements.find((e) => e.tag === "column_set" && e.columns.length === 2);
const config = { projects: { produce: { domain: "生产", technicalManager: "lead", requireRiskMentions: true } }, people: {
  dev: { name: "开发甲", feishu: { idType: "open_id", id: "ou_test_dev" } }, lead: { name: "经理乙", feishu: { idType: "open_id", id: "ou_test_lead" } },
} };
function input() {
  return { summary: { run: { project: "produce", stage: "ci", startedAt: "2026-10-19T13:00:00Z", trace: { branch: "sit", commits: [{ subject: "fix(导出): 资源释放-补充异常路径处理" }] } }, findings: [{ severity: "error", dimension: "tests", ruleId: "DEMO/TEST-FAILURE", file: "src/test/ExportTest.java", line: 66, endLine: 82, message: "导出失败路径用例失败", suggestion: "修复并重跑必测" }], decision: { status: "blocked" } },
    dimensions: [], presentation: { simulation: true, localPreview: true, submitterId: "dev", submitterName: "开发甲", technicalManagerName: "经理乙", environment: "SIT", pipelineLabel: "第286次运行（模拟）", reportUrl: "http://127.0.0.1:47862/pipeline-review.html", executionStates: [{ name: "质量门禁", status: "blocked", result: "未通过" }, { name: "构建 / 制品", status: "not-run", result: "未开始 / 未生成" }, { name: "部署 / 验证", status: "not-run", result: "未执行 / 无验证记录" }] } };
}
test("两个入口严格区分项目Hook与CI，个人分支CI不进入正式构建通知", () => {
  const value = input(); assert.throws(() => renderProjectReviewReport(value), /CI报告/);
  value.summary.run.stage = "local-hook";
  assert.throws(() => pipelineCheckNotification(value, config), /不能将项目Hook冒充/);
  value.summary.run.stage = "ci"; value.summary.run.trace.branch = "feature/user";
  assert.equal(pipelineCheckNotification(value, config).skipped, true);
});
test("流水线卡片标明准入拦截与未构建未部署，彩色数字、真实@和按钮同排", () => {
  const result = pipelineCheckNotification(input(), config), elements = result.payload.card.body.elements;
  assert.deepEqual(result.mentions, ["ou_test_dev", "ou_test_lead"]);
  assert.match(elements[0].text.content, /构建准入拦截/);
  assert.equal(elements[0].text.text_color, "red");
  const metrics = elements.find((e) => e.tag === "column_set" && e.columns.length === 4);
  assert.equal(metrics.columns[1].elements[0].text.content, "严重 1");
  assert.equal(metrics.columns[1].elements[0].text.text_color, "red");
  assert.match(elements.find((e) => e.tag === "markdown").content, /触发人.*开发甲.*技术经理.*经理乙/);
  assert.equal(elements.find((e) => e.text?.content.startsWith("质量门禁：")).text.text_color, "red");
  assert.equal(elements.find((e) => e.text?.content.includes("未开始 / 未生成")).text.text_color, "grey");
  assert.equal(elements.find((e) => e.text?.content.startsWith("部署 / 验证：")).text.text_color, "grey");
  assert.ok(!JSON.stringify(result.payload).includes("<font"));
  assert.equal(buttons(elements).columns.length, 2);
  assert.match(elements.at(-1).content, /ou_test_dev.*回归验证[\s\S]*ou_test_lead.*确认闭环/);
  assert.match(buttons(elements).columns[1].elements[0].behaviors[0].default_url, /#pipeline-stages$/);
  const missing = structuredClone(config); delete missing.people.lead.feishu;
  assert.throws(() => pipelineCheckNotification(input(), missing), /真实飞书ID/);
});
test("流水线详情完整九维与失败阶段，缺证和演示数据不伪造批准", () => {
  const html = renderPipelineReviewReport(input());
  assert.match(html, /第二道 · CI构建准入/); assert.ok(!html.includes("第一道 · 项目内检查"));
  assert.match(html, /未执行真实CI、构建或部署/);
  assert.equal((html.match(/class="dimension-section" id="dimension-/g) || []).length, 9);
  assert.match(html, /id="pipeline-stages"/); assert.match(html, /代码审核由技术经理确认/);
  assert.match(html, /2026年10月19日 21:00:00/); assert.ok(!html.includes("北京时间"));
});
test("流水线技术经理本人触发时同步李月，额外@不产生审核批准", () => {
  const c = structuredClone(config); c.projects.produce.managerSubmissionNotify = "observer";
  c.people.observer = { name: "李月", feishu: { idType: "open_id", id: "ou_ci_observer" } };
  const value = input(); value.presentation.submitterId = "lead";
  const notice = pipelineCheckNotification(value, c);
  assert.deepEqual(notice.mentions, ["ou_test_lead", "ou_ci_observer"]); assert.equal(notice.approved, false);
  value.summary.findings = []; value.summary.decision.status = "passed";
  assert.deepEqual(pipelineCheckNotification(value, c).mentions, ["ou_ci_observer"]);
  delete c.people.observer.feishu;
  assert.throws(() => pipelineCheckNotification(value, c), /真实飞书ID/);
});
test("流水线最多展示三条最高风险问题，更多去详情，正文只放一个强调字号", () => {
  const value = input();
  value.summary.findings = ["warning", "info", "error", "blocker", "error"].map((severity, i) => ({ severity, dimension: "coding", ruleId: `R/${i}`, file: `src/Issue${i}.java`, line: i + 1, message: `问题${i}`, suggestion: `建议${i}` }));
  const before = JSON.stringify(value), result = pipelineCheckNotification(value, config), elements = result.payload.card.body.elements;
  const titles = elements.filter((e) => /^\d\. (极高|严重|警告|提示)｜/.test(e.text?.content || ""));
  assert.deepEqual(titles.map((e) => e.text.content), ["1. 极高｜问题3", "2. 严重｜问题2", "3. 严重｜问题4"]);
  assert(elements.some((e) => e.text?.content.includes("另有 2 项问题")));
  for (const word of ["已取证", "待补", "待独立确认", "未授权"]) assert.ok(!JSON.stringify(result.payload).includes(word));
  assert.equal((renderPipelineReviewReport(value).match(/class="issue" data-risk=/g) || []).length, 5);
  assert.equal(JSON.stringify(value), before);
  const divs = elements.flatMap((e) => e.tag === "column_set" ? e.columns.flatMap((c) => c.elements) : [e]).filter((e) => e.tag === "div");
  assert.equal(divs.filter((e) => e.text.text_size === "heading-4").length, 1);
});
test("两机器人共用原生彩色数据块，标签和数量一起着色且非法数量被拒绝", () => {
  const columns = riskCountsElement({ blocker: 1, error: 2, warning: 3, info: 0 }).columns;
  assert.deepEqual(columns.map((c) => [c.elements[0].text.content, c.elements[0].text.text_color, c.background_style]), [
    ["极高 1", "carmine", "carmine-50"], ["严重 2", "red", "red-50"], ["警告 3", "orange", "orange-50"], ["提示 0", "blue", "blue-50"],
  ]);
  assert(columns.every((c) => c.elements[0].text.tag === "plain_text"));
  for (const invalid of ["1", -1, 0.5, NaN, undefined]) assert.throws(() => riskCountsElement({ blocker: 0, error: invalid, warning: 0, info: 0 }), /非负整数/);
});
