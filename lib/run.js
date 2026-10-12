import path from "node:path";
import { loadConfig } from "./config.js";
import * as rawJsonAdapter from "./adapters/raw-json.js";
import * as cmdJsonAdapter from "./adapters/cmd-json.js";
import * as eslintAdapter from "./adapters/eslint.js";
import * as typecheckAdapter from "./adapters/typecheck.js";
import * as junitAdapter from "./adapters/junit.js";
import * as sarifAdapter from "./adapters/sarif.js";
import * as javaXmlAdapter from "./adapters/java-xml.js";
import { collect } from "./collect.js";
import { decide } from "./gate.js";
import { writeReports, writeAttestation } from "./report.js";
import { nowIso, newEventId, readJson, sha256 } from "./util.js";
import { fileURLToPath } from "node:url";
import { actualSha, snapshotSource, SHA_PATTERN, safePath } from "./source-state.js";
import { validateReportFile } from "./validate-report.js";
import { runCommand, quote } from "./exec.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { git } from "./source-state.js";
import { createReportProducers } from "./report-producers.js";

const ADAPTERS = {
  "raw-json": rawJsonAdapter,
  "cmd-json": cmdJsonAdapter,
  eslint: eslintAdapter,
  typecheck: typecheckAdapter,
  junit: junitAdapter,
  sarif: sarifAdapter,
  "java-xml": javaXmlAdapter,
};
const VERSION = readJson(fileURLToPath(new URL("../package.json", import.meta.url))).version;
const PROFILES = ["fast", "standard", "release"];

export function parseArgs(argv) {
  const o = {
    profile: "standard",
    root: null,
    out: null,
    scope: null,
    base: null,
    head: null,
    sha: null,
    env: null,
    policyFile: null,
    expectPolicyHash: null,
    expectRulesHash: null,
    expectBaselineHash: null,
    expectWaiversHash: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (argv[i + 1] === undefined) throw new Error(`参数 ${a} 缺少值`);
      i += 1;
      return argv[i];
    };
    if (a === "--profile") o.profile = need();
    else if (a === "--root") o.root = need();
    else if (a === "--out") o.out = need();
    else if (a === "--scope") o.scope = need();
    else if (a === "--base") o.base = need();
    else if (a === "--head") o.head = need();
    else if (a === "--sha") o.sha = need();
    else if (a === "--env") o.env = need();
    else if (a === "--policy") o.policyFile = need();
    else if (a === "--expect-policy-hash") o.expectPolicyHash = need();
    else if (a === "--expect-rules-hash") o.expectRulesHash = need();
    else if (a === "--expect-baseline-hash") o.expectBaselineHash = need();
    else if (a === "--expect-waivers-hash") o.expectWaiversHash = need();
    else throw new Error(`未知参数: ${a}`);
  }
  if (!["fast", "standard", "release"].includes(o.profile)) throw new Error(`profile 非法: ${o.profile}（合法值 ${PROFILES.join("/")}）`);
  if (o.scope !== null && o.scope !== "staged") throw new Error(`--scope 非法: ${o.scope}（当前仅支持 staged）`);
  if ((o.base === null) !== (o.head === null) || o.base === "" || o.head === "") throw new Error("--base/--head 必须成对提供非空值");
  if (o.scope && (o.base || o.profile === "release")) throw new Error("staged 不可与提交范围或 release 档混用");
  if (o.profile === "release" && (o.base || o.head)) throw new Error("release 必须全量检查，禁止 --base/--head 增量范围");
  if (o.env !== null && !["dev", "sit", "uat", "pre", "prd"].includes(o.env)) throw new Error(`--env 非法: ${o.env}`);
  return o;
}

function printConsole(summary, outDir) {
  const lines = [`[wl-skills-gate] ${summary.run.project} ${summary.run.profile} → ${summary.decision.status}`];
  for (const r of summary.decision.reasons) lines.push(`  - ${r}`);
  lines.push(
    `  new=${summary.counts.new} existing=${summary.counts.existing} waived=${summary.counts.waived} expired=${summary.counts.expired} blockingNew=${summary.counts.blockingNew}`
  );
  lines.push(`  报告: ${path.join(outDir, "quality-summary.json")}`);
  const out = summary.decision.status === "passed" ? console.log : console.error;
  out(lines.join("\n"));
}

