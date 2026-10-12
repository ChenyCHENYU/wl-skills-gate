#!/usr/bin/env node
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runGate } from "../lib/run.js";
import { buildFixPlan, applyFixPlan } from "../lib/fix.js";
import { verifyArtifact } from "../lib/verify-artifact.js";
import { promote, applyPromotion } from "../lib/promote.js";
import { signGateProof, createArtifactManifest, signReviewRecord } from "../lib/evidence.js";
import { validateCommitMessage } from "../lib/commit-message.js";

const [command, ...rest] = process.argv.slice(2);
const FLAGS = new Set(["--confirm", "--push", "--allow-any"]);

function options(allowed) {
  const out = { positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!name.startsWith("--")) { out.positional.push(name); continue; }
    if (!allowed.includes(name) || Object.hasOwn(out, name)) throw new Error(`未知或重复参数: ${name}`);
    if (FLAGS.has(name)) { out[name] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${name} 缺少值`);
    out[name] = value;
  }
  if (out.positional.length > 1) throw new Error("位置参数过多");
  return out;
}

function writeJson(file, value) {
  if (!file) throw new Error("缺少 --out");
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
  console.log(`[${command}] 已写入 ${file}`);
}

const PROOF_FLAGS = ["--summary", "--sha", "--project", "--env", "--expect-policy-hash", "--expect-rules-hash",
  "--expect-baseline-hash", "--expect-waivers-hash",
  "--expect-pipeline-id", "--expect-job-id",
  "--public-key", "--expect-issuer", "--max-age-minutes", "--manifest", "--artifact-root"];

function proofOptions(o) {
  return { attestationFile: o.positional[0], summaryFile: o["--summary"], sha: o["--sha"], project: o["--project"],
    env: o["--env"], expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"],
    expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"],
    expectPipelineId: o["--expect-pipeline-id"], expectJobId: o["--expect-job-id"],
    publicKeyFile: o["--public-key"], expectIssuer: o["--expect-issuer"],
    maxAgeMinutes: o["--max-age-minutes"] === undefined ? 1440 : Number(o["--max-age-minutes"]),
    manifestFile: o["--manifest"], artifactRoot: o["--artifact-root"] };
}

try {
  if (command === "run") {
    process.exitCode = (await runGate({ argv: rest })).exitCode;
  } else if (command === "cost") {
    const o = options(["--usage", "--out"]);
    if (!o.positional[0] || !o["--out"]) throw new Error("cost 必须提供工件目录和 --out；不默认将完整统计塞入控制台");
    if (path.basename(o["--out"]) === "quality-summary.json" || (o["--usage"] && path.resolve(o["--out"]) === path.resolve(o["--usage"]))) throw new Error("成本输出不能覆盖 quality-summary 或 usage 输入");
    const { collectCost } = await import("../lib/cost.js");
    writeJson(o["--out"], collectCost(o.positional[0], { usageFile: o["--usage"] }));
  } else if (command === "inspect") {
    const o = options(["--view", "--status", "--severity", "--rule", "--limit", "--max-bytes", "--cursor"]);
    const { inspectReport } = await import("../lib/inspect.js");
    const r = inspectReport(o.positional[0], { view: o["--view"], status: o["--status"], severity: o["--severity"],
      rule: o["--rule"], limit: o["--limit"], maxBytes: o["--max-bytes"], cursor: o["--cursor"] });
    process.stdout.write(r.text);
    process.exitCode = r.exitCode;
  } else if (command === "fix") {
    const o = options(["--plan", "--apply", "--root", "--profile", "--confirm"]);
    if (!!o["--plan"] === !!o["--apply"]) throw new Error("fix 必须且只能选择 --plan 或 --apply");
    if (o["--plan"]) console.log(`[fix] 计划: ${buildFixPlan(o["--plan"], { root: o["--root"] }).planFile}`);
    else {
      const r = await applyFixPlan(o["--apply"], { root: o["--root"], profile: o["--profile"], confirm: !!o["--confirm"] });
      console.log(`[fix] scanResolved=${r.fixReport.scanResolved} rolledBack=${r.fixReport.rolledBack} nextState=${r.fixReport.nextState} 报告=${r.reportFile}`);
      process.exitCode = r.exitCode;
    }
  } else if (command === "validate-report") {
    const o = options([]);
    const { validateReportFile } = await import("../lib/validate-report.js");
    const r = validateReportFile(o.positional[0]);
    if (!r.ok) throw new Error(r.errors.join("; "));
    console.log("[validate-report] 通过");
  } else if (command === "commit-message") {
    const o = options(["--root"]);
    const r = validateCommitMessage(o.positional[0], path.resolve(o["--root"] || "."));
    if (!r.ok) { console.error(`[commit-message] ${r.reason}`); process.exitCode = 1; }
  } else if (command === "manifest") {
    const o = options(["--root", "--project", "--env", "--artifacts", "--configs", "--out"]);
    createArtifactManifest({ root: path.resolve(o["--root"] || "."), project: o["--project"], env: o["--env"],
      artifacts: o["--artifacts"]?.split(","), configFiles: o["--configs"]?.split(",") || [], outFile: o["--out"] });
    console.log(`[manifest] ${o["--out"]}`);
  } else if (command === "attest") {
    const o = options([...PROOF_FLAGS, "--profile", "--private-key", "--issuer", "--pipeline-id", "--job-id", "--promotion-record", "--out"]);
    writeJson(o["--out"], signGateProof({ ...proofOptions(o), summaryFile: o["--summary"] || o.positional[0],
      profile: o["--profile"], privateKeyFile: o["--private-key"], issuer: o["--issuer"],
      pipelineId: o["--pipeline-id"], jobId: o["--job-id"], promotionRecordFile: o["--promotion-record"] }));
  } else if (command === "review-sign") {
    const o = options(["--private-key", "--reviewer-id", "--author-id", "--project", "--sha", "--out"]);
    writeJson(o["--out"], signReviewRecord({ recordFile: o.positional[0], privateKeyFile: o["--private-key"],
      reviewerId: o["--reviewer-id"], authorId: o["--author-id"], project: o["--project"], sha: o["--sha"] }));
  } else if (command === "verify-artifact") {
    const r = verifyArtifact(proofOptions(options(PROOF_FLAGS)));
    if (!r.ok) throw new Error(r.errors.join("; "));
    console.log("[verify-artifact] 签名、质量证据及实际制品通过");
  } else if (command === "promote") {
    const o = options(["--root", "--source", "--target", "--remote", "--profile", "--push", "--allow-any", "--expect-policy-hash", "--expect-rules-hash", "--expect-baseline-hash", "--expect-waivers-hash", "--prepare-command"]);
    const r = await promote({ root: o["--root"] || ".", source: o["--source"], target: o["--target"], remote: o["--remote"],
      profile: o["--profile"], push: !!o["--push"], allowAny: !!o["--allow-any"],
      expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"],
      expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"], prepareCommand: o["--prepare-command"] });
    console.log(`[promote] ${r.status} record=${r.recordFile}`);
    for (const reason of r.reasons) console.error(reason);
    process.exitCode = r.exitCode;
  } else if (command === "promote-apply") {
    const o = options([...PROOF_FLAGS, "--record", "--remote-url", "--bundle", "--review", "--review-public-key", "--out"]);
    const r = applyPromotion({ ...proofOptions(o), recordFile: o["--record"], remoteUrl: o["--remote-url"],
      bundleFile: o["--bundle"], reviewFile: o["--review"], reviewPublicKeyFile: o["--review-public-key"], outDir: o["--out"] });
    console.log(`[promote-apply] ${r.status}`);
    for (const reason of r.reasons) console.error(reason);
    process.exitCode = r.exitCode;
  } else if (command === "self-test") {
    if (rest.length) throw new Error("self-test 不接受额外参数");
    const { runAllFixtures } = await import("../scripts/run-fixtures.mjs");
    process.exitCode = await runAllFixtures();
  } else throw new Error("用法: wl-skills-gate <run|inspect|cost|fix|validate-report|commit-message|manifest|attest|review-sign|verify-artifact|promote|promote-apply|self-test>，详见 docs/README.md");
} catch (e) { console.error(`[${command || "wl-skills-gate"}] ${e.message}`); process.exitCode = 2; }
