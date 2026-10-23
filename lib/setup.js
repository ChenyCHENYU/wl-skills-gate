import path from "node:path";
import {planProjectEnvironment,applyProjectEnvironment,activateProjectEnvironment} from "./project-environment.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { detectProject, planOnboarding, applyOnboarding } from "./onboard.js";
import { safePath } from "./source-state.js";

const CONTINUE = new Set(["native-approval-required", "pom-approval-required", "lock-approval-required"]);
const escape = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = (v) => JSON.stringify(v, null, 2) + "\n";
export function describeSetupPlan(plan) {
  const complete = plan.complete || {};
  return { projectRoot: plan.root, projectKind: plan.projectKind, phase: complete.status || plan.status, planHash: plan.planHash,
    dependencies: plan.dependencyChanges || [],
    files: (plan.files || []).filter((f) => f.action !== "unchanged").map((f) => ({ path: f.path, action: f.action })),
    hooks: plan.hooks,
    installation: complete.installation ? { executable: complete.installation.executable, args: complete.installation.args } : null,
    native: (complete.native || []).map((n) => ({ id: n.id, packageVersion: n.source?.version, preview: n.preview })),
    pom: complete.pom, lock: complete.lock,
    blockers: [...(plan.hardConflicts || []), ...(complete.blockers || [])],
    environment: plan.localEnvironment?.changes || [],
    remoteAcceptanceRequired: complete.remoteAcceptanceRequired || [] };
}
function artifacts(root, id) {
  const relative = `quality-reports/setup/${id}`;
  const directory = safePath(root, relative);
  // Reports must never replace tracked source or follow project-controlled links.
  const tracked = spawnSync("git", ["ls-files", "--", relative], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0 || tracked.stdout.trim()) throw new Error("接入报告目录已被跟踪或无法核验，拒绝覆盖源码");
  if (existsSync(directory)) throw new Error("接入会话输出已存在，拒绝覆盖");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function writeSetupResult(directory, result) {
  const report = path.join(directory, "result.json"), html = path.join(directory, "result.html");
  const value = { ...result, reportFile: report, htmlFile: html };
  writeFileSync(report, json(value), { flag: "wx", mode: 0o600 });
  const rows = (result.steps || []).map((s) => `<tr><td>${escape(s.phase)}</td><td>${escape(s.status)}</td><td>${escape(s.failure || s.receipt || "")}</td></tr>`).join("");
  writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>WL 接入反馈</title><style>body{font:16px/1.65 system-ui;max-width:1000px;margin:40px auto;padding:0 20px;color:#172634}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd5dd;text-align:left;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}a{color:#087a7d}</style><h1>WL · 接入反馈</h1><p>${escape(result.root)}</p><h2>${escape(result.status)}</h2><p>${escape(result.nextAction)}</p><table><thead><tr><th>阶段</th><th>结果</th><th>证据 / 原因</th></tr></thead><tbody>${rows}</tbody></table><p>本地验证：${result.localValidated === true ? "通过" : "未通过 / 未完成"}；远端强制、Review及业务闭环分别验收。</p><pre>${escape(json(value))}</pre>`, { flag: "wx", mode: 0o600 });
  return value;
}
export async function runProjectSetup({ root = ".", registry, kind = "auto", assetRoot, preview = false, allowDependencyUpdates = true,
  onPlan, onEnvironmentMissing, onProgress = () => {}, planner = planOnboarding, applier = applyOnboarding, maxStages = 10 } = {}) {
  if (typeof registry !== "string" || !registry.trim()) throw new Error("请先选择本次批准的HTTPS安装源");
  if (!Number.isInteger(maxStages) || maxStages < 1 || maxStages > 20) throw new Error("接入阶段上限必须在1到20之间");
  const options = { root: path.resolve(root), registry, kind, assetRoot, complete: true, allowDependencyUpdates };
  const result = { schemaVersion: 1, kind: "project-setup-session", sessionId: randomUUID(), root: options.root, steps: [],
    status: "planning", localValidated: false, remoteValidated: false, businessClosureValidated: false };
  let directory;
  const finish = (status, nextAction, extra = {}) => {
    Object.assign(result, extra, { status, nextAction });
    return directory ? writeSetupResult(directory, result) : result;
  };
  const seen = new Set();
  let localEnvironment;
  try {
    if (planner === planOnboarding) {
      const detectedKind = detectProject({root: options.root, kind}).kind;
      let environment = planProjectEnvironment({root: options.root, kind: detectedKind});
      if (environment.blockers.length && typeof onEnvironmentMissing === "function") {
        const selection = await onEnvironmentMissing(environment);
        if (selection) environment = planProjectEnvironment({root: options.root, kind: detectedKind, env: {...process.env,...selection}});
      }
      if (preview && environment.blockers.length) return {...result,status:"blocked",environment,nextAction:"按环境缺项提示选择已安装工具或固定分析器目录，首次确认后保存在本机Git目录；不写源码"};
      if (environment.blockers.length) { result.steps.push({phase:"local-environment",status:"blocked",blockers:environment.blockers}); return finish("blocked","本机运行环境尚缺项；重新打开同一入口，按提示输入工具目录",{environment}); }
      if (!preview && environment.status === "confirmation-required") {
        if (!directory) directory = artifacts(options.root, result.sessionId);
        const planFile = path.join(directory,"environment-plan.json");
        writeFileSync(planFile,json(environment),{flag:"wx",mode:0o600});
        const summary = {phase:"本机环境登记（一次确认；不提交、不授权CI）",projectRoot:options.root,files:[],dependencies:[],native:[],environment:environment.changes,blockers:[]};
        if (typeof onPlan !== "function") return finish("approval-required","确认检测到的本机执行环境后保存；不会下载或重装工具",{environment,planFile});
        if (await onPlan({plan:environment,summary,planFile,stage:0}) !== true) return finish("canceled","本机环境未登记；项目未改动");
        const applied=applyProjectEnvironment({plan:environment,confirm:true});
        result.steps.push({phase:"local-environment",status:applied.status,receipt:applied.file,planFile});
      }
      if (!preview) localEnvironment=activateProjectEnvironment({root:options.root});
    }
    for (let index = 0; index < maxStages; index++) {
      onProgress({ action: "planning", stage: index + 1 });
      const plan = planner(options), summary = describeSetupPlan(plan);
      result.root = plan.root;
      if (preview) return { ...result, status: summary.blockers.length ? "blocked" : "preview", plan, summary,
        nextAction: summary.blockers.length ? "按阻断原因修复环境或配置，再重新启动" : "启动交互接入后查看当前差异并确认；预览不写入" };
      if (!directory) directory = artifacts(plan.root, result.sessionId);
      const planFile = path.join(directory, `plan-${index + 1}.json`);
      writeFileSync(planFile, json(plan), { flag: "wx", mode: 0o600 });
      if (summary.blockers.length || ["configuration-blocked", "complete-preflight-blocked"].includes(plan.status) || plan.complete?.status === "complete-preflight-blocked") {
        result.steps.push({ phase: summary.phase, status: "blocked", blockers: summary.blockers, planFile });
        return finish("blocked", "先处理报告中的环境/配置缺项；修复后重开同一接入入口，不自动重试未知副作用");
      }
      if (seen.has(plan.planHash)) return finish("blocked", "相同计划重复出现，已停止循环；工程维护者核对上轮回执", { failure: "接入阶段没有进展" });
      seen.add(plan.planHash);
      if (typeof onPlan !== "function") return finish("approval-required", "需要交互确认当前计划；不会自动替人批准", { planHash: plan.planHash, planFile });
      const approved = await onPlan({ plan, summary, planFile, stage: index + 1 });
      if (approved !== true) return finish("canceled", "本阶段未应用；已完成阶段保留。需要时重新启动，将重新检查并展示新差异");
      onProgress({ action: "applying", phase: summary.phase, stage: index + 1 });
      const applied = applier({ ...options, planHash: plan.planHash, confirm: true });
      result.steps.push({ phase: summary.phase, status: applied.status, receipt: applied.executionReceipt,
        failure: applied.complete?.failure, planFile });
      if (applied.status === "local-validated-awaiting-remote-acceptance" && applied.complete?.localValidated === true)
        return finish(applied.status, "本地接入已验证。按工作单继续GitLab/Jenkins、独立Review、群通知与业务现场验收", { installationValidated: true, qualityPassed: true, localValidated: true, projectKind: plan.projectKind });
      if (applied.status === "installed-quality-blocked" && applied.complete?.installationValidated === true)
        return finish(applied.status, applied.complete.nextAction, { installationValidated: true, qualityPassed: false, localValidated: false, projectKind: plan.projectKind, qualityReport: applied.complete.reportSha256 });
      if (!CONTINUE.has(applied.status)) return finish("blocked", applied.complete?.nextAction || "查看本轮失败阶段，先修复环境/代码/历史项审批再重新启动", { failure: applied.complete?.failure || applied.status });
      onProgress({ action: "next-approval", phase: applied.status });
    }
    return finish("blocked", "已达阶段上限，请工程维护者核对重复计划与原生规则回执", { failure: "接入未在批准的阶段上限内完成" });
  } catch (error) {
    result.steps.push({ phase: "execution", status: "blocked", failure: error.message });
    return finish("blocked", "保留已完成阶段，按本次错误处理后重新启动；不重置接入记录", { failure: error.message });
  } finally { localEnvironment?.restore(); }
}

export function parseSetupArgs(argv) {
  const args = [...argv], mode = args[0] && !args[0].startsWith("--") ? args.shift() : "project";
  if (!["project", "workspace", "central", "branches", "jenkins", "release-input"].includes(mode)) throw new Error("setup 选择 project/workspace/central/branches/jenkins/release-input");
  const flags = new Set(["--preview", "--json", "--start", "--send", "--watch", "--confirm", "--verify", "--separate-review-signer"]);
  const values = new Set(["--root", "--registry", "--kind", "--asset-root", "--config-dir", "--config", "--out", "--port", "--plan-hash", "--config-hash", "--input-hash"]);
  const parsed = { mode }, seen = new Set();
  while (args.length) {
    const key = args.shift(); if (seen.has(key)) throw new Error(`重复参数 ${key}`); seen.add(key);
    if (flags.has(key)) parsed[key.slice(2)] = true;
    else if (values.has(key)) { const value = args.shift(); if (!value || value.startsWith("--")) throw new Error(`${key} 缺值`); parsed[key.slice(2)] = value; }
    else throw new Error(`未知参数 ${key}`);
  }
  const allowed = {
    project: ["root", "registry", "kind", "asset-root", "preview", "json"],
    workspace: ["root", "preview", "json", "confirm", "plan-hash"],
    central: ["config-dir", "port", "watch", "send", "start", "confirm", "plan-hash", "preview", "json", "separate-review-signer"],
    "release-input": ["config", "confirm", "config-hash", "input-hash", "preview", "json"],
    branches:["config","confirm","plan-hash","preview","json"],
    jenkins:["root","config","out","confirm","plan-hash","preview","json","verify"],
  }[mode];
  for (const key of Object.keys(parsed)) if (key !== "mode" && !allowed.includes(key)) throw new Error(`${mode} 不支持 --${key}`);
  if (parsed.preview && (parsed.confirm || parsed.start)) throw new Error("--preview 不接受执行/确认参数");
  if (parsed["plan-hash"] && !parsed.confirm) throw new Error("--plan-hash 必须与 --confirm 一起提供");
  if ((parsed["config-hash"] || parsed["input-hash"]) && !parsed.confirm) throw new Error("输入摘要只能用于 --confirm");
  if (mode === "central" && parsed.confirm && !parsed.start) throw new Error("中央确认还需要明确 --start");
  if (mode === 'jenkins' && parsed.verify && (parsed.confirm || parsed.config || parsed['plan-hash'] || parsed.preview)) throw new Error('Jenkins接线核验只读；不接受生成/确认参数');
  return parsed;
}
export async function runSetupCli(argv, io = {}) {
  const input = io.input || process.stdin, output = io.output || process.stdout;
  const options = parseSetupArgs(argv), interactive = input.isTTY === true && output.isTTY === true && !options.json;
  let prompt;
  const say = (message) => output.write(message + "\n");
  const ask = async (message) => { prompt ||= createInterface({ input, output }); return prompt.question(message); };
  const confirm = async ({ summary, planFile, stage }) => {
    say(`\n[${stage}] ${summary.phase} · ${summary.projectRoot}`);
    say(`文件变更 ${summary.files.length} 项，依赖变更 ${summary.dependencies.length} 项。完整差异：${planFile}`);
    for (const item of summary.dependencies) say(`  依赖：${item.name} ${item.from || "未安装声明"} → ${item.to}`);
    for (const file of summary.files) say(`  ${file.action}: ${file.path}`);
    for (const item of summary.environment || []) say(`  本机 ${item.name}: ${item.version} · ${item.path}`);
    if (summary.installation) say(`安装：${summary.installation.executable} ${summary.installation.args.join(" ")}`);
    if (summary.pom?.status === "patch-planned") say(`POM差异：${summary.pom.path}（完整before/after见计划）`);
    for (const native of summary.native) say(`原生差异 ${native.id}: ${native.preview?.stdout || native.preview?.stderr || "见完整计划"}`);
    say("1 确认本阶段，2 查看完整计划，Enter 取消。后续新差异将重新请求确认。");
    while (true) {
      const answer = (await ask("请选择 [取消]：")).trim();
      if (answer === "2") { say(readFileSync(planFile, "utf8")); continue; }
      return answer === "1";
    }
  };
  try {
    if (options.mode === "project") {
      const root = options.root || (interactive ? (await ask(`项目Git根目录 [${process.cwd()}]：`)).trim() || process.cwd() : process.cwd());
      const registry = options.registry || (interactive ? (await ask("本次批准的HTTPS安装源 [https://registry.npmjs.org/]：")).trim() || "https://registry.npmjs.org/" : undefined);
      let kind = options.kind || "auto", assetRoot = options["asset-root"];
      let automaticallyDetected;
      if(interactive && !options.kind){try{automaticallyDetected=detectProject({root,kind:"auto"});kind=automaticallyDetected.kind;say(`识别项目：${automaticallyDetected.kind} · ${automaticallyDetected.preset}`);}catch{}}
      if (interactive && !options.kind && !automaticallyDetected) {
        const answer = (await ask("项目范围：Enter 自动识别已接PC/Java；1 明确为PC Vue管理端；2 Java/Maven：")).trim();
        if (!["", "1", "2"].includes(answer)) throw new Error("项目范围请选择自动/1/2；移动端不适用PC配套");
        kind = answer === "1" ? "frontend" : answer === "2" ? "backend" : "auto";
      }
      if (interactive && !assetRoot) {
        const detected = detectProject({ root, kind });
        if (detected.preset === "custom-maven") assetRoot = (await ask("此Maven项目需要负责人批准的模块/必测配套。受控配套父目录（含backend/与automation/）：")).trim();
      }
      const result = await runProjectSetup({ root, registry, kind, assetRoot, preview: options.preview || !interactive,
        onEnvironmentMissing: interactive ? async (environment) => {
          const selection = {};
          for (const item of environment.blockers) { say(item.reason); const value = (await ask(`${item.field} 的已安装绝对路径（JDK填Home；分析器填固定分发目录；Enter取消）：`)).trim(); if (!value) return null; selection[item.field] = value; }
          return selection;
        } : undefined, onPlan: interactive ? confirm : undefined, onProgress: (event) => { if (!options.json) say(`[setup] ${event.action}${event.phase ? " · " + event.phase : ""}`); } });
      if (options.json) say(json(result));
      else { say(`\n结果：${result.status}\n${result.nextAction}`); if (result.failure) say(result.failure); if (result.htmlFile) say(`查看反馈：${result.htmlFile}`); if (result.summary?.blockers?.length) say(json(result.summary.blockers)); }
      return ["blocked", "approval-required"].includes(result.status) ? 2 : 0;
    }
    // Other setup modes are wired to their own fixed executors below.
    const { runAdditionalSetup } = await import("./setup-modes.js");
    return await runAdditionalSetup(options, { interactive, ask, say, confirm, closePrompt: () => { prompt?.close(); prompt = undefined; } });
  } finally { prompt?.close(); }
}
