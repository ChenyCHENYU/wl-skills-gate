import path from "node:path";
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { safePath, snapshotSource, SHA_PATTERN } from "./source-state.js";
import { controlledPath } from "./control-store.js";
import { validateReportFile } from "./validate-report.js";
import { validateCommitMessage } from "./commit-message.js";
import { parseXml } from "./xml.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (value, message) => { if (!value) throw new Error(message); };
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024, MAX_DIFF = 4 * 1024 * 1024;
const MATERIAL = {
  "ui-verification": { file: "ui.json", dimensions: ["ui"] },
  "impact-review": { file: "impact-review.json", dimensions: ["review"] },
  "test-verification": { file: "tests.json", dimensions: ["tests"] },
  "pipeline-verification": { file: "cicd.json", dimensions: ["cicd"] },
  "ownership-verification": { file: "governance.json", dimensions: ["governance"] },
};
function ordinary(root, relative) {
  assert(typeof relative === "string" && relative && !relative.includes("\\") && !path.isAbsolute(relative) && relative.split("/").every((part) => part && part !== "." && part !== "..") && relative.split("/")[0] !== ".git", "Review事实原件必须是项目内明确相对路径");
  const file = safePath(root, relative);
  if (!existsSync(file)) return null;
  assert(lstatSync(file).isFile() && lstatSync(file).size <= MAX_FILE, "Review事实原件不是普通文件或超出预算");
  return { path: relative, absolute: file, bytes: readFileSync(file) };
}
function git(root, args, { limit = MAX_FILE, input, allowMissing = false } = {}) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", ...args], { cwd: root, shell: false, input, encoding: "utf8", timeout: 30000, maxBuffer: limit,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (allowMissing && result.status === 1) return null;
  assert(result.status === 0 && !result.error, `Review事实Git查询失败或超出预算：${args[0]}`);
  assert(Buffer.byteLength(result.stdout) <= limit, "Review事实Git输出超出预算"); return result.stdout;
}
function sourceBound(value, project, sha) {
  return value && (value.project || value.run?.project) === project && [value.candidateSha, value.commitSha, value.run?.commitSha].some((item) => item === sha)
    && [value.candidateSha, value.commitSha, value.run?.commitSha].filter((item) => item !== undefined && item !== null).every((item) => item === sha);
}
function testChecks(report, requiredIds, root) {
  if (!requiredIds.length) return { ok: false, reason: "required-business-test-checks-not-approved" };
  const checks = [], originals = [];
  for (const id of requiredIds) {
    const matches = report.checks.filter((check) => check.checkId === id), check = matches[0];
    if (matches.length !== 1 || check.tool !== "junit" || check.required !== true || check.status !== "ok" || !check.toolVersionVerified || report.policy?.lockedToolVersions?.[id] !== check.toolVersion || !report.policy?.requiredCheckIds?.includes(id)) return { ok: false, reason: `required-test-check-not-executed:${id}` };
    const evidence = check.testEvidence, production = check.production;
    if (!evidence || evidence.complete !== true || !evidence.files?.length || !production || production.commitSha !== report.run.commitSha || production.eventId !== report.run.eventId || production.sourceDigest !== report.run.sourceDigest)
      return { ok: false, reason: `required-test-original-provenance-missing:${id}` };
    const counts = evidence.counts;
    if (!counts || !Number.isInteger(counts.tests) || counts.tests <= 0 || counts.tests !== counts.passed + counts.failures + counts.errors + counts.skipped) return { ok: false, reason: `required-test-case-counts-invalid:${id}` };
    const actualCounts = { tests: 0, passed: 0, failures: 0, errors: 0, skipped: 0 }, identities = new Set();
    for (const file of evidence.files) {
      const actual = ordinary(root, file.file), bound = production.reports?.find((item) => item.file === file.file);
      if (!actual || hash(actual.bytes) !== file.sha256 || !bound || bound.sha256 !== file.sha256) return { ok: false, reason: `required-test-raw-report-missing-or-changed:${id}` };
      let parsed; try { parsed = parseXml(actual.bytes.toString("utf8")); } catch { return { ok: false, reason: `required-test-raw-junit-invalid:${id}` }; }
      if (!["testsuite", "testsuites"].includes(parsed.name)) return { ok: false, reason: `required-test-raw-junit-invalid:${id}` };
      const cases = [], visit = (node) => { if (node.name === "testcase") cases.push(node); else for (const child of node.children) if (["testsuite", "testsuites", "testcase"].includes(child.name)) visit(child); }; visit(parsed);
      if (cases.length === 0) return { ok: false, reason: `required-test-zero-actual-cases:${id}` };
      const fileCounts = { tests: cases.length, passed: 0, failures: 0, errors: 0, skipped: 0 };
      for (const test of cases) {
        const identity = `${test.attrs.classname || ""}#${test.attrs.name || ""}`, states = test.children.filter((node) => ["failure", "error", "skipped"].includes(node.name));
        if (!test.attrs.name || identities.has(identity) || states.length > 1) return { ok: false, reason: `required-test-case-identity-invalid:${id}` }; identities.add(identity);
        fileCounts[states.length ? { failure: "failures", error: "errors", skipped: "skipped" }[states[0].name] : "passed"]++;
      }
      if (!file.counts || Object.keys(fileCounts).some((key) => file.counts[key] !== fileCounts[key])) return { ok: false, reason: `required-test-file-counts-conflict:${id}` };
      for (const key of Object.keys(actualCounts)) actualCounts[key] += fileCounts[key];
      originals.push({ ...actual, sha256: file.sha256 });
    }
    if (Object.keys(actualCounts).some((key) => counts[key] !== actualCounts[key])) return { ok: false, reason: `required-test-total-counts-conflict:${id}` };
    checks.push({ checkId: id, status: check.status, testEvidence: evidence, production,
      observedOutcome: counts.failures || counts.errors || counts.skipped || counts.passed !== counts.tests ? "not-all-passed" : "all-executed-cases-passed" });
  }
  return { ok: true, checks, originals };
}

