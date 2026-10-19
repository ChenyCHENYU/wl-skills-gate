import path from "node:path";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { loadConfig } from "./config.js";
import { actualSha, safePath } from "./source-state.js";
import { parseXml } from "./xml.js";
import {javaDistributionHome} from "./java-distribution.js";

function nodeRangeSatisfied(range) {
  if (typeof range !== "string" || !range.trim()) return false;
  const current = process.versions.node.split(".").map(Number);
  const compare = (version) => { for (let i = 0; i < 3; i++) { const diff = current[i] - (version[i] || 0); if (diff) return Math.sign(diff); } return 0; };
  return range.split("||").some((alternative) => {
    const parts = alternative.trim().split(/\s+/);
    return parts.length > 0 && parts.every((part) => {
      if (["*", "x"].includes(part)) return true;
      const match = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.(?:\d+|x|\*)){0,2})$/.exec(part);
      if (!match) return false;
      const operator = match[1]; const strings = match[2].split("."); const version = strings.map((v) => /^\d+$/.test(v) ? Number(v) : 0);
      const c = compare(version);
      const explicit = strings.findIndex((v) => ["x", "*"].includes(v)); const precision = explicit < 0 ? strings.length : explicit;
      const partialUpper = precision === 1 ? [version[0] + 1, 0, 0] : precision === 2 ? [version[0], (version[1] || 0) + 1, 0] : null;
      if (operator === ">=") return c >= 0; if (operator === "<=") return partialUpper ? compare(partialUpper) < 0 : c <= 0;
      if (operator === ">") return partialUpper ? compare(partialUpper) >= 0 : c > 0; if (operator === "<") return c < 0;
      if (operator === "^" || operator === "~") {
        const upper = operator === "~" ? precision === 1 ? [version[0] + 1, 0, 0] : [version[0], (version[1] || 0) + 1, 0] : version[0] > 0 ? [version[0] + 1, 0, 0] : (version[1] || 0) > 0 ? [0, version[1] + 1, 0] : [0, 0, (version[2] || 0) + 1];
        return c >= 0 && compare(upper) < 0;
      }
      return strings.every((v, i) => ["x", "*"].includes(v) || current[i] === Number(v));
    });
  });
}

