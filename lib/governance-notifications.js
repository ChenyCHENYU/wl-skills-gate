// Pure presentation: no credentials, network, approval, or issue-state mutation.
import { formatNotificationTime } from "./notification-time.js";
import { notificationText, riskCountsElement } from "./notification-style.js";
import { notificationRecipients, notificationMentionWarning, responsibilityReminder } from "./notification-people.js";
const clean = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
const md = (value, max) => clean(value, max).replace(/[\\`*_~\[\]<>]/g, "\\$&");
const button = (label, url) => ({ tag: "button", type: "default", text: { tag: "plain_text", content: label }, behaviors: [{ type: "open_url", default_url: url }] });
const card = (title, template, content, links) => {
  const [conclusion, next, ...metadata] = content.split("\n");
  return { msg_type: "interactive", card: { schema: "2.0", header: { template, title: { tag: "plain_text", content: clean(title, 160) } }, body: { elements: [
    notificationText(conclusion.replace(/^\*\*结论\*\*：/, ""), template, "heading-4"),
    { tag: "markdown", text_size: "normal", content: metadata.join("\n") },
    notificationText(next.replace(/^\*\*下一步\*\*：/, "下一步："), "blue"),
    ...links.map(([label, url]) => button(label, url)),
  ] } } };
};
function bounded(message, detailsUrl) {
  if (Buffer.byteLength(message.text, "utf8") <= 1800) return message;
  const suffix = `\n…内容已精简，查看完整详情：${detailsUrl}`;
  const budget = 1800 - Buffer.byteLength(suffix, "utf8"); let prefix = "";
  for (const character of message.text) { if (Buffer.byteLength(prefix + character, "utf8") > budget) break; prefix += character; }
  return { ...message, text: prefix + suffix, textTruncated: true };
}

const issueStatus = { open: "待认领处理", claimed: "已认领 · 待修复", awaitingVerification: "扫描通过 · 待独立复验", closed: "已独立复验关闭" };
const reminders = new Set(["unclaimed", "overdue", "reopened"]);
function renderIssueNotification(items, config) {
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
  const links = [["查看报告", evidence.reportUrl], ...(evidence.stage === "local-hook" ? [] : [["查看流水线", evidence.pipelineUrl]]), ["登录处理", `${project.issueBaseUrl.replace(/\/$/, "")}/${issue.id}`]];
  const text = `${label} ${issue.severity} / ${item.kind}\n项目/范围：${issue.project}/${issue.scope}\n规则：${clean(issue.ruleId, 100)}\n位置：${clean(issue.file)}${issue.line ? ":" + issue.line : ""}\n状态/版本：${status}/${issue.revision}\n主责/备份/升级：${issue.owner}/${issue.backup}/${issue.escalationOwner}\n处理期限：${formatNotificationTime(issue.resolveDueAt)}\nSHA：${evidence.sha}\n${links.map(([name, url]) => `${name}：${url}`).join("\n")}`;
  const template = issue.status === "closed" ? "green" : issue.status === "awaitingVerification" || issue.severity === "warning" ? "orange" : "red";
  return bounded({ category, text, payload: card(`[${label}] ${issue.project} · ${status}`, template, `**结论**：${md(status)}\n**下一步**：${next}\n**项目/范围**：${md(issue.project)}/${md(issue.scope)}\n**规则/位置**：${md(issue.ruleId, 100)} · ${md(issue.file, 160)}${issue.line ? ":" + issue.line : ""}\n**主责/备份/升级**：${md(issue.owner)}/${md(issue.backup)}/${md(issue.escalationOwner)}\n**期限**：${formatNotificationTime(issue.resolveDueAt)}\n**SHA**：${md(evidence.sha)}\n**事件/版本**：${md(item.kind)}/${issue.revision}`, links) }, project.issueBaseUrl);
}

export function issueNotification(items, config) {
  const subject=items[0].snapshot,override=config.projects[subject.project].scopes?.[subject.scope]?.notification?.technicalManager;
  if(override)config={...config,projects:{...config.projects,[subject.project]:{...config.projects[subject.project],technicalManager:override}}};
  const message=renderIssueNotification(items,config), issue=items[0].snapshot, project=config.projects[issue.project];
  const evidence=issue.pendingEvidence || issue.latestEvidence, executor=evidence.authorId;
  const manager=project.technicalManager, recipients=notificationRecipients(executor,project,config.people),{observer}=recipients;
  // A digest can contain several authors. The preview limit must never drop
  // responsibility reminders for findings beyond its first displayed item.
  const plans=[...new Map(items.map(item=>{const author=(item.snapshot.pendingEvidence || item.snapshot.latestEvidence).authorId;return [author,notificationRecipients(author,project,config.people)];})).values()];
  const mapped=plans.every(plan=>plan.complete),missing=plans.flatMap(plan=>plan.missing);
  if(config.people && plans.some(plan=>plan.executor && !Object.hasOwn(config.people,plan.executor)))throw new Error("报告执行人未登记实名映射，不能冒充已知人员发送");
  const mentionIds=[...new Set(plans.flatMap(plan=>plan.mentions))];
  const display=actor=>config.people?.[actor]?.name ? md(config.people[actor].name) : md(actor || "未核验");
  const counts=evidence.riskCounts;
  const summary=[`**项目领域**：【${md(project.domain || "未登记")}】 ${md(issue.project)}`,
    `**检查阶段**：${evidence.stage==="local-hook"?"第一道 · 项目Hook":evidence.stage==="ci"?"第二道 · CI合并/构建":"阶段待核验"}`,
    `**提交人**：${display(executor)}　｜　**技术经理**：${display(manager)}${observer ? `　｜　**同步**：${display(observer)}` : ""}`,
    `**发生时间**：${formatNotificationTime(evidence.occurredAt || issue.firstSourceOccurredAt)}`,
    `**通知时间**：${formatNotificationTime(items[0].createdAt || issue.openedAt)}`,
    ...(evidence.trace ? [`**分支**：${md(evidence.trace.sourceBranch || "未提供")} → ${md(evidence.trace.targetBranch || evidence.trace.branch || "未提供")}`,
      `**提交**：${md(evidence.trace.commits?.[0]?.subject || "无提交说明",160)}`] : []),
    ].join("\n");
  const elements=message.payload.card.body.elements, metadata=elements.find((element)=>element.tag==="markdown");
  metadata.content=summary+"\n\n"+metadata.content;
  if(counts) elements.splice(2,0,riskCountsElement(Object.fromEntries(["blocker","error","warning","info"].map((level)=>[level,counts[level]??0]))));
  if(plans.length===1)elements.push({tag:"markdown",text_size:"normal",content:responsibilityReminder({executor,manager,observer,people:config.people,mentions:mentionIds,closed:issue.status==="closed"})});
  else {
    const used=new Set(),person=actor=>{const id=config.people?.[actor]?.feishu?.id;if(mentionIds.includes(id)&&!used.has(id)){used.add(id);return `<at id="${id}"></at>`;}return display(actor);};
    const unique=key=>[...new Set(plans.map(plan=>plan[key]).filter(Boolean))].map(person).join("、");
    elements.push({tag:"markdown",text_size:"normal",content:["**请关注并完成闭环**",`${unique('executor') || '执行人待登记'} 请按完整报告处理问题，修复后自动复扫并完成回归验证。`,`${unique('manager') || '技术经理待登记'} 请核对当前报告、修复证据与回归结果，按权限确认闭环。`,...(plans.some(plan=>plan.observer)?[`${unique('observer')} 请同步关注处理进展与回归结果。`]:[])].join("\n")});
  }
  if(!mapped)elements.push(notificationText(notificationMentionWarning({complete:false,missing:[...new Map(missing.map(item=>[JSON.stringify(item),item])).values()]}),"orange","notation"));
  if(!mapped && message.payload.card.header.template!=="red"){message.payload.card.header.template="orange";elements[0]=notificationText("检查结果已记录｜责任人提醒尚未完成","orange","heading-4");}
  return {...message,mentions:mentionIds,mentionMappingComplete:mapped,mentionMissing:missing,notificationComplete:mapped};
}

const stages = {
  review: { label: "代码审核", status: { draft: "待技术经理审核", "changes-requested": "审核未通过 · 修复后再审核", approved: "审核已确认", rejected: "审核未通过", canceled: "审核已取消 · 不作为通过记录" } },
  build: { label: "构建", status: { running: "正在构建", success: "构建成功 · 待部署验证", failed: "构建失败", canceled: "已取消 · 无有效构建结果", "not-run": "未运行 · 无有效构建结果" } },
  deploy: { label: "发布验证", status: { running: "正在部署", success: "已部署 · 验证待完成", failed: "部署或验证失败", canceled: "已取消 · 无有效部署结果", "not-run": "未运行 · 无有效部署结果", verified: "环境验证通过 · 问题待独立关闭" } },
};
function renderLifecycleNotification(fact, config) {
  if (fact.category === "collection") {
    const project = config.projects[fact.project], recovered = fact.status === "recovered", status = recovered ? "采集已恢复" : "采集执行异常";
    const next = recovered ? "中央周期已恢复查询；项目质量和问题关闭仍以真实报告及独立复验为准" : "运维检查只读凭据、网络、必需作业和中央执行记录；恢复后自动补采，不将失联当作通过";
    const links = [["治理入口", fact.reportUrl], ["CI来源", fact.source.url]];
    const text = `执行提醒：${status}\n下一步：${next}\n项目/范围/来源：${fact.project}/${fact.scope}/${fact.sourceId}\n异常阶段/数量：${fact.errorStages.join(",") || "无"}/${fact.errorCount}\n主责/备份/升级：${project.owner}/${project.backup}/${project.escalationOwner}\n首次异常/当前观察：${formatNotificationTime(fact.firstFailureAt)} / ${formatNotificationTime(fact.source.observedAt)}\n执行记录：${fact.executionId}\n${links.map(([name, url]) => `${name}：${url}`).join("\n")}`;
    return bounded({ category: "reminder", text, payload: card(`[执行提醒] ${fact.project} · ${status}`, recovered ? "blue" : "red", `**结论**：${status}\n**下一步**：${next}\n**项目/范围/来源**：${md(fact.project)}/${md(fact.scope)}/${md(fact.sourceId)}\n**异常阶段/数量**：${md(fact.errorStages.join(",") || "无")}/${fact.errorCount}\n**主责/备份/升级**：${md(project.owner)}/${md(project.backup)}/${md(project.escalationOwner)}\n**首次异常/当前观察**：${formatNotificationTime(fact.firstFailureAt)} / ${formatNotificationTime(fact.source.observedAt)}\n**执行记录**：${md(fact.executionId)}`, links) }, project.issueBaseUrl);
  }
  const stage = stages[fact.category], label = stage.label, status = stage.status[fact.status], project = config.projects[fact.project];
  const next = fact.category === "review" ? fact.status === "draft" ? "非作者复核人核对九维证据、修前修后差异，再明确授权正式记录" : fact.status === "approved" ? "按当前候选版本进入受控构建；发布仍需独立授权" : "查看当前Review记录和要求" : fact.category === "build" ? fact.status === "success" ? "核对制品摘要并进入授权部署与环境验证" : "查看当前作业和失败原因；重新运行生成新事实" : fact.status === "verified" ? "独立复核当前修复问题；环境验证成功不自动关闭台账" : fact.status === "success" ? "执行实际环境验证，保留验证证据" : "核对部署结果与恢复记录";
  const links = [["查看记录", fact.reportUrl], ["查看流水线", fact.pipelineUrl], ["登录处理", project.issueBaseUrl]];
  const text = `${label}：${status}\n下一步：${next}\n项目/范围/环境：${fact.project}/${fact.scope}/${fact.environment || "无"}\nSHA：${fact.sha}\n主责/备份：${project.owner}/${project.backup}\n来源核验：${fact.source.system}/${fact.source.recordId}\n发生/采集：${formatNotificationTime(fact.occurredAt)} / ${formatNotificationTime(fact.source.observedAt)}\n${links.map(([name, url]) => `${name}：${url}`).join("\n")}`;
  const template = ["failed", "rejected", "changes-requested"].includes(fact.status) ? "red" : ["canceled", "not-run", "draft"].includes(fact.status) ? "orange" : "blue";
  return bounded({ category: fact.category, text, payload: card(`[${label}] ${fact.project} · ${status}`, template, `**结论**：${md(status)}\n**下一步**：${next}\n**项目/范围/环境**：${md(fact.project)}/${md(fact.scope)}/${md(fact.environment || "无")}\n**SHA**：${md(fact.sha)}\n**主责/备份**：${md(project.owner)}/${md(project.backup)}\n**来源核验**：${md(fact.source.system)}/${md(fact.source.recordId)}\n**发生/采集**：${formatNotificationTime(fact.occurredAt)} / ${formatNotificationTime(fact.source.observedAt)}${fact.artifactHash ? `\n**制品摘要**：${md(fact.artifactHash)}` : ""}`, links) }, project.issueBaseUrl);
}

export function lifecycleNotification(fact,config){
  const override=config.projects[fact.project].scopes?.[fact.scope]?.notification?.technicalManager;
  if(override)config={...config,projects:{...config.projects,[fact.project]:{...config.projects[fact.project],technicalManager:override}}};
  const message=renderLifecycleNotification(fact,config);
  const project=config.projects[fact.project],executor=fact.authorId,manager=project.technicalManager,recipients=notificationRecipients(executor,project,config.people),{observer,mentions,complete:mapped}=recipients;
  const high=['failed','rejected','changes-requested'].includes(fact.status);
  // Collection health deliberately has no candidate author. It must remain
  // deliverable as an incomplete reminder, rather than inventing an author.
  if(executor && config.people && !Object.hasOwn(config.people,executor))throw Error('运行结果执行人未登记实名映射，不能冒充已知人员发送');
  message.payload.card.body.elements.push({tag:'markdown',text_size:'normal',content:responsibilityReminder({executor,manager,observer,people:config.people,mentions,hasFindings:high})});
  if(!mapped)message.payload.card.body.elements.push(notificationText(notificationMentionWarning(recipients),'orange','notation'));
  if(!mapped && message.payload.card.header.template!=='red'){message.payload.card.header.template='orange';message.payload.card.body.elements[0]=notificationText('运行结果已记录｜责任人提醒尚未完成','orange','heading-4');}
  return {...message,mentions,mentionMappingComplete:mapped,mentionMissing:recipients.missing,notificationComplete:mapped};
}
