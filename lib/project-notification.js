import { projectReviewView } from "./project-review-report.js";
import { formatNotificationTime } from "./notification-time.js";
import path from "node:path";
import { projectNotificationScope } from "./project-notification-scope.js";
import { notificationText, riskCountsElement, repairAdviceElement, findingPreview, riskStyle } from "./notification-style.js";
import { notificationRecipients, notificationMentionWarning, responsibilityReminder } from "./notification-people.js";

const md = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\`*_~\[\]<>]/g, "\\$&");
const code = (value) => "`" + String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/`/g, "ˋ").replace(/</g, "‹").replace(/>/g, "›") + "`";
const compact = (value, max = 64) => { const chars = [...String(value || "")]; return chars.slice(0, max).join("") + (chars.length > max ? "…" : ""); };
export function projectCheckNotification(input, config) {
  const v = projectReviewView(input), project = config.projects[v.summary.run.project];
  if (!project) throw new Error("项目未登记，不能推送");
  const p = input.presentation || {}, executor = p.submitterId, manager = project.technicalManager;
  const scope = projectNotificationScope(p.event);
  if (!scope.notify) return { skipped: true, reason: scope.reason, payload: null, mentions: [], stage: "local-hook", displayOnly: true, approved: false };
  const recipients = notificationRecipients(executor, project, config.people);
  const { observer } = recipients, mapped = recipients.complete;
  for (const actor of recipients.actors) if (!config.people?.[actor]) throw new Error("通知责任人未登记，不能将未知身份当作飞书缺项发送");
  const mentionIds = recipients.mentions;
  const who = (actor, fallback) => md(config.people?.[actor]?.name || fallback || "待实名绑定");
  const url = new URL(p.reportUrl);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(p.simulation && p.localPreview && local && url.protocol === "http:"))) throw new Error("详情必须为HTTPS；只有明确标注的本机模拟允许localhost预览");
  if (local && !(p.simulation && p.localPreview)) throw new Error("本机详情不能冒充团队可访问的报告");
  const highCount = v.counts.blocker + v.counts.error;
  const requiredRisks = [v.counts.blocker ? `${v.counts.blocker} 项极高` : "", v.counts.error ? `${v.counts.error} 项严重` : ""].filter(Boolean).join("、");
  const verdict = v.blocked ? scope.phase === "before-merge" ? (highCount ? `⛔ 阻断合并｜${requiredRisks}问题必须解决` : "⛔ 暂不准入｜必需检查未通过，修复后重跑") :
    `⛔ ${scope.phase === "after-merge" ? "已合并后" : "分支更新后"}发现风险｜立即评估、修复并复验` : scope.phase === "before-merge" ? "检查未发现阻断问题｜需技术经理审核后再确认合并" : "更新后复查未发现阻断问题｜结果已记录";
  const sourceBranch = p.event.sourceBranch || v.trace.sourceBranch;
  const branch = sourceBranch && sourceBranch !== scope.targetBranch ? `${code(sourceBranch)} → ${code(scope.targetBranch)}` : code(scope.targetBranch);
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.summary.run.commitSha || "") ? `${code(v.summary.run.commitSha.slice(0, 8))} · ` : "";
  const metadata = [
    `**提交人**：${who(executor, p.submitterName)}　｜　**技术经理**：${who(manager, p.technicalManagerName)}${observer ? `　｜　**同步**：${who(observer)}` : ""}`,
    `**分支**：${branch}${Number.isSafeInteger(p.event.iid) && p.event.iid > 0 ? ` · 合并申请第 ${p.event.iid} 号` : ""}`,
    `**提交**：${md(v.commit?.subject || "未提供")}`,
    `**${sha ? "版本 / 时间" : "检查时间"}**：${sha}${formatNotificationTime(v.summary.run.finishedAt || v.summary.run.startedAt)}`,
  ].join("\n");
  const { visible, total, remaining } = findingPreview(v.findings);
  const details = visible.flatMap((f, index) => {
    const title = (f.message || f.ruleId).split(/[，。；]/)[0];
    const location = `${path.posix.basename(String(f.file || "流程检查").replace(/\\/g, "/"))}${f.line ? ":" + f.line + (f.endLine && f.endLine !== f.line ? "–" + f.endLine : "") : ""}`;
    const risk = riskStyle(f.severity);
    return [notificationText(`${index + 1}. ${risk.label}｜${compact(title, 36)}`, risk.color),
      { tag: "markdown", text_size: "normal", content: `${code(location)} · ${code(compact(f.ruleId, 96))}` }];
  });
  const next = [
    ...(v.pendingMessage ? [`**尚缺结果**：${md(v.pendingMessage.replace(/^尚缺：/, ""))}`] : []),
  ].join("\n");
  const button = (label, target, type) => ({ tag: "button", type, width: "fill", text: { tag: "plain_text", content: label }, behaviors: [{ type: "open_url", default_url: target }] });
  const payload = { msg_type: "interactive", card: { schema: "2.0", header: { template: v.blocked ? "red" : !mapped ? "orange" : "blue", padding: "10px 16px 10px 16px", title: { tag: "plain_text", content: `${p.simulation ? "【模拟】" : ""}${project.domain || p.domain || "未登记"} · ${v.summary.run.project} · ${scope.eventLabel}${!mapped ? " · 责任人提醒未完成" : ""}` } }, body: { padding: "10px 16px 12px 16px", vertical_spacing: "6px", elements: [
    notificationText(verdict, v.blocked ? "red" : "blue", "heading-4"),
    { tag: "markdown", text_size: "normal", content: metadata }, riskCountsElement(v.counts), { tag: "hr" },
    notificationText("当前检查结果 · 修复未核验", "grey", "notation"),
    ...(!mapped ? [notificationText(notificationMentionWarning(recipients), "orange")] : []),
    ...(total ? [notificationText(`重点问题 · 展示 ${visible.length}/${total} 项`)] : []),
    ...details,
    ...(remaining ? [notificationText(`另有 ${remaining} 项问题，点击下方按钮查看全部。`, "grey")] : []),
    ...(visible.length ? [repairAdviceElement(visible.map((f, i) => `${i + 1}. ${compact(f.suggestion || "核对业务影响并修复，完整定位见详情", 100)}`).join("\n"))] : [notificationText("本轮没有列出代码问题；仍需核对各项检查是否完成。")]),
    ...(next ? [{ tag: "markdown", text_size: "normal", content: next }] : []),
    ...(p.simulation || local ? [notificationText([p.simulation ? "演示数据，未执行真实检查" : "", local ? "详情仅本机" : ""].filter(Boolean).join(" · "), "grey", "notation")] : []),
    { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [button("查看九维检查详情", url.href, "primary")] },
      { tag: "column", width: "weighted", weight: 1, elements: [button("直接定位编码问题", new URL("#dimension-coding", url).href, "default")] },
    ] },
    { tag: "markdown", text_size: "normal", content: responsibilityReminder({ executor, manager, observer, people: config.people, mentions: mentionIds, hasFindings: total > 0 || v.blocked }) },
  ] } } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 20000) throw new Error("项目通知超出飞书卡片预算");
  return { payload, mentions: mentionIds, mentionMappingComplete: mapped, mentionMissing: recipients.missing, notificationComplete: mapped, stage: "local-hook", scope, displayOnly: true, approved: false };
}
