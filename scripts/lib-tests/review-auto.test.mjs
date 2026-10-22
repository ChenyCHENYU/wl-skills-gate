import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync, existsSync, cpSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { autoReviewDraft } from "../../lib/review-auto.js";
import { supplementReviewDraft } from "../../lib/review.js";
import { runGate } from "../../lib/run.js";
import { execFileSync } from "node:child_process";
const packageRoot = path.resolve(import.meta.dirname, "../..");
function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-review-auto-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "quality")); const outDir = path.join(root, "quality-reports"); mkdirSync(outDir);
  const policy = JSON.parse(readFileSync(path.join(packageRoot, "templates/quality/review-policy.json"))); policy.project = "demo";
  writeFileSync(path.join(root, "quality/review-policy.json"), JSON.stringify(policy));
  const summary = { schemaVersion: 1, run: { eventId: "event-one", project: "demo", profile: "standard", commitSha: "a".repeat(40), startedAt: new Date().toISOString(), durationMs: 1, tool: "gate", sourceBound: true, sourceDigest: "a".repeat(64) },
    policy: { requiredCheckIds: ["CHECK"], checksSelected: 1, policyHash: "a".repeat(64), ruleSetHash: "a".repeat(64), baselineHash: "a".repeat(64), waiversHash: "a".repeat(64), lockedToolVersions: { CHECK: "1.0" } },
    checks: [{ checkId: "CHECK", required: true, status: "ok", toolVersion: "1.0", toolVersionVerified: true }], findings: [], counts: {}, decision: { status: "passed", reasons: [] } };
  const run = () => { writeFileSync(path.join(outDir, "quality-summary.json"), JSON.stringify(summary)); return autoReviewDraft({ root, outDir, summary }); };
  return { root, outDir, summary, run };
}
test("普通扫描后自动生成九维待确认草稿，缺证据不伪造已批准", (t) => {
  const f = fixture(t), r = f.run(), record = JSON.parse(readFileSync(r.recordFile));
  assert.equal(record.decision, "pending-confirmation"); assert.equal(record.authorId, "unverified-local-author");
  assert.equal(r.signed, false); assert.equal(record.content.dimensions.length, 9);
  assert.equal(record.content.dimensions.filter((d) => d.status === "pending-evidence").length, 8);
});
test("项目Hook自动生成九维可读详情，使用本轮原始发现和草稿证据且不生成CI页面", (t) => {
  const f = fixture(t); f.summary.run.stage = "local-hook";
  const result = f.run();
  assert(result.projectReportFile);
  const html = readFileSync(result.projectReportFile, "utf8");
  assert.equal((html.match(/class="dimension-section" id="dimension-/g) || []).length, 9);
  assert.match(html, /第一道 · 项目内检查/);
  assert.match(html, /代码审核由技术经理确认/);
  f.summary.run.stage = "ci"; f.summary.run.eventId = "event-ci";
  const ci = f.run(); assert.equal(ci.projectReportFile, undefined);
});
test("后续扫描自动留存前后原始报告并生成可比差异，旧草稿保持", (t) => {
  const f = fixture(t); f.summary.findings = [{ fingerprint: "f".repeat(64), ruleId: "R", severity: "error", file: "a.java", status: "new" }];
  const before = f.run(); f.summary.run.eventId = "event-two"; f.summary.findings = [];
  const after = f.run(); assert.equal(after.comparison.comparable, true); assert.equal(after.comparison.before.error, 1); assert.equal(after.comparison.after.error, 0);
  assert(existsSync(before.recordFile)); assert(existsSync(after.recordFile));
});
test("上轮摘要损坏和越界索引保留恢复证据，新草稿不伪造改善也不永久堵扫描", (t) => {
  const f = fixture(t); f.run(); const indexFile = path.join(f.outDir, "review-latest.json"), index = JSON.parse(readFileSync(indexFile));
  writeFileSync(path.join(f.outDir, index.summaryFile), "{}"); f.summary.run.eventId = "event-two";
  const damaged = f.run(); assert.match(damaged.historyWarning, /损坏/); assert.equal(damaged.comparison, null);
  assert(existsSync(path.join(damaged.evidenceRoot, "history-recovery.json"))); assert.match(readFileSync(damaged.bodyFile, "utf8"), /历史比较未使用/);
  index.summaryFile = "quality/review-policy.json"; writeFileSync(indexFile, JSON.stringify(index)); f.summary.run.eventId = "event-three";
  const escaped = f.run(); assert.match(escaped.historyWarning, /越界/); assert.equal(escaped.comparison, null);
  f.summary.run.eventId = "event-four"; const recovered = f.run(); assert.equal(recovered.historyWarning, null); assert.equal(recovered.comparison.comparable, true);
});
test("自动正文必须保留原报告全部强制问题，不能显示零阻断", (t) => {
  const f = fixture(t); f.summary.findings = [{ fingerprint: "f".repeat(64), ruleId: "R", severity: "error", file: "a.java", status: "new" }];
  f.summary.decision.status = "blocked"; f.summary.counts.blockingNew = 1;
  const draft = f.run(), record = JSON.parse(readFileSync(draft.recordFile));
  assert.equal(record.unresolvedBlocking.length, 1); assert.match(readFileSync(draft.bodyFile, "utf8"), /未处置阻断：1/);
});
test("候选增量范围在正文明确显示base/head，不能标成full", (t) => {
  const f = fixture(t); f.summary.run.base = 'b'.repeat(40); f.summary.run.head = f.summary.run.commitSha;
  const r = f.run(), record = JSON.parse(readFileSync(r.recordFile));
  assert.equal(record.scope, `range:${f.summary.run.base}..${f.summary.run.head}`);
  assert.match(readFileSync(r.bodyFile, 'utf8'), /范围：range:/);
});
test("项目根路径别名产生的索引仍相对报告目录，复制后可以补证", (t) => {
  const f = fixture(t), alias = `${f.root}-alias`; symlinkSync(f.root, alias); t.after(() => rmSync(alias, { force: true }));
  writeFileSync(path.join(f.outDir, "quality-summary.json"), JSON.stringify(f.summary));
  const r = autoReviewDraft({ root: alias, outDir: path.join(alias, "quality-reports"), summary: f.summary }), index = JSON.parse(readFileSync(r.indexFile));
  assert.equal(index.schemaVersion, 2); assert(index.recordFile.startsWith("reviews/"));
  assert(!index.recordFile.includes("..")); assert(existsSync(path.join(f.outDir, index.recordFile)));
  assert(existsSync(path.join(f.outDir, index.inputFile)));
  const archive = `${f.root}-archive`; cpSync(f.outDir, archive, { recursive: true }); t.after(() => rmSync(archive, { recursive: true, force: true }));
  rmSync(f.outDir, { recursive: true });
  const supplemented = supplementReviewDraft({ recordFile: path.join(archive, index.recordFile), inputFile: path.join(archive, index.inputFile),
    evidenceRoot: path.join(archive, index.evidenceRoot), authorId: "verified-author", outDir: path.join(archive, index.evidenceRoot, "supplemented") });
  const record = JSON.parse(readFileSync(supplemented.recordFile)); assert.equal(record.content.reviewId, f.summary.run.eventId);
  assert.equal(record.content.derivedFrom.recordFile, "draft/review-draft.json");
  f.summary.run.eventId = "event-two"; writeFileSync(path.join(archive, "quality-summary.json"), JSON.stringify(f.summary));
  const next = autoReviewDraft({ root: f.root, outDir: archive, summary: f.summary }); assert.equal(next.comparison.comparable, true);
});
test("补证不能修改原候选上下文、移除Gate证据或复用损坏正文", (t) => {
  const f = fixture(t), r = f.run(), input = JSON.parse(readFileSync(r.inputFile));
  const supplement = () => supplementReviewDraft({ recordFile: r.recordFile, inputFile: r.inputFile, evidenceRoot: r.evidenceRoot, outDir: path.join(r.evidenceRoot, "supplemented") });
  input.target = "prd"; writeFileSync(r.inputFile, JSON.stringify(input)); assert.throws(supplement, /target/);
  input.target = null; input.evidence = []; writeFileSync(r.inputFile, JSON.stringify(input)); assert.throws(supplement, /原始 Gate/);
  writeFileSync(r.bodyFile, "replaced"); assert.throws(supplement, /原自动草稿已变化/);
});
test("旧版有效索引自动迁移仍能比较；畸形JSON会保留原件并恢复新链", (t) => {
  const f = fixture(t), first = f.run(), old = JSON.parse(readFileSync(first.indexFile));
  old.schemaVersion = 1; for (const key of ['recordFile', 'bodyFile', 'summaryFile']) old[key] = `quality-reports/${old[key]}`;
  writeFileSync(first.indexFile, JSON.stringify(old)); f.summary.run.eventId = 'event-two';
  const migrated = f.run(); assert.equal(migrated.comparison.comparable, true); assert.equal(JSON.parse(readFileSync(migrated.indexFile)).schemaVersion, 2);
  writeFileSync(migrated.indexFile, '{damaged'); f.summary.run.eventId = 'event-three';
  const recovered = f.run(); assert(recovered.historyWarning); assert.equal(recovered.comparison, null);
  assert.equal(readFileSync(path.join(recovered.evidenceRoot, 'previous-index.invalid.json'), 'utf8'), '{damaged');
});
test("真实Gate标准档自动调用草稿生成；无需额外扫描/命令", async (t) => {
  const f = fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: f.root }); execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial"], { cwd: f.root });
  writeFileSync(path.join(f.root, "quality/policy.json"), JSON.stringify({ schemaVersion: 1, project: "demo", checks: [{ id: "CHECK", dimension: "coding", tool: "raw-json", file: "input.json", profiles: ["standard"], required: true }] }));
  writeFileSync(path.join(f.root, "input.json"), JSON.stringify({ findings: [] }));
  const r = await runGate({ argv: ["--root", f.root, "--profile", "standard"] });
  assert(r.review?.recordFile); assert.equal(r.review.approved, false); assert(existsSync(r.review.bodyFile));
});
