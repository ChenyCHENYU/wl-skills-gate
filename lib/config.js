import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseYamlLite } from "./yaml-lite.js";
import { sha256 } from "./util.js";
import { validateJavaSourceRoots } from "./java-source-map.js";
import { validateReportSelection } from "./report-selection.js";

export class ConfigError extends Error {}

export const TOOLS = ["raw-json", "cmd-json", "eslint", "typecheck", "junit", "sarif", "java-xml"];
const PROFILES = ["fast", "standard", "release"];
const WAIVER_FIELDS = ["id", "ruleId", "reason", "owner", "approver", "expiresAt"];

function findFile(root, names) {
  for (const n of names) {
    const p = path.join(root, n);
    if (existsSync(p)) return p;
  }
  return null;
}

function loadStructured(file) {
  const content = readFileSync(file, "utf8");
  if (file.endsWith(".json")) return { data: JSON.parse(content), content };
  return { data: parseYamlLite(content), content };
}

function asProfiles(value, where) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (!list.length) throw new ConfigError(`${where}: profiles 不能为空`);
  for (const p of list) {
    if (!PROFILES.includes(p)) throw new ConfigError(`${where}: 未知 profile ${p}（合法值 ${PROFILES.join("/")}）`);
  }
  return list;
}

export function loadConfig(root, opts = {}) {
  const policyFile = opts.policyFile || findFile(root, ["quality/policy.yml", "quality/policy.yaml", "quality/policy.json"]);
  if (!policyFile) {
    throw new ConfigError("policy 不存在：缺少 quality/policy.yml（或 .yaml/.json）。失败关闭，不等同于无问题");
  }
  let policyRaw;
  try {
    policyRaw = loadStructured(policyFile);
  } catch (e) {
    throw new ConfigError(`policy 无法解析（${policyFile}）: ${e.message}`);
  }
  const policy = policyRaw.data;
  if (Number(policy.schemaVersion) !== 1) throw new ConfigError("policy.schemaVersion 必须为 1");
  if (typeof policy.project !== "string" || !policy.project.trim()) throw new ConfigError("policy.project 必填（用于稳定指纹与报告归属）");
  if (!Array.isArray(policy.checks) || !policy.checks.length) throw new ConfigError("policy.checks 必须是非空数组");
  const seen = new Set();
  const producers = new Map();
  for (const c of policy.checks) {
    if (!c || typeof c !== "object") throw new ConfigError("policy.checks 项必须是映射");
    if (typeof c.id !== "string" || !c.id.trim()) throw new ConfigError("policy.checks 项缺少字符串 id");
    if (seen.has(c.id)) throw new ConfigError(`检查 id 重复: ${c.id}`);
    seen.add(c.id);
    if (!c.tool) throw new ConfigError(`检查 ${c.id} 缺少 tool`);
    if (!TOOLS.includes(c.tool)) throw new ConfigError(`检查 ${c.id} 使用未注册工具 ${c.tool}（已注册: ${TOOLS.join("/")}）`);
    c.profiles = asProfiles(c.profiles, `检查 ${c.id}`);
    if (c.format !== undefined && !(
      (c.tool === "cmd-json" && ["wl-kit", "wl-ui", "wl-bd"].includes(c.format)) ||
      (c.tool === "java-xml" && ["checkstyle", "pmd", "p3c", "spotbugs"].includes(c.format)))) {
      throw new ConfigError(`检查 ${c.id}: format 不受支持`);
    }
    if (c.tool === "java-xml" && (!c.format || !c.file)) throw new ConfigError(`检查 ${c.id}: java-xml 必须声明 format/file`);
    if (c.sourceRoots !== undefined) {
      if (c.tool !== "java-xml") throw new ConfigError(`检查 ${c.id}: sourceRoots 仅允许 java-xml`);
      try { validateJavaSourceRoots(root, c.sourceRoots); }
      catch (e) { throw new ConfigError(`检查 ${c.id}: ${e.message}`); }
    }
    if (c.producer !== undefined) {
      if (!["java-xml", "junit"].includes(c.tool) || typeof c.producer !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(c.producer) || !c.command) throw new ConfigError(`检查 ${c.id}: producer 仅用于有 command 的 java-xml/JUnit，编号须为 1～64 位字母/数字/_/-`);
      const signature = JSON.stringify([c.command, Number(c.timeoutMs) || 600000, c.tool]);
      if (producers.has(c.producer) && producers.get(c.producer) !== signature) throw new ConfigError(`共享生产者 ${c.producer} 的 command/timeoutMs/tool 不一致`);
      producers.set(c.producer, signature);
    }
    if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0)) throw new ConfigError(`检查 ${c.id}: timeoutMs 必须为正整数毫秒`);
    if (c.captureStdout !== undefined && (typeof c.captureStdout !== "boolean" || c.tool !== "cmd-json" || !c.file)) {
      throw new ConfigError(`检查 ${c.id}: captureStdout 仅用于声明 file 的 cmd-json 检查`);
    }
    for (const key of ["command", "file", "bin", "versionCommand", "args"]) {
      if (c[key] !== undefined && (typeof c[key] !== "string" || !c[key].trim())) throw new ConfigError(`检查 ${c.id}: ${key} 必须为非空字符串`);
    }
    if (c.tool === "eslint" && /(?:^|[\s"'])--fix(?:-dry-run)?(?:[\s"'=]|$)/.test(c.args || "")) {
      throw new ConfigError(`检查 ${c.id}: args 不得包含 --fix/--fix-dry-run；检查与修复须分离`);
    }
    if (c.targets !== undefined && (c.tool !== "eslint" || !Array.isArray(c.targets) || !c.targets.length ||
      new Set(c.targets).size !== c.targets.length || c.targets.some((p) => typeof p !== "string" || !p.trim() || p.startsWith("-") || path.isAbsolute(p) || p.split(/[\\/]/).includes("..")))) {
      throw new ConfigError(`检查 ${c.id}: targets 必须是非空、无重复的 ESLint 项目内相对路径/glob 数组`);
    }
    if (c.required !== undefined && typeof c.required !== "boolean") throw new ConfigError(`检查 ${c.id}: required 必须是布尔值`);
    if (["typecheck", "junit"].includes(c.tool) && c.required === false) throw new ConfigError(`检查 ${c.id}: 类型/测试检查不得降级为可选`);
    if (c.required === false && (!c.naReason || !String(c.naReason).trim())) {
      throw new ConfigError(`检查 ${c.id}: required=false 必须登记 naReason（不适用原因，正文 3.6），缺失即 invalid`);
    }
    try { validateReportSelection(c, root); }
    catch (e) { throw new ConfigError(`检查 ${c.id}: ${e.message}`); }
  }
  if (policy.blockerWaivers !== undefined && policy.blockerWaivers !== "reject") {
    throw new ConfigError("policy.blockerWaivers 只允许 reject，质量底线不允许豁免");
  }
  if (policy.commitTypes !== undefined) {
    if (!Array.isArray(policy.commitTypes) || !policy.commitTypes.length || policy.commitTypes.some((t) => !t || typeof t !== "string")) {
      throw new ConfigError("policy.commitTypes 必须是非空字符串数组（与项目登记表一致，正文十四章）");
    }
  }
  if (policy.releaseRequires !== undefined) {
    if (!Array.isArray(policy.releaseRequires) || !policy.releaseRequires.length) {
      throw new ConfigError("policy.releaseRequires 必须是非空检查 id 数组");
    }
    for (const id of policy.releaseRequires) {
      if (!seen.has(id)) throw new ConfigError(`releaseRequires 引用未声明的检查: ${id}`);
    }
  }
  policy.enforceWarnings = policy.enforceWarnings === true || policy.enforceWarnings === "true";
  if (policy.fixers !== undefined) {
    if (!Array.isArray(policy.fixers)) throw new ConfigError("policy.fixers 必须为数组（复杂配置使用 JSON）");
    const ids = new Set();
    for (const f of policy.fixers) {
      if (typeof f?.id !== "string" || !f.id.trim() || ids.has(f.id) || typeof f.command !== "string" || !f.command.trim() ||
        !Array.isArray(f.ruleIds) || !f.ruleIds.length || f.ruleIds.some((r) => typeof r !== "string" || !r.trim()) ||
        !Array.isArray(f.files) || !f.files.length || f.files.some((p) => typeof p !== "string" || !p.trim())) throw new ConfigError("修复白名单缺 id/command/ruleIds/files 或 id 重复");
      ids.add(f.id);
    }
  }

  const waiversFile = findFile(root, ["quality/waivers.yml", "quality/waivers.yaml", "quality/waivers.json"]);
  let waiverRecords = [];
  let waiversHash = sha256("absent");
  const invalidWaivers = [];
  if (waiversFile) {
    waiversHash = sha256(readFileSync(waiversFile, "utf8"));
    let data;
    try {
      data = loadStructured(waiversFile).data;
    } catch (e) {
      throw new ConfigError(`waivers 无法解析（${waiversFile}）: ${e.message}`);
    }
    if (!Array.isArray(data)) throw new ConfigError("waivers 必须为数组，不能静默当空列表");
    waiverRecords = data;
    const invalidIndexes = new Set();
    waiverRecords.forEach((w, index) => {
      w = w && typeof w === "object" ? w : {};
      const missing = WAIVER_FIELDS.filter((f) => typeof w[f] !== "string" || !w[f].trim());
      const badDate = w.expiresAt && Number.isNaN(Date.parse(w.expiresAt));
      const selfApproved = w.owner && w.owner === w.approver;
      if (missing.length || badDate || selfApproved) {
        invalidIndexes.add(index);
        invalidWaivers.push({
          record: w.id || `#${index + 1}`,
          reason: selfApproved ? "owner 与 approver 不能相同" : badDate ? `expiresAt 无法解析: ${w.expiresAt}` : `缺少必填字段 ${missing.join(",")}`,
        });
      }
    });
    waiverRecords = waiverRecords.filter((_, index) => !invalidIndexes.has(index));
  }

  const baselineFile = findFile(root, ["quality/baseline.json"]);
  let baselineItems = [];
  let baselineMeta = { generatedAt: null, ruleSetVersion: null, fileDigest: null };
  if (baselineFile) {
    const content = readFileSync(baselineFile, "utf8");
    let data;
    try {
      data = JSON.parse(content);
    } catch (e) {
      throw new ConfigError(`baseline 无法解析（${baselineFile}）: ${e.message}`);
    }
    if (!Array.isArray(data.items)) throw new ConfigError("baseline.json 必须包含 items 数组");
    baselineMeta = {
      generatedAt: data.generatedAt || null,
      ruleSetVersion: data.ruleSetVersion || null,
      fileDigest: sha256(content),
    };
    const baselineFingerprints = new Set();
    for (const it of data.items) {
      if (!it || !it.fingerprint) throw new ConfigError("baseline 项缺少 fingerprint：禁止无指纹基线（失败关闭）");
      if (!["error", "warning"].includes(it.severity) || !Number.isInteger(it.occurrenceCount) || it.occurrenceCount < 1) throw new ConfigError("baseline 项必须声明 severity(error/warning) 和 occurrenceCount，避免风险升级或扩张被掩盖");
      if (!/^[a-f0-9]{64}$/.test(it.fingerprint) || baselineFingerprints.has(it.fingerprint)) throw new ConfigError("baseline 指纹非法或重复");
      baselineFingerprints.add(it.fingerprint);
      baselineItems.push(it);
    }
  }

  const rulesFile = findFile(root, ["quality/rules.lock.json"]);
  let ruleSet = null;
  let ruleSetHash = null;
  let rulesContent = "";
  if (rulesFile) {
    rulesContent = readFileSync(rulesFile, "utf8");
    try {
      ruleSet = JSON.parse(rulesContent);
    } catch (e) {
      throw new ConfigError(`rules.lock.json 无法解析: ${e.message}`);
    }
    ruleSetHash = sha256(rulesContent);
  }

  return {
    root,
    policyFile,
    policy,
    policyHash: sha256(policyRaw.content),
    ruleSet,
    ruleSetHash,
    waivers: waiverRecords,
    invalidWaivers,
    waiversHash,
    baselineHash: baselineMeta.fileDigest || sha256("absent"),
    baselineItems,
    baselineMeta,
    baselineFile,
  };
}
