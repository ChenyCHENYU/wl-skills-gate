import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { safePath } from "./source-state.js";
import { buildReviewInput, createReviewDraft, validateReviewPolicy } from "./review.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

// Drafts are produced by ordinary hooks/CI, without model calls or authority.
// Unauthenticated local identity is deliberately unusable as a formal approval.
export function autoReviewDraft({ root, outDir, summary, context = {}, authorId = process.env.WL_REVIEW_AUTHOR_ID || "unverified-local-author" }) {
  root = realpathSync(root); outDir = realpathSync(outDir);
  const policyFile = safePath(root, "quality/review-policy.json");
  if (!existsSync(policyFile) || summary.run.profile === "fast") return { status: "not-configured", approved: false };
  const policy = validateReviewPolicy(JSON.parse(readFileSync(policyFile, "utf8")), summary.run.project);
  if (!/^[A-Za-z0-9-]{1,128}$/.test(summary.run.eventId || "")) throw new Error("自动Review事件编号无效");
  const relativeOut = path.relative(root, outDir);
  const destination = safePath(outDir, path.join("reviews", summary.run.eventId));
  const parent = safePath(outDir, "reviews");
  mkdirSync(parent, { recursive: true });
  mkdirSync(destination, { mode: 0o700 });
  const summaryText = readFileSync(path.join(outDir, "quality-summary.json"), "utf8");
  if (JSON.stringify(JSON.parse(summaryText)) !== JSON.stringify(summary)) throw new Error("本轮质量报告在生成Review前已变化，拒绝串用其他扫描结果");
  const currentFile = path.join(destination, "quality-summary.json"), policyCopy = path.join(destination, "review-policy.json");
  writeFileSync(currentFile, summaryText, { flag: "wx", mode: 0o600 });
  writeFileSync(policyCopy, json(policy), { flag: "wx", mode: 0o600 });
  const indexFile = safePath(outDir, "review-latest.json");
  let beforeSummaryFile, historyWarning = null;
  if (existsSync(indexFile)) {
    // Historical damage must never fabricate improvement or permanently block
    // fresh valid scans. Preserve the bad index and diagnostics, then establish
    // a new comparison chain from this run without deleting any old evidence.
    const rawIndex = readFileSync(indexFile);
    try {
      const index = JSON.parse(rawIndex);
      let previous;
      if (index.schemaVersion === 2) {
        if (typeof index.summaryFile !== "string" || !index.summaryFile.startsWith("reviews/") || index.summaryFile.split("/").includes("..") || path.basename(index.summaryFile) !== "quality-summary.json") throw new Error("上轮Review证据索引越界");
        previous = safePath(outDir, index.summaryFile);
      } else {
        const prefix = path.join(relativeOut, "reviews") + path.sep;
        if (typeof index.summaryFile !== "string" || !index.summaryFile.startsWith(prefix) || index.summaryFile.split(path.sep).includes("..") || path.basename(index.summaryFile) !== "quality-summary.json") throw new Error("上轮Review证据索引越界");
        previous = safePath(root, index.summaryFile);
      }
      if (index.project !== summary.run.project || digest(readFileSync(previous)) !== index.summaryHash) throw new Error("上轮Review原始报告索引或字节损坏，不能生成质量改善结论");
      beforeSummaryFile = path.join(destination, "summary-before.json");
      writeFileSync(beforeSummaryFile, readFileSync(previous), { flag: "wx", mode: 0o600 });
      // Parse/schema failures in a historical report are recovery cases too.
      buildReviewInput({ summaryFile: currentFile, policyFile: policyCopy, evidenceRoot: destination, authorId, beforeSummaryFile });
    } catch (error) {
      historyWarning = error.message; beforeSummaryFile = undefined;
      writeFileSync(path.join(destination, "previous-index.invalid.json"), rawIndex, { flag: "wx", mode: 0o600 });
      writeFileSync(path.join(destination, "history-recovery.json"), json({ schemaVersion: 1, eventId: summary.run.eventId,
        status: "comparison-chain-restarted", reason: historyWarning, previousIndexHash: digest(rawIndex),
        oldEvidenceDeleted: false, comparisonClaimed: false }), { flag: "wx", mode: 0o600 });
    }
  }
  const input = buildReviewInput({ summaryFile: currentFile, policyFile: policyCopy, evidenceRoot: destination, authorId, beforeSummaryFile,
    context: { source: "gate/automatic-hook-or-ci", ...context } });
  input.reviewId = summary.run.eventId;
  if (historyWarning) input.comparisonWarning = historyWarning;
  input.notes = Object.fromEntries(policy.dimensions.map((v) => [v.id, authorId === "unverified-local-author" ? "本地未认证作者；正式汇总须使用受控源码作者身份" : "机器草稿；待受控采集与非作者复核"]));
  const inputFile = path.join(destination, "review-input.json");
  writeFileSync(inputFile, json(input), { flag: "wx", mode: 0o600 });
  const result = createReviewDraft({ input, evidenceRoot: destination, outDir: path.join(destination, "draft") });
  const index = { schemaVersion: 2, project: summary.run.project, eventId: summary.run.eventId, approved: false,
    recordFile: path.relative(outDir, result.recordFile).split(path.sep).join("/"), bodyFile: path.relative(outDir, result.bodyFile).split(path.sep).join("/"), summaryFile: path.relative(outDir, currentFile).split(path.sep).join("/"), summaryHash: digest(summaryText),
    inputFile: path.relative(outDir, inputFile).split(path.sep).join("/"), evidenceRoot: path.relative(outDir, destination).split(path.sep).join("/"), historyWarning,
    pendingDimensions: result.dimensions.filter((v) => v.status !== "evidence-ready").map((v) => v.id), comparison: result.comparison };
  const temp = `${indexFile}.${summary.run.eventId}.tmp`;
  writeFileSync(temp, json(index), { flag: "wx", mode: 0o600 });
  renameSync(temp, indexFile);
  return { ...result, indexFile, inputFile, evidenceRoot: destination, historyWarning, identityVerified: false, signed: false };
}
