#!/usr/bin/env node
// wl-produce 接入示例：基于 Gate 0.9.1 模板，显式使用华新 settings 并解除父 POM 跳测。
// Copy to scripts/quality/java-unit.mjs. All paths are relative to the Java repo root.
// The plan is approved configuration. Maven failures never become success.
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const hash = (input) => createHash("sha256").update(input).digest("hex");
const root = process.cwd();
function inside(rel) {
  if (typeof rel !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(rel) || rel.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("计划路径须为无别名的明确仓库内相对路径");
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) throw new Error("计划路径越出仓库");
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) { current = path.join(current, part); let stat; try { stat = lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; } if (stat?.isSymbolicLink()) throw new Error("计划路径不接受符号链接"); }
  return file;
}
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--plan") { process.stderr.write("用法: node scripts/quality/java-unit.mjs --plan quality/java-unit.plan.json\n"); process.exit(2); }
let plan, planText, staleReports = [];
const tracked = new Set();
const listing = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", shell: false });
if (listing.status === 0) for (const file of listing.stdout.split("\0").filter(Boolean)) tracked.add(file);
function output(rel) {
  const file = inside(rel);
  if (tracked.has(rel)) throw new Error("单元报告/日志不能覆盖已跟踪输入");
  if (existsSync(file) && !lstatSync(file).isFile()) throw new Error("单元报告/日志不是普通文件");
  return file;
}
try {
  planText = readFileSync(inside(argv[1]), "utf8"); plan = JSON.parse(planText);
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.modules) || !plan.modules.length || typeof plan.prepareDependencies !== "boolean") throw new Error("单元计划结构无效");
  if (new Set(plan.modules.map((m) => m.path)).size !== plan.modules.length) throw new Error("单元计划模块重复");
  const reports = new Set();
  for (const m of plan.modules) {
    const module = inside(m.path);
    if (!existsSync(inside(`${m.path}/pom.xml`)) || !Array.isArray(m.reportFiles) || !m.reportFiles.length) throw new Error("模块/POM/批准报告缺失");
    for (const rel of m.reportFiles) { const file = output(rel); if (path.dirname(file) !== path.join(module, "target", "surefire-reports") || !/^TEST-.+\.xml$/.test(path.basename(file)) || reports.has(rel)) throw new Error("报告须为模块明确 Surefire XML，不能遗漏/重复"); reports.add(rel); }
    const directory = inside(`${m.path}/target/surefire-reports`);
    if (existsSync(directory)) for (const name of readdirSync(directory)) if (name.endsWith(".xml")) staleReports.push(output(`${m.path}/target/surefire-reports/${name}`));
  }
  if (plan.offline !== undefined && typeof plan.offline !== "boolean") throw new Error("offline 只能为布尔值");
  inside("quality-reports/java-unit");
  for (const name of ["prepare.log", "unit.log", "unit-execution.json"]) output(`quality-reports/java-unit/${name}`);
} catch (error) { process.stderr.write(`[java-unit] ${error.message}\n`); process.exit(2); }

const out = inside("quality-reports/java-unit"); mkdirSync(out, { recursive: true });
const execution = { schemaVersion: 1, eventId: process.env.WL_GATE_EVENT_ID || null, sha: process.env.WL_GATE_COMMIT_SHA || null,
  planHash: hash(planText), modules: plan.modules.map((m) => m.path), startedAt: new Date().toISOString(), phases: [], status: "running", reports: [] };
const command = process.env.WL_MAVEN_COMMAND || (process.platform === "win32" ? "mvn.cmd" : "mvn");
const common = ["-B", "-ntp", "-s", ".mvn/settings-hx.xml", ...(plan.offline ? ["-o"] : []), "-pl", plan.modules.map((m) => m.path).join(",")];
function run(phase, args) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024, shell: false });
  // CI Runner must keep secrets out of commands/project output; logs have restricted artifact access.
  let text = (result.stdout || "") + (result.stderr || "");
  for (const [name, value] of Object.entries(process.env)) if (/TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|WEBHOOK/i.test(name) && value.length >= 4) text = text.split(value).join("[REDACTED]");
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:authorization\s*[:=]\s*(?:bearer\s+)?|(?:token|password|passwd|secret|_authToken)\s*[:=]\s*))[^\s,;]+/gi, "$1[REDACTED]");
  const log = output(`quality-reports/java-unit/${phase}.log`); writeFileSync(log, text);
  execution.phases.push({ phase, exitCode: result.status, durationMs: Date.now() - started, log: path.relative(root, log), error: result.error ? result.error.code || "execution-error" : null });
  if (result.status !== 0 || result.error) throw new Error(`${phase} 失败，检查 ${path.relative(root, log)}`);
}
try {
  // All modules and output paths were preflighted before any removal or Maven call.
  for (const file of staleReports) rmSync(file);
  // Preparation does not count as test evidence. unit does not use -am on empty dependency modules.
  if (plan.prepareDependencies) run("prepare", [...common, "-am", "install", "-Dmaven.test.skip=true"]);
  run("unit", [...common, "-Pwl-quality-unit", "verify", "-Dmaven.test.skip=false", "-DskipTests=false"]);
  const expected = new Set(plan.modules.flatMap((m) => m.reportFiles));
  const actual = new Set();
  for (const m of plan.modules) {
    const dir = inside(`${m.path}/target/surefire-reports`);
    for (const name of readdirSync(dir)) if (name.endsWith(".xml")) {
      const rel = `${m.path}/target/surefire-reports/${name}`;
      const file = inside(rel); if (!lstatSync(file).isFile()) throw new Error("Surefire 报告不是普通文件"); actual.add(rel);
    }
  }
  if (expected.size !== actual.size || [...expected].some((rel) => !actual.has(rel))) throw new Error("实际 Surefire XML 与批准全集不同，拒绝漏测/未登记用例");
  execution.reports = [...actual].sort().map((rel) => ({ file: rel, sha256: hash(readFileSync(inside(rel))) })); execution.status = "completed";
} catch (error) { execution.status = "invalid"; execution.reason = error.message; process.stderr.write(`[java-unit] ${error.message}\n`); process.exitCode = 2; }
finally { execution.completedAt = new Date().toISOString(); writeFileSync(output("quality-reports/java-unit/unit-execution.json"), JSON.stringify(execution, null, 2) + "\n"); }
