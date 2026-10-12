import path from "node:path";
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { nowIso, newEventId, readJson, sha256, stableStringify } from "./util.js";
import { git } from "./source-state.js";
import { runCommand, redactLog } from "./exec.js";
import { runGate } from "./run.js";
import { verifyProof, verifyReview } from "./evidence.js";

const ORDER = ["dev", "sit", "uat", "pre", "prd", "main"];

function validateFlow(source, target, root) {
  git(["check-ref-format", "--branch", source], root);
  const i = ORDER.indexOf(target);
  if (i < 0 || !((target === "dev" && /^dev-/.test(source)) || (i > 0 && source === ORDER[i - 1]))) throw new Error(`非法流向 ${source} → ${target}，仅允许个人分支→dev 或相邻阶段晋级`);
}

export async function promote({ root, source, target, remote = "origin", profile = "standard", push = false,
  allowAny = false, expectPolicyHash, expectRulesHash, expectBaselineHash, expectWaiversHash, prepareCommand }) {
  if (push || allowAny) throw new Error("promote 只生成并检查候选；--push/--allow-any 已禁用，请由隔离的 promote-apply 核验证据后更新");
  if (!source || !target || profile !== "standard") throw new Error("候选晋级必须提供 source/target 并使用 standard 档");
  if (!/^[A-Za-z][\w.-]*$/.test(remote)) throw new Error("remote 必须为配置中的名称");
  if (!expectPolicyHash || !expectRulesHash) throw new Error("候选检查必须传平台批准的 policy/rules 摘要");
  root = path.resolve(root);
  validateFlow(source, target, root);
  git(["fetch", remote, source, target], root);
  const sourceSha = git(["rev-parse", `${remote}/${source}`], root);
  const beforeSha = git(["rev-parse", `${remote}/${target}`], root);
  const id = newEventId();
  const outDir = path.join(root, "quality-reports", `promotion-${id}`);
  mkdirSync(outDir, { recursive: true });
  const worktree = mkdtempSync(path.join(tmpdir(), "wl-gate-candidate-"));
  const candidateRef = `refs/wl-gate-candidates/${id}`;
  const record = { schemaVersion: 1, createdAt: nowIso(), source, target, sourceSha, targetBeforeSha: beforeSha,
    candidateSha: null, candidateRef, profile, decision: "invalid", bundleFile: path.join(outDir, "candidate.bundle") };
  let result;
  try {
    git(["worktree", "add", "--detach", worktree, beforeSha], root);
    git(["merge", "--no-ff", "--no-edit", "-m", `ci(工程化): 分支晋级-${source} 到 ${target}`, sourceSha], worktree);
    record.candidateSha = git(["rev-parse", "HEAD"], worktree);
    if (record.candidateSha === beforeSha) throw new Error("源分支已包含在目标中，没有新的候选合并");
    if (prepareCommand) {
      const startedAt = nowIso(), t0 = Date.now();
      const p = await runCommand(prepareCommand, { cwd: worktree });
      const logFile = path.join(outDir, "dependency-prepare.json");
      writeFileSync(logFile, JSON.stringify({ startedAt, durationMs: Date.now() - t0,
        command: redactLog(prepareCommand), exitCode: p.code, timedOut: p.timedOut, truncated: p.truncated || false,
        stdout: redactLog(p.stdout), stderr: redactLog(p.stderr), spawnError: redactLog(p.spawnError) || null }, null, 2));
      record.preparation = { exitCode: p.code, timedOut: p.timedOut, logFile };
      if (p.code !== 0 || p.timedOut || p.truncated) throw new Error(`候选依赖准备失败（exit=${p.code}），脱敏日志: dependency-prepare.json`);
    }
    const gate = await runGate({ argv: ["--root", worktree, "--profile", profile,
      "--base", beforeSha, "--head", record.candidateSha, "--sha", record.candidateSha,
      "--expect-policy-hash", expectPolicyHash, "--expect-rules-hash", expectRulesHash,
      ...(expectBaselineHash ? ["--expect-baseline-hash", expectBaselineHash] : []),
      ...(expectWaiversHash ? ["--expect-waivers-hash", expectWaiversHash] : [])] });
    record.project = gate.summary.run.project;
    record.decision = gate.exitCode === 0 ? "candidate-passed" : gate.summary.decision.status;
    if (gate.exitCode === 0) {
      git(["update-ref", candidateRef, record.candidateSha], root);
      git(["bundle", "create", record.bundleFile, candidateRef], root);
    }
    result = { exitCode: gate.exitCode, status: record.decision, candidateSha: record.candidateSha, reasons: gate.summary.decision.reasons };
  } catch (e) {
    record.decision = "invalid";
    result = { exitCode: 2, status: "invalid", candidateSha: record.candidateSha, reasons: [e.message] };
  } finally {
    try { cpSync(path.join(worktree, "quality-reports"), outDir, { recursive: true }); } catch (e) {
      if (record.candidateSha && result?.exitCode === 0) result = { ...result, exitCode: 2, status: "invalid", reasons: [`候选证据归档失败: ${e.message}`] };
    }
    record.decision = result.status;
    record.reasons = result.reasons;
    record.completedAt = nowIso();
    try {
      writeFileSync(path.join(outDir, "promotion-record.json"), JSON.stringify(record, null, 2));
    } catch (e) {
      result = { ...result, exitCode: 2, status: "invalid", reasons: [...result.reasons, `候选记录归档失败: ${e.message}`] };
    } finally {
      try { git(["update-ref", "-d", candidateRef], root); } catch {}
      try { git(["worktree", "remove", "--force", worktree], root); } catch { rmSync(worktree, { recursive: true, force: true }); }
    }
  }
  return { ...result, recordFile: path.join(outDir, "promotion-record.json"), outDir };
}

