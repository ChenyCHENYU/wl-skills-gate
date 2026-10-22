// Notification recipients only. Being mentioned never grants Review authority.
export function notificationActors(executor, project, people = {}) {
  const manager = project.technicalManager;
  const executorId = people[executor]?.feishu?.id, managerId = people[manager]?.feishu?.id;
  const managerSubmission = !!executor && !!manager && (executor === manager || (!!executorId && executorId === managerId));
  const observer = managerSubmission ? project.managerSubmissionNotify : undefined;
  if (observer && (observer === manager || (people[observer]?.feishu?.id && people[observer].feishu.id === managerId))) throw new Error("同步人不能与技术经理为同一飞书人员");
  return { managerSubmission, observer, actors: [...new Set([executor, manager, observer].filter(Boolean))] };
}

export function responsibilityReminder({ executor, manager, observer, people = {}, mentions = [], hasFindings = true, closed = false }) {
  const escape = (value) => String(value || "责任人待登记").replace(/[\u0000-\u001f]/g, " ").replace(/[\\`*_~\[\]<>]/g, "\\$&");
  const used = new Set();
  const person = (actor) => {
    const p = people[actor], id = p?.feishu?.id;
    if (id && mentions.includes(id) && !used.has(id)) { used.add(id); return `<at id="${id}"></at>`; }
    return escape(p?.name || actor);
  };
  const same = executor && manager && (executor === manager || (!!people[executor]?.feishu?.id && people[executor].feishu.id === people[manager]?.feishu?.id));
  const lines = [closed ? "**请关注闭环结果**" : "**请关注并完成闭环**"];
  lines.push(`${person(executor)} ${closed ? "请查阅修复、回归和关闭记录，持续关注是否复发。" : hasFindings ? "请确认建议并修复，完成自动复扫及回归验证，反馈处理结果。" : "请核对检查和回归结果，完成报告中的剩余待办。"}`);
  if (!same && manager) lines.push(`${person(manager)} 请跟进处理，核对修复前后报告与回归结果，按权限确认闭环。`);
  if (observer) lines.push(`${person(observer)} 请同步关注处理进展与回归结果。`);
  return lines.join("\n");
}
