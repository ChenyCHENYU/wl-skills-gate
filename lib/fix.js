import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, chmodSync, lstatSync } from "node:fs";
import { sha256, stableStringify, newEventId, nowIso, readJson } from "./util.js";
import { runCommand, quote } from "./exec.js";
import { runGate } from "./run.js";
import { loadConfig } from "./config.js";
import { safePath, snapshotSource, fileHash } from "./source-state.js";
import { immutableFailure } from "./risk.js";
import { validateReportFile } from "./validate-report.js";

function planDigest(plan) {
  const { planHash: ignored, ...payload } = plan;
  return sha256(stableStringify(payload));
}

function repairItem(f, config, root) {
  const base = { fingerprint: f.fingerprint, ruleId: f.ruleId, severity: f.severity, file: f.file,
    message: f.message, line: f.line ?? null, action: "manual", command: null, allowedFiles: [] };
  if (!f.autoFixable || immutableFailure(f)) return base;
  const check = config.policy.checks.find((c) => c.id === f.checkId);
  if (check?.tool === "eslint" && f.ruleId.startsWith("ESLINT/")) {
    safePath(root, f.file);
    return { ...base, action: "command", fixerId: "builtin:eslint", allowedFiles: [f.file],
      command: `${quote(check.bin || path.join(root, "node_modules", ".bin", "eslint"))}${check.args ? ` ${check.args}` : ""} --fix ${quote(f.file)}` };
  }
  const fixer = (config.policy.fixers || []).find((it) => it.id === f.fixerId && it.ruleIds.includes(f.ruleId));
  if (!fixer || !fixer.files.includes(f.file)) return base;
  fixer.files.forEach((p) => safePath(root, p));
  return { ...base, action: "command", fixerId: fixer.id, command: fixer.command, allowedFiles: fixer.files };
}

export function buildFixPlan(summaryFile, options = {}) {
  const validation = validateReportFile(summaryFile);
  if (!validation.ok) throw new Error(`修复输入报告失效: ${validation.errors.join("; ")}`);
  const summary = readJson(summaryFile);
  const root = path.resolve(options.root || summary.run.root || path.dirname(path.resolve(summaryFile)), summary.run.root || options.root ? "." : "..");
  const config = loadConfig(root);
  if (summary.run.profile !== "standard" || summary.run.scope || summary.run.base) throw new Error("机械修复请先生成 standard 全量报告，增量/发布报告不能代替完整复扫");
  if (!["passed", "blocked"].includes(summary.decision.status) || !summary.checks.length || summary.checks.some((c) => c.status !== "ok")) throw new Error("修复需要完整有效的检查结果，请先解决失效检查并重新扫描");
  if (summary.policy.policyHash !== config.policyHash || summary.policy.ruleSetHash !== config.ruleSetHash ||
      summary.policy.baselineHash !== config.baselineHash || summary.policy.waiversHash !== config.waiversHash) throw new Error("报告策略/规则/基线/例外已变化，请重新扫描");
  const exclude = [path.relative(root, path.dirname(path.resolve(summaryFile)))];
  const scannedSource = snapshotSource(root, { exclude });
  if (scannedSource.sha !== summary.run.commitSha || scannedSource.digest !== summary.run.sourceDigest) throw new Error("报告不是当前源码/HEAD 的检查结果，请重新扫描后预览");
  const outDir = path.join(path.dirname(path.resolve(summaryFile)), "repair");
  const planId = `FP-${newEventId()}`;
  const snapshotDir = path.join(outDir, "snapshots", planId);
  const snapshot = snapshotSource(root, { allFiles: true, exclude });
  if (Object.values(snapshot.entries).some((e) => e.link)) throw new Error("源码含符号链接，需人工修复以避免越界");
  const snapshotFiles = [];
  for (const [rel, entry] of Object.entries(snapshot.entries)) {
    if (entry.missing) continue;
    const backup = path.join(snapshotDir, rel);
    mkdirSync(path.dirname(backup), { recursive: true });
    copyFileSync(safePath(root, rel), backup);
    snapshotFiles.push({ path: rel, hash: entry.hash, mode: entry.mode, backup });
  }
  const plan = { schemaVersion: 2, planId, createdAt: nowIso(), root,
    inputSummaryPath: path.resolve(summaryFile), inputSummaryDigest: sha256(stableStringify(summary)),
    project: summary.run.project, inputSha: snapshot.sha, inputSourceDigest: snapshot.digest,
    policyHash: config.policyHash, rulesHash: config.ruleSetHash, profile: "standard", snapshotFiles,
    items: summary.findings.filter((f) => ["new", "expired"].includes(f.status)).map((f) => repairItem(f, config, root)) };
  plan.planHash = planDigest(plan);
  mkdirSync(outDir, { recursive: true });
  const planFile = path.join(outDir, "fix-plan.json");
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  return { planFile, plan };
}

