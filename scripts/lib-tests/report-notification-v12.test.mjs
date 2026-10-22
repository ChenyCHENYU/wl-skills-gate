import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeReports } from "../../lib/report.js";
import { issueNotification, lifecycleNotification } from "../../lib/governance-notifications.js";
import { formatNotificationTime } from "../../lib/notification-time.js";
import { validateCommitMessage } from "../../lib/commit-message.js";
import { validateReportCatalog, findingCatalog } from "../../lib/report-catalog.js";

const config = {
  people: {
    dev: { name: "开发甲", roles: ["developer"], feishu: { idType: "open_id", id: "ou_developer" } },
    lead: { name: "经理乙", roles: ["technical-manager"], feishu: { idType: "open_id", id: "ou_manager" } },
  },
  projects: {
    produce: {
      domain: "生产",
      owner: "owner",
      backup: "backup",
      technicalManager: "lead",
      requireRiskMentions: true,
      issueBaseUrl: "https://quality.example.invalid/issues",
    },
  },
};
function items(actor = "dev") {
  return [
    {
      kind: "opened",
      createdAt: "2026-10-19T08:00:00+08:00",
      snapshot: {
        id: "issue",
        project: "produce",
        scope: "pl:sit",
        ruleId: "SEC/XSS",
        file: "src/a.ts",
        line: 5,
        severity: "error",
        status: "open",
        revision: 1,
        owner: "owner",
        backup: "backup",
        escalationOwner: "lead",
        resolveDueAt: "2026-10-20T08:00:00+08:00",
        latestEvidence: {
          sha: "a".repeat(40),
          authorId: actor,
          stage: "ci",
          reportUrl: "https://quality.example.invalid/runs/fixed/report.html",
          pipelineUrl: "https://gitlab.example.invalid/1",
          riskCounts: { blocker: 0, error: 1, warning: 3, info: 0 },
          trace: {
            sourceBranch: "feature/fix",
            targetBranch: "sit",
            commits: [{ subject: "fix(校验): 参数校验-补充输入边界检查" }],
          },
        },
      },
    },
  ];
}
test("飞书卡片真实@技术经理与执行人，按provider ID去重并保留领域/分支/日期/数据", () => {
  const result = issueNotification(items(), config),
    body = result.payload.card.body.elements.find((e) => e.tag === "markdown").content;
  assert.deepEqual(result.mentions, ["ou_developer", "ou_manager"]);
  assert.match(result.payload.card.body.elements.at(-1).content, /<at id="ou_manager"><\/at>.*回归结果/);
  assert.match(body, /生产/);
  assert.match(body, /sit/);
  const metrics = result.payload.card.body.elements.find((e) => e.tag === "column_set" && e.columns.length === 4);
  assert.equal(metrics.columns[1].elements[0].text.content, "严重 1");
  assert.equal(metrics.columns[1].elements[0].text.text_color, "red");
  assert.equal(result.payload.card.body.elements[0].text.text_color, "red");
  assert.match(body, /提交人.*技术经理/);
  assert.match(body, /2026年10月19日/);
  assert.match(body, /第二道/);
  const same = issueNotification(items("lead"), config);
  assert.equal(same.mentions.length, 1);
  const missing = structuredClone(config);
  delete missing.people.dev;
  assert.throws(() => issueNotification(items(), missing), /映射/);
  const injection = items();
  injection[0].snapshot.latestEvidence.trace.commits[0].subject = '<at id="all"></at>';
  assert.ok(!issueNotification(injection, config).payload.card.body.elements.find((e) => e.tag === "markdown").content.includes('<at id="all">'));
});
test("通知统一转为北京时间年月日时分秒，不受输入时区和毫秒影响", () => {
  assert.equal(formatNotificationTime("2026-10-19T19:00:51.174+08:00"), "2026年10月19日 19:00:51");
  assert.equal(formatNotificationTime("2026-10-19T11:00:51.174Z"), "2026年10月19日 19:00:51");
  assert.equal(formatNotificationTime("2026-10-19T23:30:00-04:00"), "2026年10月20日 11:30:00");
  assert.equal(formatNotificationTime("2026-10-19T16:00:00Z"), "2026年10月20日 00:00:00");
  for (const value of [undefined, "bad", "2026-10-19T19:00:51", "2026-13-19T11:00:51Z"]) {
    assert.equal(formatNotificationTime(value), "未提供有效时间");
  }
  const input = items();
  input[0].snapshot.latestEvidence.occurredAt = "2026-10-19T19:00:51.174+08:00";
  const before = JSON.stringify(input);
  const message = issueNotification(input, config);
  const body = message.payload.card.body.elements.find((e) => e.tag === "markdown").content;
  assert.match(body, /发生时间.*2026年10月19日 19:00:51/);
  assert.match(body, /通知时间.*2026年10月19日 08:00:00/);
  assert.match(body, /期限.*2026年10月20日 08:00:00/);
  assert.match(body, /提交人.*开发甲/);
  assert.match(body, /技术经理.*经理乙/);
  assert.ok(!body.includes("北京时间"));
  assert.ok(!body.includes("（dev）"));
  assert.ok(!body.includes("ISO时区"));
  assert.ok(!body.includes("T19:00:51"));
  assert.equal(JSON.stringify(input), before, "展示格式不得改写机器证据");
});
test("正式治理通知沿用经理本人提交同步李月，群@不等于审核确认", () => {
  const c = structuredClone(config); c.projects.produce.managerSubmissionNotify = "observer";
  c.people.observer = { name: "李月", roles: ["quality-observer"], feishu: { idType: "user_id", id: "test_observer" } };
  const result = issueNotification(items("lead"), c);
  assert.deepEqual(result.mentions, ["ou_manager", "test_observer"]);
  assert.match(result.payload.card.body.elements.find((e) => e.tag === "markdown").content, /同步.*李月/);
  delete c.people.observer.feishu;
  assert.throws(() => issueNotification(items("lead"), c), /实名@映射/);
});
test("构建、发布与采集健康的卡片和文字通知使用相同时间格式", () => {
  const fact = { category: "build", status: "failed", project: "produce", scope: "sit", sha: "a".repeat(40),
    occurredAt: "2026-10-19T11:00:51Z", reportUrl: "https://quality.example.invalid/report", pipelineUrl: "https://gitlab.example.invalid/job",
    source: { system: "jenkins", recordId: "job-1", observedAt: "2026-10-19T11:02:00Z", url: "https://gitlab.example.invalid/job" } };
  for (const input of [fact, { ...fact, category: "deploy" }, { ...fact, category: "collection", status: "attention", sourceId: "source-1", executionId: "execution-1", errorStages: ["collect"], errorCount: 1, firstFailureAt: fact.occurredAt }]) {
    const message = lifecycleNotification(input, config);
    assert.equal(message.payload.card.body.elements[0].text.text_color, "red");
    for (const output of [message.text, message.payload.card.body.elements.find((e) => e.tag === "markdown").content]) {
      assert.match(output, /2026年10月19日 19:00:51/);
      assert.match(output, /2026年10月19日 19:02:00/);
      assert.ok(!output.includes("T11:00:51"));
    }
  }
});
test("通知演示提交也遵守真实提交校验器，模拟标识放卡片标题", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wl-demo-commit-"));
  try {
    const file = path.join(root, "message");
    const policyRoot = path.resolve(import.meta.dirname, "../../fixtures/cases/02-new-error");
    writeFileSync(file, "demo: 生产工单导出检查（模拟提交）\n");
    assert.equal(validateCommitMessage(file, policyRoot).ok, false);
    writeFileSync(file, "fix(生产工单): 导出处理-补充异常处理与资源释放\n");
    assert.equal(validateCommitMessage(file, policyRoot).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("静态详情按文件/行展示，筛选不改结论，固定归档不被后续报告覆盖且HTML转义", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wl-report-v12-"));
  try {
    const summary = {
      schemaVersion: 1,
      run: {
        project: "produce",
        profile: "standard",
        eventId: "first",
        commitSha: "a".repeat(40),
        startedAt: "2026-10-19T00:00:00Z",
        durationMs: 1,
        tool: "gate",
        stage: "local-hook",
      },
      policy: {
        reportCatalog: {
          modules: [{ name: "生产 / 配料", paths: ["src"] }],
          standards: [{ title: "编码标准", version: "V3", clause: "XSS防护", ruleIds: ["SEC/XSS"] }],
        },
      },
      checks: [],
      counts: { new: 1, existing: 0, waived: 0, expired: 0, blockingNew: 1 },
      findings: [
        {
          fingerprint: "fp",
          ruleId: "SEC/XSS",
          severity: "error",
          status: "new",
          file: "src/a.ts",
          line: 5,
          endLine: 8,
          occurrences:[{line:5,endLine:8,message:"first"},{line:15,endLine:18,message:"second"}],
          relatedLocations:[{file:"src/b.ts",line:25,endLine:28}],
          message: '<script>alert("bad")</script>',
          suggestion: "fix safely",
          dimension: "编码规范",
        },
      ],
      decision: { status: "blocked", reasons: ["risk"] },
    };
    const first = writeReports(root, summary),
      before = readFileSync(path.join(first.archiveDir, "quality-report.html"), "utf8");
    assert.match(before, /第一道/);
    assert.match(before, /risk-filter/);
    assert.match(before, /src.*a.ts/);
    assert.match(before, /5–8/);
    assert.match(before,/15–18/);assert.match(before,/src\/b.ts:25–28/);
    assert.match(before, /生产 \/ 配料/);
    assert.match(before, /编码标准 · V3 · XSS防护/);
    assert.ok(!before.includes('<script>alert("bad")</script>'));
    assert.match(before, /&lt;script&gt;/);
    writeReports(root, { ...summary, run: { ...summary.run, eventId: "second" }, findings: [] });
    assert.equal(readFileSync(path.join(first.archiveDir, "quality-report.html"), "utf8"), before);
    const target = path.join(root, "evil");
    mkdirSync(target);
    symlinkSync(target, path.join(root, "runs", "link"));
    assert.throws(() => writeReports(root, { ...summary, run: { ...summary.run, eventId: "link" } }), /符号链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("报告业务/标准映射使用批准目录最长匹配，重复/越界不能遮蔽", () => {
  const catalog = {
    modules: [
      { name: "生产", paths: ["src"] },
      { name: "炉次", paths: ["src/heat"] },
    ],
    standards: [{ title: "编码标准", version: "V3", clause: "3.2", ruleIds: ["FE/X"] }],
  };
  validateReportCatalog(catalog);
  assert.equal(findingCatalog({ file: "src/heat/a.ts", ruleId: "FE/X" }, catalog).module, "炉次");
  assert.match(findingCatalog({ file: "src/a.ts", ruleId: "FE/X" }, catalog).standard, /3.2/);
  assert.equal(findingCatalog({ file: "other/a.ts", ruleId: "NONE" }, catalog).module, "未登记业务模块");
  assert.throws(() => validateReportCatalog({ ...catalog, modules: [{ name: "bad", paths: ["../escape"] }] }), /越界/);
  assert.throws(
    () => validateReportCatalog({ ...catalog, standards: [...catalog.standards, ...catalog.standards] }),
    /重复/
  );
});
