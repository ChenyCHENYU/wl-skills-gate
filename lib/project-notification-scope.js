export const QUALITY_TARGET_BRANCHES = Object.freeze(["dev", "sit", "uat", "pre", "prd", "main"]);

// Presentation/routing only. A production caller must obtain this context from
// verified GitLab facts; this function does not authenticate a webhook or approve a merge.
export function projectNotificationScope(event) {
  if (event?.kind === "merge-request" && QUALITY_TARGET_BRANCHES.includes(event.targetBranch)) {
    if (["open", "update", "reopen"].includes(event.action) && ["opened", "reopened"].includes(event.state)) {
      return { notify: true, phase: "before-merge", targetBranch: event.targetBranch, label: "合并目标", eventLabel: "合并请求检查" };
    }
    if (event.action === "merge" && event.state === "merged") {
      return { notify: true, phase: "after-merge", targetBranch: event.targetBranch, label: "已合并到", eventLabel: "合并后复查" };
    }
  }
  if (event?.kind === "target-update" && QUALITY_TARGET_BRANCHES.includes(event.ref)) {
    return { notify: true, phase: "after-update", targetBranch: event.ref, label: "更新分支", eventLabel: "目标分支更新检查" };
  }
  return { notify: false, reason: "个人分支提交/推送只做本地反馈；群通知须有指向六个批准目标分支的真实事件上下文" };
}