function changedPaths(before, after) {
  return [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])]
    .filter((p) => stableStringify(before.entries[p]) !== stableStringify(after.entries[p]));
}

function rollback(root, plan, after) {
  const leaf = (relative) => {
    // Validate ancestors without following a link that replaced the leaf itself.
    safePath(root, path.join(path.dirname(relative), ".wl-rollback-path-check"));
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("回滚路径越界");
    return file;
  };
  const known = new Set(plan.snapshotFiles.map((f) => f.path));
  for (const p of Object.keys(after.entries)) if (!known.has(p)) rmSync(leaf(p), { force: true });
  for (const f of plan.snapshotFiles) {
    const file = leaf(f.path);
    mkdirSync(path.dirname(file), { recursive: true });
    let info;
    try { info = lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (info?.isSymbolicLink()) rmSync(file);
    copyFileSync(f.backup, file);
    chmodSync(file, f.mode);
  }
}

export async function applyFixPlan(planFile, { root, profile, confirm = false } = {}) {
  if (!confirm) throw new Error("应用修复必须显式 --confirm");
  const plan = readJson(planFile);
  if (plan.schemaVersion !== 2 || planDigest(plan) !== plan.planHash) throw new Error("planHash 不匹配或为旧版计划，请重新预览");
  root = path.resolve(root || plan.root);
  if (root !== plan.root || (profile && profile !== plan.profile)) throw new Error("修复 root/profile 与预览不一致");
  const exclude = [path.relative(root, path.dirname(plan.inputSummaryPath))];
  const before = snapshotSource(root, { allFiles: true, exclude });
  if (before.digest !== plan.inputSourceDigest || before.sha !== plan.inputSha) throw new Error("代码/HEAD 在预览后发生变化，零写入，请重新生成计划");
  const summary = readJson(plan.inputSummaryPath);
  if (sha256(stableStringify(summary)) !== plan.inputSummaryDigest) throw new Error("输入报告在预览后变化");
  const config = loadConfig(root);
  if (config.policyHash !== plan.policyHash || config.ruleSetHash !== plan.rulesHash) throw new Error("规则/策略在预览后变化");
  const expectedItems = summary.findings.filter((f) => ["new", "expired"].includes(f.status)).map((f) => repairItem(f, config, root));
  if (stableStringify(expectedItems) !== stableStringify(plan.items)) throw new Error("计划动作不属于当前修复白名单");
  const expectedSnapshotDir = path.join(path.dirname(path.resolve(planFile)), "snapshots", plan.planId);
  if (!/^FP-[a-f0-9-]+$/.test(plan.planId) || plan.snapshotFiles.length !== Object.keys(before.entries).length || new Set(plan.snapshotFiles.map((f) => f.path)).size !== plan.snapshotFiles.length) throw new Error("修复快照清单不完整");
  for (const f of plan.snapshotFiles) {
    if (f.backup !== safePath(expectedSnapshotDir, f.path) || before.entries[f.path]?.hash !== f.hash || before.entries[f.path]?.mode !== f.mode || fileHash(f.backup) !== f.hash) throw new Error("修复快照损坏或清单被篡改，拒绝应用");
  }
  const beforeArchive = path.join(path.dirname(planFile), `summary-before-${plan.planId}.json`);
  copyFileSync(plan.inputSummaryPath, beforeArchive);
  const applied = [];
  for (const item of plan.items.filter((i) => i.action === "command")) {
    const r = await runCommand(item.command, { cwd: root });
    applied.push({ fingerprint: item.fingerprint, command: item.command, exitCode: r.code, timedOut: r.timedOut });
    if (r.code !== 0 || r.timedOut) break;
  }
  let afterSource, finalSource, rescan;
  const executionErrors = [];
  try {
    afterSource = snapshotSource(root, { allFiles: true, exclude });
    rescan = await runGate({ argv: ["--root", root, "--profile", plan.profile] });
    finalSource = snapshotSource(root, { allFiles: true, exclude });
  } catch (e) {
    executionErrors.push(e.message);
    rescan = { exitCode: 2, summary: { findings: [], decision: { status: "invalid" } } };
    finalSource = afterSource || before;
  }
  const allowed = new Set(plan.items.filter((i) => i.action === "command").flatMap((i) => i.allowedFiles));
  const failedCommands = applied.filter((r) => r.exitCode !== 0 || r.timedOut);
  const changed = changedPaths(before, finalSource);
  const unauthorizedFiles = changed.filter((p) => !allowed.has(p));
  const rescanChangedFiles = afterSource ? changedPaths(afterSource, finalSource) : [];
  const unsafePaths = Object.entries(finalSource.entries).filter(([, e]) => e.link).map(([p]) => p);
  const old = new Set(summary.findings.map((f) => f.fingerprint));
  const current = new Set(rescan.summary.findings.map((f) => f.fingerprint));
  let fixed = [...old].filter((fp) => !current.has(fp));
  let remaining = [...old].filter((fp) => current.has(fp));
  const regressions = rescan.summary.findings.filter((f) => !old.has(f.fingerprint) && ["new", "expired"].includes(f.status));
  const headChanged = finalSource.sha !== before.sha;
  const mustRollback = executionErrors.length > 0 || unsafePaths.length > 0 || failedCommands.length > 0 || unauthorizedFiles.length > 0 || rescanChangedFiles.length > 0 || regressions.length > 0 || rescan.exitCode === 2 || headChanged;
  let rolledBack = false, rollbackVerification = null, rollbackError = null;
  if (mustRollback) {
    // A changed HEAD can be another actor's commit. Never reset Git or claim it
    // was restored by copying files; stop and retain evidence for manual recovery.
    if (headChanged || executionErrors.length) rollbackError = headChanged ? "HEAD 已变化，未自动重置或覆盖；需人工恢复" : "源码快照异常，无法证明完整恢复；需人工恢复";
    else try {
      rollback(root, plan, finalSource);
      const checked = await runGate({ argv: ["--root", root, "--profile", plan.profile] });
      const restored = snapshotSource(root, { allFiles: true, exclude });
      rolledBack = restored.digest === before.digest && restored.sha === before.sha;
      rollbackVerification = { decision: checked.summary.decision.status, exitCode: checked.exitCode,
        findingsCount: checked.summary.findings.length, sourceRestored: rolledBack };
      if (!rolledBack) rollbackError = "回滚后源码仍与快照不同，需人工恢复";
    } catch (e) { rollbackError = e.message; }
    fixed = []; remaining = [...old];
  }
  const scanResolved = !mustRollback && applied.length > 0 && fixed.length > 0 && !remaining.length && rescan.exitCode === 0;
  const fixReport = { createdAt: nowIso(), planFile, applied, failedCommands, unauthorizedFiles, rescanChangedFiles, unsafePaths, executionErrors,
    skipped: plan.items.filter((i) => i.action === "manual"), changedFiles: changed, beforeArchive,
    before: { decision: summary.decision.status, findings: old.size },
    after: mustRollback ? { decision: rollbackVerification?.decision || "invalid", findings: rollbackVerification?.findingsCount ?? null } :
      { decision: rescan.summary.decision.status, findings: current.size },
    attemptedRescan: { decision: rescan.summary.decision.status, findings: current.size },
    fixed, remaining, regressions: regressions.map((f) => f.fingerprint), rescanExitCode: rescan.exitCode,
    rolledBack, rollbackVerification, rollbackError, manualRecoveryRequired: mustRollback && !rolledBack,
    scanResolved, closed: false, nextState: scanResolved ? "pending-verification" : "open" };
  const reportFile = path.join(path.dirname(planFile), "fix-report.json");
  writeFileSync(reportFile, JSON.stringify(fixReport, null, 2));
  return { fixReport, reportFile, exitCode: mustRollback ? 2 : rescan.exitCode };
}
