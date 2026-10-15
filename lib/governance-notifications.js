// Pure presentation: no credentials, network, approval, or issue-state mutation.
const clean = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
const md = (value, max) => clean(value, max).replace(/[\\`*_~\[\]<>]/g, "\\$&");
const button = (label, url) => ({ tag: "button", type: "default", text: { tag: "plain_text", content: label }, behaviors: [{ type: "open_url", default_url: url }] });
const card = (title, template, content, links) => ({ msg_type: "interactive", card: { schema: "2.0", header: { template, title: { tag: "plain_text", content: clean(title, 160) } }, body: { elements: [{ tag: "markdown", content }, ...links.map(([label, url]) => button(label, url))] } } });
function bounded(message, detailsUrl) {
  if (Buffer.byteLength(message.text, "utf8") <= 1800) return message;
  const suffix = `\n…内容已精简，查看完整详情：${detailsUrl}`;
  const budget = 1800 - Buffer.byteLength(suffix, "utf8"); let prefix = "";
  for (const character of message.text) { if (Buffer.byteLength(prefix + character, "utf8") > budget) break; prefix += character; }
  return { ...message, text: prefix + suffix, textTruncated: true };
}

const issueStatus = { open: "待认领处理", claimed: "已认领 · 待修复", awaitingVerification: "扫描通过 · 待独立复验", closed: "已独立复验关闭" };
const reminders = new Set(["unclaimed", "overdue", "reopened"]);
export function issueNotification(items, config) {
  const issues = items.map((x) => x.snapshot), issue = issues[0], project = config.projects[issue.project];
  if (items.length > 1) {
    const text = `质量警告汇总：${items.length} 项待处理\n项目：${issue.project}\n${issues.slice(0, 5).map((x) => `${clean(x.ruleId, 80)} ${clean(x.file, 100)}`).join("\n")}\n主责/备份：${project.owner}/${project.backup}\n台账：${project.issueBaseUrl}`;
    return bounded({ category: "quality", text, payload: card(`[代码质量] ${issue.project} · ${items.length}项警告待处理`, "orange", `**结论**：${items.length}项警告待处理\n**下一步**：主备查看台账、评估影响并按期限处理\n**项目**：${md(issue.project)}\n**主责/备份**：${md(project.owner)}/${md(project.backup)}\n${issues.slice(0, 5).map((x) => `- ${md(x.ruleId, 80)} · ${md(x.file, 100)}`).join("\n")}`, [["登录处理", project.issueBaseUrl]]) }, project.issueBaseUrl);
  }
  const item = items[0], evidence = issue.pendingEvidence || issue.latestEvidence;
  const category = reminders.has(item.kind) || issue.category === "missing" ? "reminder" : "quality";
  const label = category === "reminder" ? "处理提醒" : "代码质量";
  const status = issueStatus[issue.status];
  const next = issue.status === "closed" ? "查看独立复验记录；复发会重新打开" : issue.status === "awaitingVerification" ? "独立非作者复核人查看当前修复版本和实际业务复验，确认后关闭" : "主备查看定位与建议，确认修复方案后由脚本执行并复扫";
  const links = [["查看报告", evidence.reportUrl], ["查看流水线", evidence.pipelineUrl], ["登录处理", `${project.issueBaseUrl.replace(/\/$/, "")}/${issue.id}`]];
  const text = `${label} ${issue.severity} / ${item.kind}\n项目/范围：${issue.project}/${issue.scope}\n规则：${clean(issue.ruleId, 100)}\n位置：${clean(issue.file)}${issue.line ? ":" + issue.line : ""}\n状态/版本：${status}/${issue.revision}\n主责/备份/升级：${issue.owner}/${issue.backup}/${issue.escalationOwner}\n处理期限：${issue.resolveDueAt}\nSHA：${evidence.sha}\n${links.map(([name, url]) => `${name}：${url}`).join("\n")}`;
  const template = issue.status === "closed" ? "green" : issue.status === "awaitingVerification" || issue.severity === "warning" ? "orange" : "red";
  return bounded({ category, text, payload: card(`[${label}] ${issue.project} · ${status}`, template, `**结论**：${md(status)}\n**下一步**：${next}\n**项目/范围**：${md(issue.project)}/${md(issue.scope)}\n**规则/位置**：${md(issue.ruleId, 100)} · ${md(issue.file, 160)}${issue.line ? ":" + issue.line : ""}\n**主责/备份/升级**：${md(issue.owner)}/${md(issue.backup)}/${md(issue.escalationOwner)}\n**期限**：${md(issue.resolveDueAt)}\n**SHA**：${md(evidence.sha)}\n**事件/版本**：${md(item.kind)}/${issue.revision}`, links) }, project.issueBaseUrl);
}

const stages = {
  review: { label: "Review", status: { draft: "草稿 · 待确认", "changes-requested": "需修复 · 待复审", approved: "已授权确认", rejected: "未批准", canceled: "已取消 · 无有效批准" } },
  build: { label: "构建", status: { running: "正在构建", success: "构建成功 · 待部署验证", failed: "构建失败", canceled: "已取消 · 无有效构建结果", "not-run": "未运行 · 无有效构建结果" } },
  deploy: { label: "发布验证", status: { running: "正在部署", success: "已部署 · 验证待完成", failed: "部署或验证失败", canceled: "已取消 · 无有效部署结果", "not-run": "未运行 · 无有效部署结果", verified: "环境验证通过 · 问题待独立关闭" } },
};
export function lifecycleNotification(fact, config) {
  const stage = stages[fact.category], label = stage.label, status = stage.status[fact.status], project = config.projects[fact.project];
  const next = fact.category === "review" ? fact.status === "draft" ? "非作者复核人核对九维证据、修前修后差异，再明确授权正式记录" : fact.status === "approved" ? "按当前候选版本进入受控构建；发布仍需独立授权" : "查看当前Review记录和要求" : fact.category === "build" ? fact.status === "success" ? "核对制品摘要并进入授权部署与环境验证" : "查看当前作业和失败原因；重新运行生成新事实" : fact.status === "verified" ? "独立复核当前修复问题；环境验证成功不自动关闭台账" : fact.status === "success" ? "执行实际环境验证，保留验证证据" : "核对部署结果与恢复记录";
  const links = [["查看记录", fact.reportUrl], ["查看流水线", fact.pipelineUrl], ["登录处理", project.issueBaseUrl]];
  const text = `${label}：${status}\n下一步：${next}\n项目/范围/环境：${fact.project}/${fact.scope}/${fact.environment || "无"}\nSHA：${fact.sha}\n主责/备份：${project.owner}/${project.backup}\n来源核验：${fact.source.system}/${fact.source.recordId}\n发生/采集：${fact.occurredAt}/${fact.source.observedAt}\n${links.map(([name, url]) => `${name}：${url}`).join("\n")}`;
  const template = ["failed", "rejected", "changes-requested"].includes(fact.status) ? "red" : ["canceled", "not-run", "draft"].includes(fact.status) ? "orange" : "blue";
  return bounded({ category: fact.category, text, payload: card(`[${label}] ${fact.project} · ${status}`, template, `**结论**：${md(status)}\n**下一步**：${next}\n**项目/范围/环境**：${md(fact.project)}/${md(fact.scope)}/${md(fact.environment || "无")}\n**SHA**：${md(fact.sha)}\n**主责/备份**：${md(project.owner)}/${md(project.backup)}\n**来源核验**：${md(fact.source.system)}/${md(fact.source.recordId)}\n**发生/采集**：${md(fact.occurredAt)}/${md(fact.source.observedAt)}${fact.artifactHash ? `\n**制品摘要**：${md(fact.artifactHash)}` : ""}`, links) }, project.issueBaseUrl);
}
