import { git } from "./source-state.js";
import { redactLog } from "./exec.js";

export function runTrace(root, { base, head, env = process.env } = {}) {
  try {
    base =
      base ||
      [env.CI_MERGE_REQUEST_DIFF_BASE_SHA, env.CI_COMMIT_BEFORE_SHA].find(
        (value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "") && !/^0+$/.test(value)
      );
    const branch = git(["branch", "--show-current"], root) || "detached";
    const fields = ["%H", "%aI", "%an", "%ae", "%cI", "%cn", "%ce", "%s", "%B"];
    const raw = git(
      [
        "log",
        "-z",
        `--format=${fields.join("%x00")}`,
        "--max-count=1001",
        ...(base ? [`${base}..${head || "HEAD"}`] : ["-1", "HEAD"]),
      ],
      root
    ).split("\0");
    if (raw.at(-1) === "") raw.pop();
    if (raw.length % fields.length) throw new Error("Git提交字段未完整返回");
    const commits = [];
    for (let i = 0; i < raw.length; i += fields.length)
      commits.push({
        sha: raw[i],
        authoredAt: raw[i + 1],
        author: { name: redactLog(raw[i + 2]), email: redactLog(raw[i + 3]) },
        committedAt: raw[i + 4],
        committer: { name: redactLog(raw[i + 5]), email: redactLog(raw[i + 6]) },
        subject: redactLog(raw[i + 7]),
        message: redactLog(raw[i + 8]),
      });
    const truncated = commits.length > 1000;
    return {
      status: truncated ? "incomplete" : "available",
      branch,
      sourceBranch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || branch,
      targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.CI_COMMIT_BRANCH || branch,
      mergeRequest: env.CI_MERGE_REQUEST_IID || null,
      baseSha: base || null,
      commits: commits.slice(0, 1000),
      truncated,
      source: "local-git-and-ci-environment",
      identityVerified: false,
      note: "Git作者/提交者不等于认证执行人或合并人；中央采集另从GitLab/Jenkins核验。未提供base时只列HEAD，不冒充完整MR变更列表。",
    };
  } catch (error) {
    return { status: "unavailable", commits: [], identityVerified: false, reason: error.message };
  }
}