export function applyPromotion(options = {}) {
  const audit = { createdAt: nowIso(), decision: "invalid", reasons: [] };
  const controller = mkdtempSync(path.join(tmpdir(), "wl-gate-controller-"));
  let result;
  let auditFile;
  try {
    const auditDir = path.resolve(options.outDir || path.join(options.recordFile ? path.dirname(options.recordFile) : path.join(process.cwd(), "quality-reports"), "controller-audit"));
    // 审计目录不可写时先拒绝，避免分支已经更新却没有任何控制器记录。
    mkdirSync(auditDir, { recursive: true });
    auditFile = path.join(auditDir, `promotion-apply-${newEventId()}.json`);
    writeFileSync(auditFile, JSON.stringify(audit, null, 2));
    if (!options.recordFile) throw new Error("必须提供候选 record 文件");
    if (!options.remoteUrl || options.remoteUrl.startsWith("-")) throw new Error("必须提供平台固定的 remote-url");
    const record = readJson(options.recordFile);
    if (record.schemaVersion !== 1 || record.decision !== "candidate-passed" || !/^refs\/wl-gate-candidates\/[a-f0-9-]+$/.test(record.candidateRef || "")) throw new Error("候选记录未通过或格式不合法");
    const verified = verifyProof({ ...options, sha: record.candidateSha, profile: "standard" });
    if (!verified.ok) throw new Error(verified.errors.join("; "));
    if (verified.proof.promotionRecordDigest !== sha256(stableStringify(record))) throw new Error("晋级记录未被受控证明绑定");
    const review = verifyReview({ recordFile: options.reviewFile, publicKeyFile: options.reviewPublicKeyFile,
      project: options.project, sha: record.candidateSha });
    for (const key of ["source", "target", "sourceSha", "targetBeforeSha"]) if (review[key] !== record[key]) throw new Error(`Review 的 ${key} 与候选不一致`);
    // 有权限阶段仅在新建 bare 仓库中操作 Git，不运行候选代码、项目 Hook 或项目 Git 配置。
    git(["init", "--bare", "-q"], controller);
    validateFlow(record.source, record.target, controller);
    git(["-c", "protocol.ext.allow=never", "fetch", options.remoteUrl,
      `refs/heads/${record.target}:refs/heads/target`, `refs/heads/${record.source}:refs/heads/source`], controller);
    const currentTarget = git(["rev-parse", "target"], controller);
    const currentSource = git(["rev-parse", "source"], controller);
    if (currentTarget !== record.targetBeforeSha || currentSource !== record.sourceSha) throw new Error("远端源/目标 HEAD 已变化，必须重新生成候选和 Review");
    const bundle = path.resolve(options.bundleFile || record.bundleFile);
    git(["bundle", "verify", bundle], controller);
    git(["fetch", bundle, `${record.candidateRef}:refs/heads/candidate`], controller);
    if (git(["rev-parse", "candidate"], controller) !== record.candidateSha) throw new Error("bundle 中候选 SHA 不一致");
    const parents = git(["rev-list", "--parents", "-n", "1", "candidate"], controller).split(" ").slice(1);
    if (parents.length !== 2 || parents[0] !== record.targetBeforeSha || parents[1] !== record.sourceSha) throw new Error("候选不是批准的源/目标合并结果");
    const remoteHead = git(["ls-remote", options.remoteUrl, `refs/heads/${record.target}`], controller).split(/\s/)[0];
    if (remoteHead !== record.targetBeforeSha) throw new Error("更新前目标分支发生并发变化");
    Object.assign(audit, { decision: "pending-update", project: options.project, candidateSha: record.candidateSha,
      source: record.source, target: record.target, targetBeforeSha: record.targetBeforeSha,
      proofDigest: sha256(stableStringify(verified.proof)), reviewDigest: sha256(stableStringify(review)) });
    writeFileSync(auditFile, JSON.stringify(audit, null, 2));
    // The verified merge has targetBeforeSha as its first parent, so this can only
    // fast-forward the exact approved old HEAD. An explicit lease closes the race
    // between ls-remote and push, including a concurrent ancestor advancement.
    git(["-c", "protocol.ext.allow=never", "push", `--force-with-lease=refs/heads/${record.target}:${record.targetBeforeSha}`,
      options.remoteUrl, `refs/heads/candidate:refs/heads/${record.target}`], controller);
    audit.decision = "promoted";
    result = { exitCode: 0, status: "promoted", candidateSha: record.candidateSha, reasons: [] };
  } catch (e) { audit.decision = "invalid"; audit.reasons.push(e.message); result = { exitCode: 2, status: "invalid", reasons: audit.reasons }; }
  finally {
    audit.completedAt = nowIso();
    try {
      if (!auditFile) throw new Error("审计文件未能创建");
      writeFileSync(auditFile, JSON.stringify(audit, null, 2));
      result.auditFile = auditFile;
    } catch (e) {
      result = { ...result, exitCode: 2, status: result?.status === "promoted" ? "promoted-audit-failed" : "invalid",
        reasons: [...(result?.reasons || []), `控制器审计归档失败: ${e.message}`] };
    } finally { rmSync(controller, { recursive: true, force: true }); }
  }
  return result;
}
