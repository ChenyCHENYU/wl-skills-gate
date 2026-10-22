import path from "node:path";
import { pipelineReviewView } from "./project-review-report.js";
import { QUALITY_TARGET_BRANCHES } from "./project-notification-scope.js";
import { formatNotificationTime } from "./notification-time.js";
import { notificationText, riskCountsElement, repairAdviceElement, findingPreview, riskStyle } from "./notification-style.js";
import { notificationActors, responsibilityReminder } from "./notification-people.js";

const md = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\`*_~\[\]<>]/g, "\\$&");
const code = (value) => "`" + String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/`/g, "ˋ").replace(/</g, "‹").replace(/>/g, "›") + "`";

// Read-only CI presentation. It never reclassifies a local Hook as CI or grants release authority.
export function pipelineCheckNotification(input, config) {
  const v = pipelineReviewView(input), p = input.presentation || {}, project = config.projects[v.summary.run.project];
  if (!project) throw new Error("流水线项目未登记");
  const branch = v.trace.branch || v.trace.targetBranch;
  if (!QUALITY_TARGET_BRANCHES.includes(branch) && !(p.validationBranch===true && p.approvedBranch===branch)) return { skipped: true, payload: null, reason: "非六目标分支且未批准的验证分支不发群", stage: "ci" };
  if(input.notificationTotals){
    for(const level of ['blocker','error','warning','info'])if(!Number.isSafeInteger(input.notificationTotals[level]) || input.notificationTotals[level]<v.counts[level])throw Error('预览风险计数与原始报告不一致');
    v.counts=Object.fromEntries(['blocker','error','warning','info'].map(level=>[level,input.notificationTotals[level]]));
  }
  const totalFindings=Object.values(v.counts).reduce((a,b)=>a+b,0);
  if(p.requireResolvedFindings && totalFindings>0)v.blocked=true;
  const projectSurface=p.surface==='project-summary';
  const executor = p.submitterId, manager = project.technicalManager;
  const { observer, actors } = notificationActors(executor, project, config.people);
  const people = actors.map((actor) => ({ actor, ...config.people?.[actor] }));
  const mapped = !!executor && !!manager && people.every((person) => person.name && ["open_id", "user_id"].includes(person.feishu?.idType) && /^[A-Za-z0-9_-]{1,128}$/.test(person.feishu.id || "") && person.feishu.id !== "all" && (person.feishu.idType !== "open_id" || person.feishu.id.startsWith("ou_")));
  if ((v.blocked || observer) && project.requireRiskMentions !== false && !mapped) throw new Error("流水线通知缺触发人/技术经理/同步人真实飞书ID");
  const mentions = mapped ? [...new Set(people.filter((person) => v.blocked || person.actor === observer).map((person) => person.feishu.id))] : [];
  const who = (actor, fallback) => md(config.people?.[actor]?.name || fallback || "待实名绑定");
  const url = new URL(p.reportUrl), local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(local && p.simulation && p.localPreview && url.protocol === "http:")) || (local && !(p.simulation && p.localPreview))) throw new Error("流水线详情只允许HTTPS，或明确标注的模拟本机预览");
  const high = v.counts.blocker + v.counts.error;
  const requiredRisks = [v.counts.blocker ? `${v.counts.blocker} 项极高` : "", v.counts.error ? `${v.counts.error} 项严重` : ""].filter(Boolean).join("、");
  const metadata = [
    `**触发人**：${who(executor, p.submitterName)}　｜　**技术经理**：${who(manager, p.technicalManagerName)}${observer ? `　｜　**同步**：${who(observer)}` : ""}`,
    `**分支**：${code(branch)}${p.environment ? `　｜　**环境**：${md(p.environment)}` : ""}`,
    `**流水线**：${md(p.pipelineLabel || "未提供真实作业")}`,
    `**提交**：${md(v.commit?.subject || "未提供")}`,
    `**检查时间**：${formatNotificationTime(v.summary.run.finishedAt || v.summary.run.startedAt)}`,
  ].join("\n");
  const stateColors = { blocked: "red", failed: "red", pending: "orange", passed: "green", "not-run": "grey" };
  const states = (p.executionStates || []).map((item) => notificationText(`${item.name}：${item.result}`, stateColors[item.status] || "default"));
  const {visible}=findingPreview(v.findings),total=totalFindings,remaining=total-visible.length;
  const failures = visible.flatMap((f, i) => {
    const location = `${path.posix.basename(String(f.file || "流水线执行"))}${f.line ? ":" + f.line + (f.endLine && f.endLine !== f.line ? "–" + f.endLine : "") : ""}`;
    const risk = riskStyle(f.severity);
    return [notificationText(`${i + 1}. ${risk.label}｜${[...(f.message || f.ruleId)].slice(0, 48).join("")}`, risk.color),
      { tag: "markdown", text_size: "normal", content: `${code(location)} · ${code(f.ruleId)}` }];
  });
  const footer = [
    ...(v.pendingMessage ? [`**尚缺结果**：${md(v.pendingMessage.replace(/^尚缺：/, ""))}`] : []),
  ].join("\n");
  const button = (label, target, type) => ({ tag: "button", type, width: "fill", text: { tag: "plain_text", content: label }, behaviors: [{ type: "open_url", default_url: target }] });
  const payload = { msg_type: "interactive", card: { schema: "2.0", header: { template: v.blocked ? "red" : "blue", padding: "10px 16px 10px 16px", title: { tag: "plain_text", content: `${p.simulation ? "【模拟】" : ""}${project.domain || "未登记"} · ${v.summary.run.project} · ${projectSurface?'项目合并检查（服务端补验）':'CI构建准入'}` } }, body: { padding: "10px 16px 12px 16px", vertical_spacing: "6px", elements: [
    notificationText(v.blocked ? `⛔ 构建准入拦截｜${high ? `${requiredRisks}问题必须解决` : total ? '剩余问题全部修复后复扫' : "必需检查未有效完成"}` : "机器结果已记录｜等待当前版本正式Review与构建核验", v.blocked ? "red" : "blue", "heading-4"),
    { tag: "markdown", text_size: "normal", content: metadata }, riskCountsElement(v.counts), { tag: "hr" },
    ...(states.length ? states : [notificationText("尚未提供完整执行状态，不标记构建或部署成功。", "orange")]),
    ...(total ? [notificationText(`重点问题 · 展示 ${visible.length}/${total} 项`)] : []), ...failures,
    ...(remaining ? [notificationText(`另有 ${remaining} 项问题，点击下方按钮查看全部。`, "grey")] : []),
    ...(visible.length ? [repairAdviceElement(visible.map((f, i) => `${i + 1}. ${[...(f.suggestion || "核对真实失败原因，修复后重跑本轮检查")].slice(0, 100).join("")}`).join("\n"))] : [notificationText("本轮没有列出代码问题；仍需核对各项检查是否完成。")]),
    ...(footer ? [{ tag: "markdown", text_size: "normal", content: footer }] : []),
    ...(p.simulation || !mapped || local ? [notificationText([p.simulation ? "演示数据，未实际构建或部署" : "", !mapped ? "真实@待名单绑定" : "", local ? "详情仅本机" : ""].filter(Boolean).join(" · "), "grey", "notation")] : []),
    { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [button("查看九维检查详情", url.href, "primary")] },
      { tag: "column", width: "weighted", weight: 1, elements: [button("定位失败阶段", new URL("#pipeline-stages", url).href, "default")] },
    ] },
    { tag: "markdown", text_size: "normal", content: responsibilityReminder({ executor, manager, observer, people: config.people, mentions, hasFindings: total > 0 || v.blocked }) },
  ] } } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 20000) throw new Error("流水线卡片超出飞书预算");
  return { payload, mentions, mentionMappingComplete: mapped, stage: "ci", displayOnly: true, approved: false };
}