export function produceReviewFacts({ root, summaryFile, planFile, outDir, baseSha, now = Date.now() }) {
  assert(root && summaryFile && outDir, "Review事实生产须明确项目、原始摘要和新输出目录");
  root = path.resolve(root); assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "Review事实项目必须是真实目录"); root = realpathSync(root);
  assert(realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) === root, "Review事实必须从实际Git仓库根生产");
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim(); assert(SHA_PATTERN.test(head), "Review事实缺少真实HEAD");
  const relative = (file) => path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join("/") : file;
  const summaryOriginal = ordinary(root, relative(summaryFile)); assert(summaryOriginal, "Review事实缺少当前Gate原始摘要");
  assert(validateReportFile(summaryOriginal.absolute).ok, "Review事实Gate原始摘要结构无效");
  const report = JSON.parse(summaryOriginal.bytes), state = snapshotSource(root);
  assert(report.run.commitSha === head && report.run.sourceBound === true && report.run.sourceDigest === state.digest && !state.dirty, "Review事实摘要未绑定当前干净Git HEAD/实际源码摘要");
  const planOriginal = planFile ? ordinary(root, relative(planFile)) : null;
  assert(!planFile || planOriginal, "Review事实计划原件不存在");
  const plan = planOriginal ? JSON.parse(planOriginal.bytes) : { schemaVersion: 1, project: report.run.project, evidence: [] };
  assert(plan.schemaVersion === 1 && plan.project === report.run.project && Array.isArray(plan.evidence) && plan.evidence.length <= 32, "Review事实批准计划版本/项目/材料清单无效");
  const requiredIds = plan.requiredTestCheckIds || [];
  assert(Array.isArray(requiredIds) && requiredIds.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) && new Set(requiredIds).size === requiredIds.length, "Review事实批准业务测试检查编号无效");
  if (baseSha && plan.baseSha) assert(baseSha === plan.baseSha, "CI变更基线与批准计划baseSha不一致");
  let base = baseSha || plan.baseSha || null, candidateContextOriginal = null;
  const parents = git(root, ["rev-list", "--parents", "-n", "1", head]).trim().split(" ").slice(1);
  if (plan.candidateContextFile) {
    candidateContextOriginal = ordinary(root, plan.candidateContextFile); assert(candidateContextOriginal, "候选上下文原件缺失");
    const candidate = JSON.parse(candidateContextOriginal.bytes);
    assert(candidate.candidateSha === head && SHA_PATTERN.test(candidate.sourceSha || "") && SHA_PATTERN.test(candidate.targetBeforeSha || "") && parents.length === 2 && parents[0] === candidate.targetBeforeSha && parents[1] === candidate.sourceSha, "候选上下文与当前HEAD/双亲实际关系不匹配");
    for (const field of ["source", "target"]) { assert(typeof candidate[field] === "string" && candidate[field], "候选上下文缺少源/目标分支"); git(root, ["check-ref-format", "--branch", candidate[field]]); }
    assert(!base || base === candidate.targetBeforeSha, "变更基线不能替换已核验候选的目标旧SHA"); base = candidate.targetBeforeSha;
  }
  if (base) { assert(SHA_PATTERN.test(base), "Review diff基线必须为完整真实SHA，不能执行可变ref或参数"); git(root, ["cat-file", "-e", `${base}^{commit}`]); git(root, ["merge-base", "--is-ancestor", base, head]); }
  const range = base ? `${base}..${head}` : head, rangeCommits = base ? git(root, ["rev-list", "--reverse", "--max-count=501", range]).trim().split("\n").filter(Boolean) : null;
  const commits = rangeCommits?.length ? rangeCommits : [head];
  assert(commits.length <= 500, "Review提交区间超过500条预算");
  let messageBytes = 0;
  const messages = commits.map((sha) => { const raw = git(root, ["cat-file", "commit", sha], { limit: 1024 * 1024 }), separator = raw.indexOf("\n\n"); messageBytes += Buffer.byteLength(raw); assert(messageBytes <= MAX_DIFF, "实际提交历史超出整体字节预算"); assert(separator >= 0, "实际commit对象格式无效"); return { sha, headers: raw.slice(0, separator), message: raw.slice(separator + 2), rawObjectSha256: hash(raw) }; });
  const numstat = base ? git(root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", base, head, "--"], { limit: MAX_DIFF }) : null;
  const patch = base ? git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", base, head, "--"], { limit: MAX_DIFF }) : null;
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowMissing: true })?.trim() || null;
  const files = new Map(), evidence = [], missingEvidence = [];
  const add = (id, type, dimensionIds, file, bytes, source) => { const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); assert(!files.has(file), "Review事实输出编号/目标重复"); files.set(file, data); evidence.push({ id, type, dimensionIds, file, project: plan.project, candidateSha: head, sha256: hash(data), source }); };
  const common = { schemaVersion: 1, project: plan.project, candidateSha: head, baseSha: base, sourceDigest: state.digest, observedAt: new Date(now).toISOString(), approved: false };
  const destination = controlledPath(path.isAbsolute(outDir) ? outDir : path.join(root, outDir)), outputRelative = path.relative(root, destination);
  assert(destination !== root && (!outputRelative || outputRelative.startsWith(".." + path.sep) || outputRelative === ".." || outputRelative.split(path.sep)[0] === "quality-reports"), "项目内Review事实输出只能放在quality-reports，不能落入源码/.git");
  assert(!existsSync(destination), "Review事实输出已存在，不能覆盖原件或旧证据");
  const declared = new Set(), types = new Set();
  for (const item of plan.evidence) {
    assert(item && typeof item.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.id) && !["submission", "branch", "diff", "gate-current", "gate-before"].includes(item.id) && (item.id !== "tests" || item.type === "test-verification") && !declared.has(item.id) && !types.has(item.type) && MATERIAL[item.type], "Review材料编号/类型无效或重复");
    declared.add(item.id); types.add(item.type);
    assert(Array.isArray(item.dimensionIds) && item.dimensionIds.length && new Set(item.dimensionIds).size === item.dimensionIds.length && item.dimensionIds.every((id) => MATERIAL[item.type].dimensions.includes(id)), "Review材料类型不能冒充其他维度");
    const original = ordinary(root, item.file);
    if (!original) { missingEvidence.push({ id: item.id, type: item.type, dimensionIds: item.dimensionIds, reason: "source-file-missing", file: item.file }); continue; }
    if (item.type === "test-verification") continue;
    let value; try { value = JSON.parse(original.bytes); } catch { missingEvidence.push({ id: item.id, type: item.type, dimensionIds: item.dimensionIds, reason: "candidate-bound-json-required", file: item.file }); continue; }
    if (!sourceBound(value, plan.project, head)) { missingEvidence.push({ id: item.id, type: item.type, dimensionIds: item.dimensionIds, reason: "project-or-candidate-not-bound", file: item.file }); continue; }
    add(item.id, item.type, item.dimensionIds, MATERIAL[item.type].file, original.bytes, `approved-plan/raw:${item.file}`);
  }
  const actualTests = testChecks(report, requiredIds, root);
  if (actualTests.ok) {
    // The collector archives fixed paths. Retain exact JUnit bytes inside the
    // fixed tests.json, rather than inventing dynamic artifact paths it cannot
    // know before the job. Consumers can re-hash/re-parse the original bytes.
    const originals = actualTests.originals.map((original) => ({ sourceFile: original.path, sha256: original.sha256,
      encoding: "base64", rawBytesBase64: original.bytes.toString("base64") }));
    add("tests", "test-verification", ["tests"], "tests.json", json({ ...common, status: "observed-test-execution", requiredTestCheckIds: requiredIds, checks: actualTests.checks, originals, businessAcceptance: "pending-independent-review" }), "actual-gate-required-tests/raw-junit");
    for (let i = missingEvidence.length - 1; i >= 0; i--) if (missingEvidence[i].type === "test-verification") missingEvidence.splice(i, 1);
  } else missingEvidence.push({ id: "tests", type: "test-verification", dimensionIds: ["tests"], reason: actualTests.reason });
  for (const [type, spec] of Object.entries(MATERIAL)) if (!evidence.some((item) => item.type === type) && !missingEvidence.some((item) => item.type === type)) missingEvidence.push({ id: type, type, dimensionIds: spec.dimensions, reason: "approved-original-not-provided" });
  assert([...files.values()].reduce((total, bytes) => total + bytes.byteLength, 0) + Buffer.byteLength(patch || "") + Buffer.byteLength(json(messages)) <= MAX_TOTAL, "Review事实原件总量超出预算");
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); const staging = mkdtempSync(path.join(path.dirname(destination), ".review-facts-")); let published = false;
  try {
    const checkedMessages = messages.map((entry) => { const messageFile = path.join(staging, `${entry.sha}.message`); writeFileSync(messageFile, entry.message, { flag: "wx", mode: 0o600 }); let check; try { check = validateCommitMessage(messageFile, root); } catch { check = { ok: false, reason: "project-commit-policy-unavailable" }; } finally { rmSync(messageFile); } return { ...entry, commitConvention: check }; });
    add("submission", "commit-check", ["submission"], "submission.json", json({ ...common, status: "observed-commit-history", commitRangeKnown: base !== null, commitsSinceBase: rangeCommits?.length ?? null, commits: checkedMessages, allCommitConventionsMatched: checkedMessages.every((entry) => entry.commitConvention.ok), identityVerified: false }), "actual-git/cat-file-commit");
    add("branch", "branch-check", ["branch"], "branch.json", json({ ...common, status: "observed-branch-topology", ref: branch, detached: branch === null, parents, baseIsAncestor: base !== null, policyApproval: "pending-independent-review" }), "actual-git/ref-and-parents");
    if (patch !== null) add("diff", "diff", ["coding", "review"], "diff.patch", patch, "actual-git/diff-base-head");
    else missingEvidence.push({ id: "diff", type: "diff", dimensionIds: ["coding", "review"], reason: "approved-change-base-unknown-no-head-parent-fallback" });
    const snapshot = snapshotSource(root); assert(snapshot.sha === state.sha && snapshot.digest === state.digest && !snapshot.dirty, "Review事实生产期间HEAD/源码变化，拒绝发布混合证据");
    assert(hash(readFileSync(summaryOriginal.absolute)) === hash(summaryOriginal.bytes) && (!planOriginal || hash(readFileSync(planOriginal.absolute)) === hash(planOriginal.bytes)), "Review事实生产期间摘要/批准计划变化");
    if (candidateContextOriginal) assert(hash(readFileSync(candidateContextOriginal.absolute)) === hash(candidateContextOriginal.bytes), "候选上下文原件生产期间变化");
    const manifest = { ...common, kind: "review-evidence-manifest", status: "facts-produced-pending-review", evidence, missingEvidence, diff: { status: base ? "actual-base-head-diff" : "range-unknown", baseSha: base, headSha: head, numstat, fullDiffBytes: patch === null ? null : Buffer.byteLength(patch), truncated: false },
      summary: { sourceFile: summaryOriginal.path, sha256: hash(summaryOriginal.bytes), eventId: report.run.eventId || null }, plan: planOriginal ? { sourceFile: planOriginal.path, sha256: hash(planOriginal.bytes) } : null,
      candidateContext: candidateContextOriginal ? { sourceFile: candidateContextOriginal.path, sha256: hash(candidateContextOriginal.bytes) } : null,
      artifactPaths: [...files.keys(), "review-evidence.json"], repairAuthorized: false, reviewApproved: false, promotionAuthorized: false, deploymentAuthorized: false, closureAuthorized: false };
    for (const [file, bytes] of files) { mkdirSync(path.dirname(path.join(staging, file)), { recursive: true }); writeFileSync(path.join(staging, file), bytes, { flag: "wx", mode: 0o600 }); }
    writeFileSync(path.join(staging, "review-evidence.json"), json(manifest), { flag: "wx", mode: 0o600 });
    assert(!existsSync(destination), "Review事实输出被并发占用，拒绝覆盖"); renameSync(staging, destination); published = true;
    return { status: manifest.status, project: plan.project, candidateSha: head, manifestFile: path.join(destination, "review-evidence.json"), evidenceRoot: destination, evidence, missingEvidence, artifactPaths: manifest.artifactPaths, approved: false };
  } finally { if (!published) rmSync(staging, { recursive: true, force: true }); }
}