function failFast(message, info = {}) {
  const root = info.root ? path.resolve(info.root) : process.cwd();
  const outDir = info.outDir ? path.resolve(info.outDir) : path.join(root, "quality-reports");
  const startedAt = info.startedAt || nowIso();
  const eventId = newEventId();
  const summary = {
    schemaVersion: 1,
    run: {
      eventId,
      project: info.project || "unknown",
      profile: PROFILES.includes(info.profile) ? info.profile : "standard",
      scope: null,
      base: null,
      head: null,
      commitSha: "unknown",
      targetEnv: null,
      startedAt,
      durationMs: Date.now() - (info.t0 || Date.now()),
      tool: `wl-skills-gate@${VERSION}`,
      outDir,
    },
    policy: { policyHash: null, ruleSetHash: null, enforceWarnings: false, checksDeclared: 0, checksSelected: 0, policyFile: null },
    checks: [],
    findings: [],
    counts: { new: 0, existing: 0, waived: 0, expired: 0, blockingNew: 0 },
    baseline: { declared: 0, resolvedPending: [] },
    waivers: { valid: 0, invalidRecords: [] },
    decision: { status: "invalid", reasons: [message] },
  };
  const { reportDigest } = writeReports(outDir, summary);
  writeAttestation(outDir, {
    schemaVersion: 1,
    kind: "unsigned-gate-result",
    project: summary.run.project,
    eventId,
    candidateSha: "unknown",
    profile: summary.run.profile,
    policyHash: null,
    ruleSetHash: null,
    pipelineId: process.env.CI_PIPELINE_ID || null,
    decision: "invalid",
    reportDigest,
    toolVersion: `wl-skills-gate@${VERSION}`,
    createdAt: nowIso(),
  });
  console.error(`[wl-skills-gate] invalid — ${message}`);
  console.error(`[wl-skills-gate] 报告已写入 ${outDir}`);
  return { exitCode: 2, summary };
}

