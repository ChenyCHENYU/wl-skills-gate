#!/usr/bin/env node
import path from "node:path";
import { existsSync } from "node:fs";
import { produceReviewFacts } from "../../lib/review-facts.js";

const options = { root: process.cwd(), summaryFile: "quality-reports/quality-summary.json", outDir: "quality-reports/review" };
const names = new Map([["--root", "root"], ["--summary", "summaryFile"], ["--plan", "planFile"], ["--out-dir", "outDir"], ["--base-sha", "baseSha"]]);
const seen = new Set();
try {
  for (let i = 2; i < process.argv.length; i++) { const flag = process.argv[i], name = names.get(flag), value = process.argv[++i]; if (!name || seen.has(flag) || !value || value.startsWith("--")) throw new Error("Review事实入口参数无效/重复/缺值"); seen.add(flag); options[name] = value; }
  if (!options.planFile && existsSync(path.join(options.root, "quality/review-evidence.plan.json"))) options.planFile = "quality/review-evidence.plan.json";
  const ciBase = [process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA, process.env.CI_COMMIT_BEFORE_SHA].find((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "") && !/^0+$/.test(value));
  if (!options.baseSha && ciBase) options.baseSha = ciBase;
  process.stdout.write(JSON.stringify(produceReviewFacts(options), null, 2) + "\n");
} catch (error) { process.stderr.write(`[review-facts] ${error.message}\n`); process.exitCode = 2; }
