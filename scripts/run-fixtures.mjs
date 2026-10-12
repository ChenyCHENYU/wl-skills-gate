import { spawnSync } from "node:child_process";
import { readdirSync, mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exists, readJson } from "../lib/util.js";
import { validateSummaryAgainstSchema } from "../lib/validate-report.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const bin = path.join(pkgRoot, "bin", "wl-skills-gate.js");
const casesDir = path.join(pkgRoot, "fixtures", "cases");
const summarySchema = readJson(path.join(pkgRoot, "schemas", "quality-summary.schema.json"));

function runCase(name, workspace) {
  const dir = path.join(workspace, name);
  cpSync(path.join(casesDir, name), dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}quality-reports`) });
  const expected = readJson(path.join(dir, "expected.json"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: dir });
  const cmdArgs = [
    bin,
    "run",
    "--root",
    dir,
    "--profile",
    expected.profile || "standard",
    ...(expected.profile === "release" ? ["--env", "pre"] : []),
    ...(expected.args || []),
  ];
  const r = spawnSync(process.execPath, cmdArgs, {
    encoding: "utf8",
  });
  const summaryFile = path.join(dir, "quality-reports", "quality-summary.json");
  let summary = null;
  if (exists(summaryFile)) {
    try {
      summary = readJson(summaryFile);
    } catch (e) {
      summary = null;
    }
  }
  const problems = [];
  if (r.status !== expected.exit) problems.push(`exit ${r.status} ≠ ${expected.exit}`);
  if (problems.length && r.stderr) problems.push(`stderr尾: ${r.stderr.slice(-200).replace(/\s+/g, " ")}`);
  if (!summary) {
    problems.push("quality-summary.json 未生成或不可解析（失败也必须出报告）");
  } else {
    if (summary.decision.status !== expected.status) {
      problems.push(`status ${summary.decision.status} ≠ ${expected.status}`);
    }
    for (const [k, v] of Object.entries(expected.counts || {})) {
      if (summary.counts[k] !== v) problems.push(`counts.${k} ${summary.counts[k]} ≠ ${v}`);
    }
    if (expected.waiversInvalid !== undefined && summary.waivers.invalidRecords.length !== expected.waiversInvalid) {
      problems.push(`waiversInvalid ${summary.waivers.invalidRecords.length} ≠ ${expected.waiversInvalid}`);
    }
    if (expected.reasonIncludes && !summary.decision.reasons.join("; ").includes(expected.reasonIncludes)) {
      problems.push(`reason 未包含: ${expected.reasonIncludes}`);
    }
    if (expected.noteIncludes) {
      const notes = (summary.checks || []).map((c) => `${c.note || ""}${c.reason || ""}`).join("; ");
      if (!notes.includes(expected.noteIncludes)) problems.push(`check note 未包含: ${expected.noteIncludes}`);
    }
    if (expected.occurrencesAtLeast !== undefined) {
      const seen = (summary.findings || []).some((f) => (f.occurrences || []).length >= expected.occurrencesAtLeast);
      if (!seen) problems.push(`occurrences 未达到 ${expected.occurrencesAtLeast} 处（指纹合并丢失位置）`);
    }
    for (const schemaError of validateSummaryAgainstSchema(summary, summarySchema)) {
      problems.push(`schema: ${schemaError}`);
    }
    if (!exists(path.join(dir, "quality-reports", "gate-attestation.json"))) {
      problems.push("gate-attestation.json 未生成");
    }
  }
  return { name, ok: !problems.length, problems };
}

function runFixPlanCheck(workspace) {
  const caseDir = path.join(workspace, "02-new-error");
  const summaryFile = path.join(caseDir, "quality-reports", "quality-summary.json");
  if (!exists(summaryFile)) return { name: "fix-plan", ok: false, problems: ["前置 summary 不存在"] };
  const p = spawnSync(process.execPath, [bin, "fix", "--plan", summaryFile], { encoding: "utf8" });
  const planFile = path.join(caseDir, "quality-reports", "repair", "fix-plan.json");
  const problems = [];
  if (p.status !== 0) problems.push(`fix --plan 退出码 ${p.status}`);
  if (!exists(planFile)) problems.push("fix-plan.json 未生成");
  else {
    const plan = readJson(planFile);
    if (!Array.isArray(plan.items) || plan.items.length < 1) problems.push("计划项为空");
    if (!plan.planHash) problems.push("缺少 planHash");
  }
  return { name: "fix-plan", ok: !problems.length, problems };
}

function runFixApplyCheck() {
  const tmp = mkdtempSync(path.join(tmpdir(), "wl-gate-fixapply-"));
  mkdirSync(path.join(tmp, "quality"));
  writeFileSync(path.join(tmp, "src.txt"), "bad");
  writeFileSync(path.join(tmp, "scan.mjs"), `import fs from 'node:fs'; console.log(JSON.stringify({toolVersion:'demo@1',findings:fs.readFileSync('src.txt','utf8')==='bad'?[{ruleId:'DEMO/FIX',severity:'error',file:'src.txt',message:'bad',autoFixable:true,fixerId:'replace-bad'}]:[]}));`);
  writeFileSync(path.join(tmp, "fix.mjs"), `import fs from 'node:fs'; fs.writeFileSync('src.txt','good');`);
  writeFileSync(path.join(tmp, "quality", "policy.json"), JSON.stringify({schemaVersion:1,project:"fixture-repair",checks:[{id:"SCAN",tool:"cmd-json",profiles:["standard"],command:"node scan.mjs"}],fixers:[{id:"replace-bad",ruleIds:["DEMO/FIX"],files:["src.txt"],command:"node fix.mjs"}]}));
  const problems = [];
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  try {
    const r1 = run("run", "--root", tmp, "--profile", "standard");
    if (r1.status !== 1) problems.push(`修复前 exit ${r1.status}≠1`);
    const r2 = run("fix", "--plan", path.join(tmp, "quality-reports", "quality-summary.json"));
    if (r2.status !== 0) problems.push(`计划生成 exit ${r2.status}`);
    const planFile = path.join(tmp, "quality-reports", "repair", "fix-plan.json");
    if (!exists(planFile)) problems.push("fix-plan.json 未生成");
    const r3 = run("fix", "--apply", planFile, "--confirm", "--root", tmp);
    if (r3.status !== 0) problems.push(`修复+复扫 exit ${r3.status}≠0`);
    const frFile = path.join(tmp, "quality-reports", "repair", "fix-report.json");
    if (!exists(frFile)) problems.push("fix-report.json 未生成");
    else {
      const fr = readJson(frFile);
      if (!fr.scanResolved || fr.closed || fr.rolledBack) {
        problems.push(`扫描复验状态异常（scanResolved=${fr.scanResolved} closed=${fr.closed} rolledBack=${fr.rolledBack}）`);
      }
      if (!exists(fr.beforeArchive)) problems.push("beforeArchive 缺失");
      if (!(fr.changedFiles === null || Array.isArray(fr.changedFiles))) problems.push("changedFiles 异常");
      if (fr.applied.length < 1) problems.push("applied 为空");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { name: "fix-apply", ok: !problems.length, problems };
}

export async function runAllFixtures() {
  const caseNames = readdirSync(casesDir)
    .filter((n) => !n.startsWith("."))
    .sort();
  const workspace = mkdtempSync(path.join(tmpdir(), "wl-gate-fixtures-"));
  let results;
  try {
    results = caseNames.map((name) => runCase(name, workspace));
    results.push(runFixPlanCheck(workspace));
    results.push(runFixApplyCheck());
  } finally { rmSync(workspace, { recursive: true, force: true }); }
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.problems.join("; ")}`}`);
    if (!r.ok) failed += 1;
  }
  console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAllFixtures().then((code) => {
    process.exitCode = code;
  });
}