// Readiness only: never installs assets or runs project commands/builds/tests.
export function doctor({ root = ".", kind }) {
  root = path.resolve(root);
  if (!["frontend", "backend"].includes(kind)) throw new Error("doctor --kind 必须为 frontend/backend");
  if (!lstatSync(root).isDirectory()) throw new Error("项目根不是目录");
  const checks = [];
  const add = (id, ok, message, evidence = null) => checks.push({ id, status: ok ? "passed" : "gap", message, evidence });
  const read = (file) => JSON.parse(readFileSync(safePath(root, file), "utf8"));
  const has = (file) => existsSync(safePath(root, file));
  add("NODE", Number(process.versions.node.split(".")[0]) >= 22, "组合检查使用 Node ≥22，并满足业务项目 engines", process.version);
  add("GIT", actualSha(root) !== "unknown", "必须绑定真实 Git HEAD", actualSha(root));
  const dependencyRoot = kind === "frontend" ? "" : "quality-tools/";
  const packageFile = `${dependencyRoot}package.json`;
  let pkg;
  try { pkg = read(packageFile); add("TOOL-MANIFEST", true, "工具依赖清单可解析", packageFile); }
  catch (error) { add("TOOL-MANIFEST", false, error.message, packageFile); }
  if (pkg?.engines?.node !== undefined) add("PROJECT-NODE-ENGINES", nodeRangeSatisfied(pkg.engines.node),
    "核验声明的 Node 支持范围；无法识别的复杂范围也须先核验", { range: pkg.engines.node, actual: process.versions.node });
  const required = kind === "frontend" ? ["gate", "kit", "ui"] : ["gate", "bd"];
  for (const key of required) {
    const name = `@agile-team/wl-skills-${key}`;
    const declared = pkg?.devDependencies?.[name] || pkg?.dependencies?.[name];
    add(`PIN-${key.toUpperCase()}`, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(declared || ""), `${name} 使用明确固定版本`, declared || null);
    const installed = path.join(root, dependencyRoot, "node_modules", name, "package.json");
    try {
      const value = JSON.parse(readFileSync(installed, "utf8"));
      add(`INSTALLED-${key.toUpperCase()}`, value.name === name && value.version === declared, "执行器安装版本与批准声明一致", { declared, installed: value.version });
      if (value.engines?.node !== undefined) add(`ENGINES-${key.toUpperCase()}`, nodeRangeSatisfied(value.engines.node), "核验已安装工具的 Node 支持范围", { range: value.engines.node, actual: process.versions.node });
    } catch { add(`INSTALLED-${key.toUpperCase()}`, false, "执行器未安装或不可读取", null); }
  }
  const lock = kind === "frontend" ? "pnpm-lock.yaml" : "quality-tools/package-lock.json";
  add("DEPENDENCY-LOCK", has(lock), "存在工具/项目依赖锁；安装须 frozen/ci", lock);
  const asset = kind === "frontend" ? ".wl-skills/copilot-instructions-full.md" : ".wl-skills-bd/capabilities.json";
  add("ASSETS", has(asset), "原生安装资产存在；完整性仍需对应包 check/validate", asset);
  try {
    const config = loadConfig(root);
    add("POLICY", true, "策略可解析且路径/检查声明合法", { policyHash: config.policyHash, rulesHash: config.ruleSetHash });
    if(config.policy.checks.some(check=>check.tool==="java-scan")) {
      const directory=javaDistributionHome(),archive=process.env.WL_JAVA_SCAN_ARCHIVE;
      add("JAVA-REFERENCE-DISTRIBUTION",existsSync(directory) || !!archive && existsSync(archive),
        "完整Java工具需固定镜像目录或离线ZIP；首次Gate自动解包并核验全部文件，doctor只检查输入存在性，不冒充已验证",
        {directory,archiveConfigured:!!archive});
    }
    add("RULES-LOCK", !!config.ruleSet && config.ruleSet["wl-skills-gate"] === (pkg?.devDependencies?.["@agile-team/wl-skills-gate"] || pkg?.dependencies?.["@agile-team/wl-skills-gate"]), "Gate 规则锁版本与声明一致", config.ruleSet?.["wl-skills-gate"] || null);
    const standard = config.policy.checks.filter((c) => c.profiles.includes("standard") && c.required !== false);
    const release = config.policy.checks.filter((c) => c.profiles.includes("release") && c.required !== false);
    add("STANDARD", standard.length > 0, "标准档至少包含一个必需检查", standard.map((c) => c.id));
    add("RELEASE", release.length > 0 && Array.isArray(config.policy.releaseRequires) && config.policy.releaseRequires.length > 0 &&
      config.policy.releaseRequires.every((id) => release.some((c) => c.id === id)),
      "发布最低检查集非空；不代表维度全部批准", config.policy.releaseRequires || null);
    add("TOOL-VERSION-LOCK", [...new Set([...standard, ...release])].every((c) => (c.versionCommand || ["java-scan", "frontend", "node-tests", "project-script"].includes(c.tool)) && typeof config.ruleSet?.tools?.[c.id] === "string" && config.ruleSet.tools[c.id].trim()),
      "必需检查有实际版本命令和对应锁；doctor 不执行版本命令", null);
    add("CHECK-READONLY", config.policy.checks.every((c) => !/(?:^|\s)(?:--fix(?:-dry-run)?(?:\s|$)|--write(?:\s|$)|spotless:apply(?:\s|$))/.test(`${c.args || ""} ${c.command || ""}`)),
      "未发现常见源码修复参数；这不是任意脚本无副作用证明", null);
  } catch (error) { add("POLICY", false, error.message, null); }
  if (kind === "frontend") {
    add("PACKAGE-MANAGER", /^pnpm@\d+\.\d+\.\d+$/.test(pkg?.packageManager || ""), "固定业务 pnpm 版本", pkg?.packageManager || null);
    add("TYPESCRIPT", !!(pkg?.devDependencies?.["vue-tsc"] || pkg?.dependencies?.["vue-tsc"]), "Vue 类型检查器存在声明", null);
  } else {
    add("POM", has("pom.xml"), "Java 项目根有 POM", null);
    const profiles = new Set();
    const visited = new Set();
    const visit = (relative) => {
      const file = safePath(root, relative); if (visited.has(file)) return; visited.add(file);
      const project = parseXml(readFileSync(file, "utf8")); if (project.name !== "project") throw new Error(`POM 根元素无效: ${relative}`);
      for (const container of project.children.filter((n) => n.name === "profiles")) for (const profile of container.children.filter((n) => n.name === "profile")) {
        const ids = profile.children.filter((n) => n.name === "id");
        if (ids.length !== 1 || ids[0].children.length) throw new Error(`POM profile 身份非法: ${relative}`);
        const name = ids[0].text.trim(); if (/^wl-quality(?:-audit|-unit)?$/.test(name)) profiles.add(name);
      }
      for (const container of project.children.filter((n) => n.name === "modules")) for (const module of container.children) {
        if (module.name !== "module" || module.children.length || !module.text.trim() || module.text.includes("${")) throw new Error(`POM reactor 范围无法静态定位: ${relative}`);
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(relative), module.text.trim(), "pom.xml"));
        visit(next);
      }
    };
    try { visit("pom.xml"); add("POM-PROFILES", true, "已解析实际 reactor 的 POM；有效 profile/继承仍需 Maven 核验", [...visited].map((p) => path.relative(root, p))); }
    catch (error) { add("POM-PROFILES", false, error.message, null); }
    add("JAVA-AUDIT", profiles.has("wl-quality-audit"), "POM 声明 audit profile；插件继承与实际编译仍需 Maven 验证", [...profiles]);
    add("JAVA-UNIT", profiles.has("wl-quality-unit"), "POM 声明 unit profile；必测/覆盖仍需真实报告", [...profiles]);
  }
  return { schemaVersion: 1, kind: "project-readiness", projectKind: kind, root, checkedAt: new Date().toISOString(),
    status: checks.every((c) => c.status === "passed") ? "ready-for-local-validation" : "gaps", checks,
    commandsExecuted: false, platformValidated: false, businessBehaviorValidated: false };
}