export async function runGate(opts = {}) {
  const argv = opts.argv || [];
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    return failFast(e.message, { root: opts.root, outDir: mkdtempSync(path.join(tmpdir(), "wl-gate-invalid-args-")) });
  }
  const root = path.resolve(o.root || opts.root || process.cwd());
  const outDir = path.resolve(root, o.out || path.join("quality-reports"));
  const startedAt = nowIso();
  const t0 = Date.now();
  let tracked = [];
  try { tracked = git(["ls-files", "-z"], root).split("\0").filter(Boolean); } catch { /* 无 Git 的本地诊断仍允许 */ }
  const relativeOut = path.relative(root, outDir).split(path.sep).join("/");
  if (relativeOut && !relativeOut.startsWith("../") && relativeOut !== "..") {
    try { safePath(root, relativeOut); }
    catch (e) { return failFast(`报告目录失效: ${e.message}`, { root, outDir: mkdtempSync(path.join(tmpdir(), "wl-gate-invalid-output-")), profile: o.profile }); }
  }
  if (outDir === root || tracked.some((p) => p === relativeOut || p.startsWith(`${relativeOut}/`))) {
    return failFast("报告目录覆盖已跟踪源码或项目根，拒绝写入；改用独立未跟踪目录", {
      root, outDir: mkdtempSync(path.join(tmpdir(), "wl-gate-invalid-output-")), profile: o.profile });
  }

  if (o.base && /^0+$/.test(o.base)) {
    return failFast("--base 为全零 SHA（新分支事件占位），不能作为有效基线（正文 13.2）", {
      root,
      outDir,
      profile: o.profile,
      startedAt,
      t0,
    });
  }

  let config;
  try {
    config = loadConfig(root, { policyFile: o.policyFile ? path.resolve(root, o.policyFile) : null });
  } catch (e) {
    return failFast(e.message, { root, outDir, profile: o.profile, startedAt, t0 });
  }

  if (o.expectPolicyHash && o.expectPolicyHash !== config.policyHash) {
    return failFast(
      `policyHash 与受控期望不一致：期望 ${o.expectPolicyHash}，实际 ${config.policyHash}（版本锁校验，正文 12.6）`,
      { root, outDir, profile: o.profile, project: config.policy.project, startedAt, t0 }
    );
  }
  if (o.expectRulesHash) {
    if (!config.ruleSetHash) {
      return failFast("期望校验 rules.lock 摘要，但 quality/rules.lock.json 缺失", {
        root,
        outDir,
        profile: o.profile,
        project: config.policy.project,
        startedAt,
        t0,
      });
    }
    if (o.expectRulesHash !== config.ruleSetHash) {
      return failFast(
        `ruleSetHash 与受控期望不一致：期望 ${o.expectRulesHash}，实际 ${config.ruleSetHash}（版本锁校验，正文 12.6）`,
        { root, outDir, profile: o.profile, project: config.policy.project, startedAt, t0 }
      );
    }
  }

  const commitSha = actualSha(root);
  if ((o.sha || o.profile === "release") && ((config.baselineHash !== sha256("absent") && !o.expectBaselineHash) || (config.waiversHash !== sha256("absent") && !o.expectWaiversHash))) {
    return failFast("受控检查使用基线/豁免时必须传入批准的 baselineHash/waiversHash", { root, outDir, profile: o.profile });
  }
  if (config.ruleSet?.["wl-skills-gate"] && config.ruleSet["wl-skills-gate"] !== VERSION) return failFast("实际 gate 版本与 rules.lock 不一致", { root, outDir, profile: o.profile });
  if ((o.expectBaselineHash && o.expectBaselineHash !== config.baselineHash) || (o.expectWaiversHash && o.expectWaiversHash !== config.waiversHash)) {
    return failFast("baselineHash/waiversHash 与批准记录不一致", { root, outDir, profile: o.profile });
  }
  if (o.sha && (!SHA_PATTERN.test(o.sha) || o.sha !== commitSha)) {
    return failFast("--sha 必须等于当前 checkout 的真实 HEAD，拒绝给报告贴任意 SHA", { root, outDir, profile: o.profile });
  }
  if (o.head && o.head !== commitSha) return failFast("--head 与当前 checkout HEAD 不一致", { root, outDir, profile: o.profile });
  if (o.profile === "release" && (!o.env || !SHA_PATTERN.test(commitSha))) {
    return failFast("release 必须提供合法 --env 且位于有确定 HEAD 的 Git 仓库", { root, outDir, profile: o.profile });
  }
  let sourceBefore;
  try { sourceBefore = snapshotSource(root, { exclude: [path.relative(root, outDir)] }); }
  catch (e) { return failFast(`源码快照失效: ${e.message}`, { root, outDir, profile: o.profile }); }
  if ((o.sha || o.profile === "release") && sourceBefore.dirty) return failFast("受控检查的源码有未提交变化", { root, outDir, profile: o.profile });

  const selected = config.policy.checks.filter((c) => c.profiles.includes(o.profile));
  if (o.profile === "release" && !Array.isArray(config.policy.releaseRequires)) {
    return failFast("release 缺少最低检查集 releaseRequires", { root, outDir, profile: o.profile });
  }
  if (o.profile === "release" && Array.isArray(config.policy.releaseRequires)) {
    const selectedIds = new Set(selected.filter((c) => c.required !== false).map((c) => c.id));
    const missing = config.policy.releaseRequires.filter((id) => !selectedIds.has(id));
    if (missing.length) {
      return failFast(
        `release 档最低检查集缺失: ${missing.join(", ")}（policy.releaseRequires；确不适用须以 required:false + naReason 登记并从清单移除）`,
        { root, outDir, profile: o.profile, project: config.policy.project, startedAt, t0 }
      );
    }
  }
  if (!selected.length) {
    const declared = [...new Set(config.policy.checks.flatMap((c) => c.profiles))].join(",");
    return failFast(`profile=${o.profile} 未声明任何检查（policy 声明档位: ${declared}）`, {
      root,
      outDir,
      profile: o.profile,
      project: config.policy.project,
      startedAt,
      t0,
    });
  }

  const eventId = newEventId();
  const ctx = { root, project: config.policy.project, profile: o.profile, scope: o.scope, base: o.base, head: o.head,
    eventId, commitSha, startedAt, requireFresh: !!o.sha || o.profile === "release" };
  try { ctx.reportProducers = createReportProducers(selected, ctx); }
  catch (e) { return failFast(e.message, { root, outDir, profile: o.profile, project: config.policy.project, startedAt, t0 }); }
  const checkResults = [];
  const degradedFindings = [];
  for (const c of selected) {
    const ts = Date.now();
    let r;
    try {
      r = await ADAPTERS[c.tool].run(c, ctx);
    } catch (e) {
      r = { status: "invalid", reason: e.message };
    }
    r.checkId = c.id;
    r.tool = c.tool;
    const lockedVersion = config.ruleSet?.tools?.[c.id];
    const versionCommand = c.versionCommand || (c.tool === "eslint" ? `${quote(c.bin || path.join(root, "node_modules/.bin/eslint"))} --version` :
      c.tool === "typecheck" ? `${quote(c.bin || path.join(root, "node_modules/.bin/vue-tsc"))} --version` : null);
    if (r.status === "ok" && versionCommand && (c.versionCommand || lockedVersion || ctx.requireFresh)) {
      const version = await runCommand(versionCommand, { cwd: root, timeoutMs: 30000 });
      if (version.code !== 0 || version.timedOut || !version.stdout.trim()) r = { ...r, status: "invalid", reason: "工具版本查询失败" };
      else { r.toolVersion = version.stdout.trim(); r.toolVersionVerified = true; }
    }
    if (r.status === "ok" && lockedVersion && r.toolVersion !== lockedVersion) r = { ...r, status: "invalid", reason: `实际工具版本 ${r.toolVersion} 与锁定 ${lockedVersion} 不一致` };
    if (ctx.requireFresh && c.required !== false && r.status === "ok" && (!lockedVersion || !r.toolVersionVerified)) {
      const reason = `受控检查缺少 ${c.id} 的版本锁或实际版本查询`;
      r = { ...r, status: "invalid", reason: r.reason ? `${r.reason}；${reason}` : reason };
    }
    r.required = c.required !== false;
    r.durationMs = Date.now() - ts;
    if (r.status === "invalid" && c.required === false) {
      r.status = "degraded";
      degradedFindings.push({
        ruleId: "GATE/CHECK-DEGRADED",
        severity: "warning",
        file: "quality/policy.yml",
        line: null,
        message: `检查 ${c.id} 失效（required=false${c.naReason ? `，不适用原因：${c.naReason}` : ""}${
          c.alternative ? `，替代验证：${c.alternative}` : ""
        }）: ${r.reason}`,
        dimension: "门禁监督",
        autoFixable: false,
        fixCommand: null,
      });
    }
    checkResults.push(r);
  }

  const okFindings = checkResults
    .filter((r) => r.status === "ok")
    .flatMap((r) => (r.findings || []).map((f) => ({ ...f, checkId: r.checkId,
      baselineAllowed: selected.find((c) => c.id === r.checkId)?.baselineAllowed !== false && f.baselineAllowed !== false })));
  let sourceAfter;
  try { sourceAfter = snapshotSource(root, { exclude: [path.relative(root, outDir)] }); }
  catch (e) { return failFast(`检查后源码快照失效: ${e.message}`, { root, outDir, profile: o.profile }); }
  if (sourceAfter.digest !== sourceBefore.digest || sourceAfter.sha !== commitSha) {
    checkResults.push({ checkId: "GATE/SOURCE-DRIFT", tool: "gate", required: true, status: "invalid", reason: "检查期间源码发生变化" });
  }
  const collected = collect({
    project: config.policy.project,
    findings: [...okFindings, ...degradedFindings],
    waivers: config.waivers,
    baselineItems: config.baselineItems,
    enforceWarnings: !!config.policy.enforceWarnings,
    fullScan: !o.scope && !o.base && checkResults.every((c) => c.status === "ok"),
  });
  const decision = decide({ checkResults, counts: collected.counts });

  const summary = {
    schemaVersion: 1,
    run: {
      eventId,
      project: config.policy.project,
      root,
      profile: o.profile,
      scope: o.scope || null,
      base: o.base || null,
      head: o.head || null,
      commitSha,
      sourceBound: ctx.requireFresh && !sourceBefore.dirty && sourceBefore.digest === sourceAfter.digest && commitSha === sourceAfter.sha,
      sourceDigest: sourceAfter.digest,
      targetEnv: o.env || null,
      startedAt,
      durationMs: Date.now() - t0,
      tool: `wl-skills-gate@${VERSION}`,
      outDir,
    },
    policy: {
      policyHash: config.policyHash,
      ruleSetHash: config.ruleSetHash,
      baselineHash: config.baselineHash,
      waiversHash: config.waiversHash,
      enforceWarnings: !!config.policy.enforceWarnings,
      blockerWaivers: config.policy.blockerWaivers || "reject",
      checksDeclared: config.policy.checks.length,
      checksSelected: selected.length,
      requiredCheckIds: selected.filter((c) => c.required !== false).map((c) => c.id),
      lockedToolVersions: config.ruleSet?.tools || {},
      policyFile: path.relative(root, config.policyFile),
    },
    checks: checkResults.map((r) => ({
      checkId: r.checkId,
      tool: r.tool,
      required: r.required,
      status: r.status,
      reason: r.reason || null,
      note: r.note || null,
      toolVersion: r.toolVersion || null,
      toolVersionVerified: r.toolVersionVerified === true,
      parserMetadata: r.parserMetadata || null,
      findingsCount: r.status === "ok" ? (r.findings || []).length : null,
      coverage: r.coverage || null,
      durationMs: r.durationMs,
      production: r.production || null,
    })),
    findings: collected.findings,
    productions: [...ctx.reportProducers].map(([producer, group]) => ({ producer,
      checkIds: group.checks.map((c) => c.id), reportCount: group.checks.length,
      ...(group.record || { commandRuns: 0, status: "not-executed", durationMs: null }) })),
    counts: collected.counts,
    baseline: { declared: config.baselineItems.length, resolvedPending: collected.baselineResolvedPending, ...config.baselineMeta },
    waivers: { valid: config.waivers.length, invalidRecords: config.invalidWaivers },
    decision,
  };

  const { reportDigest } = writeReports(outDir, summary);
  const validation = validateReportFile(path.join(outDir, "quality-summary.json"));
  if (!validation.ok) return failFast(`生成报告未满足 schema: ${validation.errors.join("; ")}`, { root, outDir, profile: o.profile });
  writeAttestation(outDir, {
    project: summary.run.project,
    schemaVersion: 1,
    kind: "unsigned-gate-result",
    eventId: summary.run.eventId,
    candidateSha: summary.run.commitSha,
    compareBaseSha: o.base || null,
    compareHeadSha: o.head || null,
    profile: o.profile,
    policyHash: config.policyHash,
    policyHashExpected: o.expectPolicyHash || null,
    policyHashMatch: o.expectPolicyHash ? o.expectPolicyHash === config.policyHash : null,
    ruleSetHash: config.ruleSetHash,
    rulesHashExpected: o.expectRulesHash || null,
    rulesHashMatch: o.expectRulesHash ? config.ruleSetHash === o.expectRulesHash : null,
    pipelineId: process.env.CI_PIPELINE_ID || null,
    decision: decision.status,
    reportDigest,
    toolVersion: `wl-skills-gate@${VERSION}`,
    createdAt: nowIso(),
  });
  printConsole(summary, outDir);
  const exitCode = decision.status === "passed" ? 0 : decision.status === "blocked" ? 1 : 2;
  return { exitCode, summary };
}
