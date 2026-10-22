import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseYamlLite } from "../../lib/yaml-lite.js";
import { projectReviewView, renderProjectReviewReport } from "../../lib/project-review-report.js";
import { projectCheckNotification } from "../../lib/project-notification.js";
import { projectNotificationScope, QUALITY_TARGET_BRANCHES } from "../../lib/project-notification-scope.js";

function fixture() {
  return {
    summary: { run: { project: "produce", stage: "local-hook", startedAt: "2026-10-19T11:00:51.174Z", trace: { sourceBranch: "quality-validation/produce", commits: [{ subject: "fix(导出): 异常处理-补充资源释放", author: { name: "作者甲" } }] } },
      findings: [{ dimension: "coding", severity: "error", ruleId: "PMD/CloseResource", file: "src/Example.java", line: 12, endLine: 16, message: '<script>alert("bad")</script>', suggestion: "确认资源所有权后释放", occurrences: [{ line: 12, endLine: 16 }, { line: 32, endLine: 36 }], relatedLocations: [{ file: "src/Other.java", line: 18, endLine: 19 }] }],
      decision: { status: "blocked" } },
    dimensions: [{ id: "coding", status: "evidence-ready", note: "已产出机器证据，尚未修复" }],
    presentation: { simulation: true, localPreview: true, hook: "合并请求代码检查", event: { kind: "merge-request", action: "update", state: "opened", sourceBranch: "quality-validation/produce", targetBranch: "sit", iid: 12 }, submitterId: "developer", submitterName: "开发甲", technicalManagerName: "经理乙", reportUrl: "http://127.0.0.1:47861/project-review.html" },
  };
}
const buttons = (elements) => elements.find((e) => e.tag === "column_set" && e.columns.length === 2);
const config = { projects: { produce: { technicalManager: "manager", domain: "生产", requireRiskMentions: true } }, people: {
  developer: { name: "开发甲", feishu: { idType: "open_id", id: "ou_test_developer" } }, manager: { name: "经理乙", feishu: { idType: "user_id", id: "test_manager" } },
} };
test("项目报告九维始终完整，未补证不标通过，阻断发现覆盖证据齐状态", () => {
  const input = fixture(), before = JSON.stringify(input), view = projectReviewView(input);
  assert.equal(view.rows.length, 9); assert.equal(view.counts.error, 1);
  assert.equal(view.rows.find((d) => d.id === "coding").state, "blocked");
  assert.equal(view.rows.find((d) => d.id === "scan").state, "blocked");
  assert.equal(view.rows.find((d) => d.id === "branch").state, "pending");
  assert.equal(view.approved, false); assert.equal(view.displayOnly, true);
  const html = renderProjectReviewReport(input);
  assert.equal((html.match(/class="dimension-section" id="dimension-/g) || []).length, 9);
  assert.match(html, /提交人/); assert.match(html, /开发甲/); assert.match(html, /经理乙/);
  assert.match(html, /2026年10月19日 19:00:51/); assert.ok(!html.includes("北京时间"));
  assert.match(html, /12–16、32–36/); assert.match(html, /src\/Other.java:18–19/);
  assert.match(html, /&lt;script&gt;/); assert.ok(!html.includes('<script>alert("bad")</script>'));
  assert.equal(JSON.stringify(input), before);
  input.summary.findings[0].dimension = "unknown";
  assert.match(renderProjectReviewReport(input), /待归类发现/);
});
test("项目内报告与机器人拒绝CI，不能混用阶段", () => {
  const input = fixture(); input.summary.run.stage = "ci";
  assert.throws(() => renderProjectReviewReport(input), /CI报告/);
  assert.throws(() => projectCheckNotification(input, config), /CI报告/);
});
test("项目通知真实@两人，同一provider ID去重；仅姓名、all和错误ID类型不能发送阻断通知", () => {
  const input = fixture(), notice = projectCheckNotification(input, config);
  assert.deepEqual(notice.mentions, ["ou_test_developer", "test_manager"]);
  const body = notice.payload.card.body.elements.find((e) => e.tag === "markdown").content;
  assert.match(body, /提交人.*开发甲.*技术经理.*经理乙/);
  assert.match(notice.payload.card.body.elements.at(-1).content, /ou_test_developer.*修复[\s\S]*test_manager.*回归结果/);
  assert.ok(!JSON.stringify(notice).includes("查看流水线")); assert.ok(!body.includes("北京时间"));
  assert.equal(buttons(notice.payload.card.body.elements).columns[0].elements[0].behaviors[0].default_url, input.presentation.reportUrl);
  const same = structuredClone(config); same.people.manager.feishu = same.people.developer.feishu;
  assert.equal(projectCheckNotification(input, same).mentions.length, 1);
  for (const kind of ["missing", "all", "union_id"]) {
    const broken = structuredClone(config);
    if (kind === "missing") delete broken.people.manager.feishu;
    else if (kind === "all") broken.people.manager.feishu.id = "all";
    else broken.people.manager.feishu.idType = "union_id";
    assert.throws(() => projectCheckNotification(input, broken), /真实飞书ID/);
  }
});
test("详情只接受安全协议，本机地址仅在明确标记的模拟中使用", () => {
  const input = fixture(); input.presentation.localPreview = false;
  assert.throws(() => projectCheckNotification(input, config), /HTTPS|本机/);
  input.presentation.reportUrl = "javascript:alert(1)";
  assert.throws(() => projectCheckNotification(input, config), /HTTPS/);
  input.presentation.reportUrl = "https://quality.example.invalid/reports/one";
  const result = projectCheckNotification(input, config);
  assert.equal(buttons(result.payload.card.body.elements).columns[0].elements[0].behaviors[0].default_url, input.presentation.reportUrl);
});
test("技术经理本人提交时本人只@一次，同时@李月；姓名缺ID和别名同人不能漏掉同步", () => {
  const c = structuredClone(config); c.projects.produce.managerSubmissionNotify = "observer";
  c.people.observer = { name: "李月", feishu: { idType: "open_id", id: "ou_test_observer" } };
  const value = fixture(); value.presentation.submitterId = "manager";
  const result = projectCheckNotification(value, c);
  assert.deepEqual(result.mentions, ["test_manager", "ou_test_observer"]);
  assert.equal((JSON.stringify(result.payload).match(/<at id=\\"test_manager\\">/g) || []).length, 1);
  assert.match(result.payload.card.body.elements.find((e) => e.tag === "markdown").content, /技术经理.*经理乙.*同步.*李月/);
  assert.equal(result.approved, false);
  const alias = structuredClone(c); alias.people.developer.feishu = alias.people.manager.feishu;
  value.presentation.submitterId = "developer";
  assert.deepEqual(projectCheckNotification(value, alias).mentions, ["test_manager", "ou_test_observer"]);
  value.presentation.submitterId = "manager"; value.summary.findings = []; value.summary.decision.status = "passed";
  assert.deepEqual(projectCheckNotification(value, c).mentions, ["ou_test_observer"], "经理本人提交即使零阻断也同步李月");
  delete c.people.observer.feishu;
  assert.throws(() => projectCheckNotification(value, c), /真实飞书ID/);
});
test("个人分支只本地反馈，六目标MR和目标更新才进入群通知；不能从拟推送字段猜目标", () => {
  for (const targetBranch of QUALITY_TARGET_BRANCHES) {
    for (const action of ["open", "update", "reopen"]) {
      const result = projectNotificationScope({ kind: "merge-request", targetBranch, action, state: "opened" });
      assert.equal(result.notify, true); assert.equal(result.phase, "before-merge");
    }
    assert.equal(projectNotificationScope({ kind: "target-update", ref: targetBranch }).notify, true);
  }
  for (const event of [undefined, { kind: "local-commit", ref: "feature/user" }, { kind: "local-push", ref: "feature/user" },
    { kind: "target-update", ref: "feature/user" }, { kind: "merge-request", action: "open", state: "opened", targetBranch: "sit-extra" },
    { kind: "merge-request", action: "close", state: "closed", targetBranch: "sit" }]) {
    assert.equal(projectNotificationScope(event).notify, false);
    const input = fixture(); input.presentation.event = event; input.presentation.intendedTarget = "sit";
    assert.equal(projectCheckNotification(input, config).skipped, true);
  }
});
test("紧凑卡片结论优先、代码只露文件名/行号、人员同一行、两按钮同一行", () => {
  const notice = projectCheckNotification(fixture(), config), elements = notice.payload.card.body.elements;
  assert.match(elements[0].text.content, /^⛔ 阻断合并｜/);
  assert.equal(elements[0].text.text_color, "red");
  assert.ok(!JSON.stringify(notice.payload).includes("拟推送到"));
  assert.match(elements.find((e) => e.tag === "markdown").content, /\*\*分支\*\*：`quality-validation\/produce` → `sit`/);
  const location = elements.find((e) => e.tag === "markdown" && e.content.includes("`Example.java:"));
  assert.match(location.content, /`Example.java:12–16` · `PMD\/CloseResource`/);
  assert.ok(!location.content.includes("src/Example.java"));
  const advice = elements.find((e) => e.tag === "column_set" && e.columns[0].background_style === "blue-50" && e.columns.length === 1);
  assert.match(advice.columns[0].elements[0].text.content, /修复建议/);
  assert.equal(advice.columns[0].elements[1].text.text_color, "blue");
  assert.match(advice.columns[0].elements[1].text.content, /确认资源所有权后释放/);
  assert.match(elements.at(-1).content, /请关注并完成闭环/);
  assert.equal(buttons(elements).columns.length, 2);
  assert.equal(buttons(elements).columns[1].elements[0].behaviors[0].default_url.endsWith("#dimension-coding"), true);
  const after = fixture(); after.presentation.event = { ...after.presentation.event, action: "merge", state: "merged" };
  const text = projectCheckNotification(after, config).payload.card.body.elements[0].text.content;
  assert.match(text, /已合并后发现风险/); assert.ok(!text.includes("阻断合并"));
  const invalid = fixture(); invalid.summary.findings = []; invalid.summary.decision.status = "invalid";
  const failed = projectCheckNotification(invalid, config).payload.card.body.elements[0].text.content;
  assert.match(failed, /必需检查未通过/); assert.ok(!failed.includes("解决 0 项"));
});
test("问题多时只展示最高风险三条，所有问题在详情保留，去除模块重复和状态术语", () => {
  const input = fixture(); input.presentation.module = "重复模块名";
  input.summary.findings = ["info", "warning", "error", "blocker", "warning", "error"].map((severity, i) => ({ dimension: "coding", severity, ruleId: `R/${i}`, file: `src/File${i}.java`, line: i + 1, message: `问题${i}`, suggestion: `修复${i}` }));
  const before = JSON.stringify(input), result = projectCheckNotification(input, config), elements = result.payload.card.body.elements;
  const titles = elements.filter((e) => /^\d\. (极高|严重|警告|提示)｜/.test(e.text?.content || ""));
  assert.deepEqual(titles.map((e) => e.text.content), ["1. 极高｜问题3", "2. 严重｜问题2", "3. 严重｜问题5"]);
  assert(elements.some((e) => e.text?.content === "另有 3 项问题，点击下方按钮查看全部。"));
  const json = JSON.stringify(result.payload);
  for (const word of ["重复模块名", "已取证", "待补", "待独立确认", "未授权", "合并目标"]) assert.ok(!json.includes(word), word);
  assert.match(json, /尚缺结果/); assert.match(json, /回归结果/);
  assert.equal((renderProjectReviewReport(input).match(/class="issue" data-risk=/g) || []).length, 6);
  assert.equal(JSON.stringify(input), before);
  const divs = elements.flatMap((e) => e.tag === "column_set" ? e.columns.flatMap((c) => c.elements) : [e]).filter((e) => e.tag === "div");
  assert.equal(divs.filter((e) => e.text.text_size === "heading-4").length, 1);
  assert(divs.slice(1).every((e) => ["normal", "notation"].includes(e.text.text_size)));
  assert(elements.filter((e) => e.tag === "markdown").every((e) => e.text_size === "normal"));
});
test("零阻断不等于审核通过，后续流水线和复核不能混成缺少本地扫描", () => {
  const input = fixture(); input.summary.findings = []; input.summary.decision.status = "passed";
  input.dimensions = ["submission", "branch", "coding", "ui", "tests", "scan"].map((id) => ({ id, status: "evidence-ready" }));
  const view = projectReviewView(input), result = projectCheckNotification(input, config);
  assert.equal(view.pendingMessage, ""); assert.equal(result.approved, false);
  assert.match(result.payload.card.body.elements[0].text.content, /需技术经理审核/);
  assert.equal(view.rows.find((d) => d.id === "cicd").stateLabel, "由流水线继续检查");
  input.dimensions.find((d) => d.id === "ui").status = "pending-na-approval";
  assert.match(projectReviewView(input).pendingMessage, /界面与交互适用性/);
});
test("风险名称和数字采用飞书原生颜色字段，零值保留分类色；合并申请编号使用中文", () => {
  const input = fixture();
  const payload = projectCheckNotification(input, config).payload;
  const text = payload.card.body.elements.find((e) => e.tag === "markdown").content;
  const metrics = payload.card.body.elements.find((e) => e.tag === "column_set" && e.columns.length === 4);
  assert.deepEqual(metrics.columns.map((c) => [c.elements[0].text.content, c.elements[0].text.text_color]), [["极高 0", "carmine"], ["严重 1", "red"], ["警告 0", "orange"], ["提示 0", "blue"]]);
  assert.ok(!JSON.stringify(payload).includes("<font"));
  assert.match(text, /合并申请第 12 号/); assert.ok(!text.includes("MR !"));
  for (const [severity, color] of [["blocker", "carmine"], ["warning", "orange"], ["info", "blue"]]) {
    input.summary.findings[0].severity = severity;
    const metric = projectCheckNotification(input, config).payload.card.body.elements.find((e) => e.tag === "column_set" && e.columns.length === 4).columns.find((c) => c.elements[0].text.text_color === color);
    assert.match(metric.elements[0].text.content, / 1$/);
  }
});
test("前后端CI模板按同一六目标范围声明MR/push/schedule，验证分支必须显式批准", () => {
  const conditions = [];
  for (const file of ["gitlab-frontend.yml", "gitlab-backend.yml"]) {
    const source = readFileSync(new URL(`../../templates/ci/${file}`, import.meta.url), "utf8");
    const section = source.slice(source.indexOf("  rules:"), source.indexOf("  script:"));
    const { rules } = parseYamlLite(section);
    assert.equal(rules.at(-1).when, "never");
    assert.match(rules[0].if, /CI_MERGE_REQUEST_TARGET_BRANCH_NAME/);
    for (const rule of rules.slice(0, 3)) {
      const expression = rule.if.match(/=~ \/(.+)\/$/);
      assert(expression, `${file}: missing anchored target expression`);
      const matcher = new RegExp(expression[1]);
      for (const branch of QUALITY_TARGET_BRANCHES) assert.equal(matcher.test(branch), true);
      for (const branch of ["feature/user", "sit-extra", "prd/fix", "refs/tags/main", "main-old"]) assert.equal(matcher.test(branch), false);
    }
    assert.match(rules[3].if, /\$WL_QUALITY_VALIDATION_REF && \$CI_COMMIT_BRANCH == \$WL_QUALITY_VALIDATION_REF/);
    conditions.push(rules.map((rule) => rule.if || rule.when));
  }
  assert.deepEqual(conditions[0], conditions[1]);
});
