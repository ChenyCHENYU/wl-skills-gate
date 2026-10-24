// Notification recipients only. Being mentioned never grants Review authority.
export function validNotificationPerson(person, { requireVerified = false } = {}) {
  const identity = person?.feishu;
  return !!(typeof person?.name === "string" && person.name.trim()
    && ["open_id", "user_id"].includes(identity?.idType)
    && typeof identity.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(identity.id) && identity.id !== "all"
    && (identity.idType !== "open_id" || identity.id.startsWith("ou_"))
    && (!requireVerified || identity.verified === true || identity.identityVerified === true));
}

export function notificationActors(executor, project, people = {}) {
  const manager = project.technicalManager;
  const executorId = validNotificationPerson(people[executor]) ? people[executor].feishu.id : undefined;
  const managerId = validNotificationPerson(people[manager]) ? people[manager].feishu.id : undefined;
  const managerSubmission = !!executor && !!manager && (executor === manager || (!!executorId && executorId === managerId));
  const observer = managerSubmission ? project.managerSubmissionNotify : undefined;
  if (observer && (observer === manager || (people[observer]?.feishu?.id && people[observer].feishu.id === managerId))) throw new Error("同步人不能与技术经理为同一飞书人员");
  return { managerSubmission, observer, actors: [...new Set([executor, manager, observer].filter(Boolean))] };
}

// All quality results, including clean scans and closure notices, retain the
// executor and manager. Missing identity never implies a completed reminder.
export function notificationRecipients(executor, project, people = {}, options = {}) {
  const { managerSubmission, observer, actors } = notificationActors(executor, project, people);
  const manager = project.technicalManager;
  const roles = [["执行人", executor], ["技术经理", manager], ...(managerSubmission ? [["经理本人提交同步人", observer]] : [])];
  const missing = roles.flatMap(([role, actor]) => {
    if (!actor) return [{ role, actor: null, reason: "未登记" }];
    if (!validNotificationPerson(people[actor])) return [{ role, actor, reason: "缺少有效的飞书身份映射" }];
    if (!validNotificationPerson(people[actor], options)) return [{ role, actor, reason: "飞书身份尚未验证" }];
    return [];
  });
  const mentions = [...new Set(actors.filter(actor => validNotificationPerson(people[actor], options)).map(actor => people[actor].feishu.id))];
  return { executor, manager, managerSubmission, observer, actors, mentions, missing, complete: missing.length === 0 };
}

export function notificationMentionWarning(recipients) {
  if (recipients.complete) return "";
  const safe = value => String(value || "").replace(/[\u0000-\u001f]/g, " ").replace(/[\\`*_~\[\]<>]/g, "\\$&");
  return `通知尚未完成：${recipients.missing.map(item => `${safe(item.role)}${item.actor ? `（${safe(item.actor)}）` : ""}${safe(item.reason)}`).join("；")}。请补齐已核验的飞书身份；姓名或工号文字不代表已@到本人。`;
}

export function responsibilityReminder({ executor, manager, observer, people = {}, mentions = [], hasFindings = true, closed = false }) {
  const escape = (value) => String(value || "责任人待登记").replace(/[\u0000-\u001f]/g, " ").replace(/[\\`*_~\[\]<>]/g, "\\$&");
  const used = new Set();
  const person = (actor) => {
    const p = people[actor], id = p?.feishu?.id;
    if (validNotificationPerson(p) && mentions.includes(id) && !used.has(id)) { used.add(id); return `<at id="${id}"></at>`; }
    return escape(p?.name || actor);
  };
  const same = executor && manager && (executor === manager || (!!people[executor]?.feishu?.id && people[executor].feishu.id === people[manager]?.feishu?.id));
  const lines = [closed ? "**请关注闭环结果**" : "**请关注并完成闭环**"];
  lines.push(`${person(executor)} ${closed ? "请查阅修复、回归和关闭记录，持续关注是否复发。" : hasFindings ? "请确认建议并修复，完成自动复扫及回归验证，反馈处理结果。" : "请核对检查和回归结果，完成报告中的剩余待办。"}`);
  if (!same) lines.push(`${person(manager)} 请履行技术经理职责，核对当前报告、修复证据与回归结果，按权限确认闭环。`);
  if (observer) lines.push(`${person(observer)} 请同步关注处理进展与回归结果。`);
  return lines.join("\n");
}
