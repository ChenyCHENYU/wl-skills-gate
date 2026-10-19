#!/usr/bin/env node
// 只配置本地文件。安装、POM、CI、权限和通知接线均由各自负责人另行验收。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  chmodSync,
  openSync,
  closeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { knownLegacy, migrateFrontendHook, migrateLintStaged, fixedLocalBdCommitHook } from "./onboard-legacy.js";
import { onboardingEnvironment } from "./onboard-environment.js";
import { parseYamlLite } from "./yaml-lite.js";
import { loadConfig } from "./config.js";
import { validateReviewPolicy } from "./review.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_GATE = path.resolve(HERE, "..");
const EXAMPLES = path.join(SHARED_GATE, "templates/onboarding");
const OWNER = "技术经理";
const BEGIN = "# wl-quality-onboarding:begin v1";
const END = "# wl-quality-onboarding:end";
const VERSIONS = {
  gate: JSON.parse(readFileSync(path.join(SHARED_GATE, "package.json"))).version,
  kit: "2.33.1",
  ui: "1.22.1",
};
const LEGACY_CONFIRM_INPUT = {
  id: "wl-quality-confirm-repair",
  type: "pickString",
  description: "先运行预览任务并查看终端中的实际 planHash、允许修改文件、脚本项及人工项；确认仅应用该已预览计划。",
  options: ["取消", "确认已预览的机械修复"],
  default: "取消",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );

function git(root, args, optional = false) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    throw new Error(`Git 项目核验失败：${args.join(" ")}`);
  }
}

function safeTarget(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`目标必须是项目内相对路径：${relative}`);
  const absolute = path.resolve(root, relative);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`目标越出项目：${relative}`);
  const parts = path.relative(root, absolute).split(path.sep);
  if (parts[0] === ".git") throw new Error("不修改 Git 元数据");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`目标含符号链接：${path.relative(root, current)}`);
    if (i < parts.length - 1 && !stat.isDirectory())
      throw new Error(`目标父路径不是目录：${path.relative(root, current)}`);
    if (i === parts.length - 1 && !stat.isFile()) throw new Error(`目标不是普通文件：${relative}`);
  }
  return absolute;
}

function rootPath(value) {
  const supplied = path.resolve(value);
  if (!existsSync(supplied) || !lstatSync(supplied).isDirectory() || lstatSync(supplied).isSymbolicLink())
    throw new Error("项目根必须是存在的真实目录，不能是符号链接");
  const root = realpathSync(supplied);
  const gitRoot = realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
  if (root !== gitRoot) throw new Error("--root 必须是实际业务 Git 仓库根，不能指向工作区或子目录");
  return root;
}

function hookText(previous, action) {
  const newline = previous.includes("\r\n") ? "\r\n" : "\n";
  if (previous.startsWith("#!")) {
    const interpreterLine = previous.slice(2).split(/\r?\n/, 1)[0].trim().split(/\s+/);
    const program = path.basename(interpreterLine.shift() || "");
    const interpreter =
      program === "env" ? (interpreterLine[0] === "-S" ? interpreterLine[1] : interpreterLine[0]) : program;
    if (!["sh", "bash", "dash", "zsh", "ksh"].includes(interpreter))
      throw new Error("既有 Hook 不是受支持的 shell 解释器；技术经理先适配 dispatcher，不能注入 shell 代码");
  }
  const lines = [
    BEGIN,
    "if ! command -v node >/dev/null 2>&1; then",
    '  echo "[quality] Node 不可用；请技术经理完成固定执行环境接入。" >&2',
    "  exit 2",
    "fi",
    'wl_quality_onboarding_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 2',
    `if node "$wl_quality_onboarding_root/scripts/quality/project-actions.mjs" ${action} "$@"; then`,
    "  :",
    "else",
    "  wl_quality_onboarding_code=$?",
    '  exit "$wl_quality_onboarding_code"',
    "fi",
    END,
  ];
  const block = lines.join(newline) + newline;
  const begins = previous.split(BEGIN).length - 1;
  const ends = previous.split(END).length - 1;
  if (begins !== ends || begins > 1) throw new Error("既有 Hook 托管标记损坏或重复");
  let body = previous;
  if (begins === 1) {
    const start = body.indexOf(BEGIN);
    const end = body.indexOf(END, start);
    if (end < start) throw new Error("既有 Hook 托管标记顺序错误");
    const suffixStart = end + END.length;
    const skip = body.slice(suffixStart).startsWith("\r\n") ? 2 : body.slice(suffixStart).startsWith("\n") ? 1 : 0;
    body = body.slice(0, start) + body.slice(suffixStart + skip);
  }
  if (!body) body = `#!/usr/bin/env sh${newline}`;
  if (body.startsWith("#!")) {
    const firstNewline = body.indexOf("\n");
    if (firstNewline < 0) return body + newline + block;
    return body.slice(0, firstNewline + 1) + block + body.slice(firstNewline + 1);
  }
  return block + body;
}

function mergeEntries(original, desired, key, label) {
  if (!Array.isArray(original) || !Array.isArray(desired)) throw new Error(`${label} 必须是数组`);
  const seen = new Set();
  for (const item of original) {
    if (!item || typeof item !== "object") throw new Error(`${label} 含非法项`);
    const id = item[key];
    if (id && seen.has(id)) throw new Error(`${label} 含重复 ${key}：${id}`);
    if (id) seen.add(id);
  }
  const merged = [...original];
  const desiredIds = new Set();
  for (const item of desired) {
    const id = item?.[key];
    if (typeof id !== "string" || !id.startsWith("wl-quality") || desiredIds.has(id))
      throw new Error(`${label} 配套 ${key} 必须是唯一的 wl-quality 托管入口`);
    desiredIds.add(id);
    const previous = original.find((entry) => entry[key] === id);
    if (previous && stable(previous) !== stable(item)) throw new Error(`${label} 同名入口冲突：${id}`);
    if (!previous) merged.push(item);
  }
  return merged;
}

export function planConfiguration({
  kind,
  root: requestedRoot,
  allowDependencyUpdates = false,
  gateTemplateRoot,
  assetRoot = EXAMPLES,
  sharedGateRoot = SHARED_GATE,
  activateHooks = false,
  projectName,
  migrateLegacyHooks = false,
  workspaceRegistry,
}) {
  if (!["frontend", "backend"].includes(kind)) throw new Error("--kind 必须是 frontend 或 backend");
  const root = rootPath(requestedRoot);
  const files = [];
  const sources = [];
  const hardConflicts = [];
  const gaps = [];
  const dependencyChanges = [];
  const legacyMigrations = [];
  const addGap = (id, reason, nextOwner = OWNER) => gaps.push({ id, reason, nextOwner });
  const conflict = (target, reason) => {
    hardConflicts.push({ target, reason, nextOwner: OWNER });
    addGap("CONFIGURATION-CONFLICT", `${target}：${reason}`);
  };
  const readTarget = (relative) => {
    const absolute = safeTarget(root, relative);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
  const readSource = (file, origin) => {
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`缺配套资产：${file}`);
    const content = readFileSync(file, "utf8");
    sources.push({ path: file, origin, sha256: hash(content) });
    return content;
  };
  const headBytes = (relative) => {
    safeTarget(root, relative);
    try {
      return execFileSync("git", ["-C", root, "show", `HEAD:${relative}`], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return null;
    }
  };
  const committedText = (relative) => {
    const actual = readTarget(relative),
      approved = headBytes(relative);
    if (actual === null || approved === null || hash(actual) !== hash(approved))
      throw new Error(`${relative} 必须与已提交批准原件一致；升级不批准临时替换的策略或受管脚本`);
    return actual;
  };
  let adoption = null;
  try {
    const bytes = headBytes("quality/workspace.json");
    if (bytes !== null) {
      const manifest = JSON.parse(bytes);
      if (
        manifest.schemaVersion !== 1 ||
        manifest.kind !== "wl-quality-workspace" ||
        manifest.projectKind !== kind ||
        manifest.dependencyDirectory !== (kind === "backend" ? "quality-tools" : ".") ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.gateVersion || "")
      )
        throw new Error("已提交接入清单身份无效或与当前项目范围不同");
      adoption = { manifest, sha256: hash(bytes) };
    }
  } catch (error) {
    conflict("quality/workspace.json", error.message);
  }
  const propose = (relative, afterContent, mode, strict = false) => {
    const beforeContent = readTarget(relative);
    if (strict && beforeContent !== null && beforeContent !== afterContent)
      throw new Error("同名文件与批准配套内容不同，请先评审合并，不自动覆盖");
    const beforeMode = beforeContent === null ? null : lstatSync(safeTarget(root, relative)).mode & 0o777;
    const afterMode = mode ?? beforeMode ?? 0o644;
    const action =
      beforeContent === null
        ? "create"
        : beforeContent === afterContent && beforeMode === afterMode
          ? "unchanged"
          : "update";
    files.push({
      path: relative,
      action,
      beforeHash: beforeContent === null ? null : hash(beforeContent),
      afterHash: hash(afterContent),
      beforeMode,
      afterMode,
      afterContent,
    });
  };
  const step = (target, callback) => {
    try {
      callback();
    } catch (error) {
      conflict(target, error.message);
    }
  };
  const fromExample = (relative) => readSource(path.join(assetRoot, relative), "生产项目受控配套");
  const managedFiles = [];
  const proposeManaged = (relative, content) => {
    const previous = readTarget(relative);
    if (previous !== null && previous !== content) {
      if (!allowDependencyUpdates || !adoption)
        throw new Error("受管脚本升级需已提交接入清单及明确允许依赖/受管资产升级；不覆盖自有脚本");
      committedText(relative);
      const approved = adoption.manifest.managedFiles?.find((entry) => entry?.path === relative)?.sha256;
      const catalog = JSON.parse(
        readSource(path.join(EXAMPLES, "legacy/managed-assets.json"), "固定历史 Gate 受管资产摘要")
      );
      const historical = catalog.releases
        ?.filter((release) => release.gateVersion === adoption.manifest.gateVersion)
        .flatMap((release) => release.files || [])
        .find((entry) => [relative, `${kind}:${relative}`].includes(entry.path));
      const registeredMatches = /^[a-f0-9]{64}$/.test(approved || "") && approved === hash(previous);
      const historicalMatches = approved === undefined && historical?.sha256 === hash(previous);
      if (!registeredMatches && !historicalMatches)
        throw new Error("既有脚本字节不在已登记或固定历史版本受管摘要中；请评审自定义差异，不自动覆盖");
      legacyMigrations.push({
        target: relative,
        kind: "approved-managed-script-upgrade",
        fromGateVersion: adoption.manifest.gateVersion,
        beforeHash: hash(previous),
        afterHash: hash(content),
        approval: "explicit-dependency-and-managed-assets-update",
      });
    }
    propose(relative, content);
    managedFiles.push({ path: relative, sha256: hash(content) });
  };
  let gateTemplateSource = null;
  const templates = () => {
    if (gateTemplateSource) return gateTemplateSource;
    const verify = (directory) => {
      const actual = realpathSync(directory);
      const manifestPath = path.join(actual, "package.json");
      const schemaPath = path.join(actual, "schemas/quality-summary.schema.json");
      const regular = (file) => {
        if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error("缺少普通模板/契约文件：" + file);
        if (!realpathSync(file).startsWith(actual + path.sep)) throw new Error("模板/契约文件越出固定包目录：" + file);
      };
      regular(manifestPath);
      regular(schemaPath);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      if (manifest.name !== "@agile-team/wl-skills-gate" || manifest.version !== VERSIONS.gate)
        throw new Error("Gate 模板包名/版本不匹配，需要 @agile-team/wl-skills-gate@" + VERSIONS.gate);
      if (
        schema.type !== "object" ||
        !Array.isArray(schema.required) ||
        schema.properties?.schemaVersion?.const !== 1 ||
        !["schemaVersion", "run", "checks", "findings", "decision"].every((field) => schema.required?.includes(field))
      )
        throw new Error("Gate 报告 schema 不符合本配套契约");
      for (const relative of ["templates/scripts-quality/run.mjs", "templates/quality/generated.gitignore"])
        regular(path.join(actual, relative));
      return { root: actual, name: manifest.name, version: manifest.version, reportSchemaVersion: 1 };
    };
    const installed = path.join(
      root,
      kind === "frontend" ? "node_modules" : "quality-tools/node_modules",
      "@agile-team/wl-skills-gate"
    );
    let source;
    if (existsSync(installed)) {
      try {
        const actual = realpathSync(installed);
        if (!actual.startsWith(root + path.sep)) throw new Error("安装包实际路径在项目外");
        source = { ...verify(actual), origin: "项目已安装的固定 Gate 模板" };
      } catch (error) {
        addGap(
          "INSTALLED-GATE-TEMPLATES-INVALID",
          "安装包模板未核验：" + error.message + "；需技术经理修复安装，本次按明确来源准备配置"
        );
      }
    }
    if (!source && gateTemplateRoot)
      source = {
        ...verify(path.resolve(gateTemplateRoot)),
        origin: "技术经理显式指定的固定 Gate 模板目录",
      };
    if (!source) {
      try {
        source = { ...verify(sharedGateRoot), origin: "明确工作区 Gate 源模板（未安装不记成功）" };
      } catch (error) {
        throw new Error("无可核验的 Gate 模板来源；请指定 --gate-template-root <固定包/产物目录>。" + error.message);
      }
    }
    readSource(path.join(source.root, "package.json"), source.origin);
    readSource(path.join(source.root, "schemas/quality-summary.schema.json"), source.origin);
    gateTemplateSource = source;
    return source;
  };

  const dependencies =
    kind === "frontend"
      ? Object.fromEntries(
          Object.entries(VERSIONS).map(([name, version]) => [`@agile-team/wl-skills-${name}`, version])
        )
      : {
          ...JSON.parse(fromExample("backend/quality-tools.package.json")).devDependencies,
          "@agile-team/wl-skills-gate": VERSIONS.gate,
        };
  const packageTarget = kind === "frontend" ? "package.json" : "quality-tools/package.json";
  step(packageTarget, () => {
    const previous = readTarget(packageTarget);
    if (kind === "frontend" && previous === null) throw new Error("前端根目录缺 package.json，不能确定项目接入范围");
    const pkg =
      previous === null ? JSON.parse(fromExample("backend/quality-tools.package.json")) : JSON.parse(previous);
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("package.json 必须是对象");
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "scripts"])
      if (pkg[field] !== undefined && (!pkg[field] || typeof pkg[field] !== "object" || Array.isArray(pkg[field])))
        throw new Error(`package.json ${field} 必须是对象`);
    if (kind === "frontend") {
      const declaredPackages = Object.assign(
        {},
        pkg.dependencies,
        pkg.devDependencies,
        pkg.optionalDependencies,
        pkg.peerDependencies
      );
      const unsupported = Object.keys(declaredPackages).filter((name) =>
        /^(?:@dcloudio\/|@tarojs\/|uni-app$|mpvue$|wepy$|react$|react-dom$|react-native$|miniprogram-api-typings$)/.test(
          name
        )
      );
      const mobileScripts = Object.values(pkg.scripts || {}).some(
        (value) => typeof value === "string" && /(?:\buni\b|mp-weixin|mp-alipay|build:mp-)/.test(value)
      );
      if (unsupported.length || mobileScripts || existsSync(path.join(root, "pages.json")))
        throw new Error(
          `本配套只适用于 PC Vue/Web；发现移动/小程序/其他技术栈签名 ${unsupported.join(", ") || "pages.json/构建命令"}，不自动套用 PC Kit`
        );
      if (!declaredPackages.vue)
        throw new Error("本 frontend 配套只支持技术经理明确选择的 PC Vue/Web；未见 Vue 依赖，不自动套用");
      addGap(
        "PC-SCOPE-CONFIRMATION",
        "技术经理确认实际为 PC Vue/Web 管理端；Vue 声明不能证明移动 H5 也适用，本配套不用于移动项目"
      );
    }
    for (const [name, version] of Object.entries(dependencies)) {
      const buckets = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].filter(
        (bucket) => pkg[bucket]?.[name] !== undefined
      );
      if (buckets.length > 1) throw new Error(`${name} 在多个依赖类别重复声明：${buckets.join(", ")}；请先评审合并`);
      if (buckets.length === 1) {
        const bucket = buckets[0];
        const previousVersion = pkg[bucket][name];
        if (previous === null && previousVersion === version)
          dependencyChanges.push({ name, bucket, from: null, to: version, approval: "selected-fixed-preset" });
        if (previousVersion !== version) {
          if (!allowDependencyUpdates)
            throw new Error(
              `${bucket}.${name}=${previousVersion}，批准固定版本为 ${version}；先评审升级，明确批准时可带 --allow-dependency-updates 重新预览`
            );
          if (typeof previousVersion !== "string" || !/^[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(previousVersion))
            throw new Error(`${name} 当前是非标准版本引用 ${previousVersion}；明确批准升级选项不覆盖自有/链接依赖`);
          dependencyChanges.push({
            name,
            bucket,
            from: previousVersion,
            to: version,
            approval: "explicit-dependency-update",
          });
          pkg[bucket][name] = version;
        }
      } else {
        pkg.devDependencies ??= {};
        pkg.devDependencies[name] = version;
        dependencyChanges.push({
          name,
          bucket: "devDependencies",
          from: null,
          to: version,
          approval: "selected-fixed-preset",
        });
      }
    }
    const actionPath =
      kind === "backend" ? "../scripts/quality/project-actions.mjs" : "scripts/quality/project-actions.mjs";
    const scripts = {
      "quality:check": `node ${actionPath} check`,
      "quality:repair:preview": `node ${actionPath} preview-repair`,
      "quality:repair:apply": `node ${actionPath} confirm-repair`,
    };
    pkg.scripts ??= {};
    for (const [name, value] of Object.entries(scripts)) {
      if (pkg.scripts[name] !== undefined && pkg.scripts[name] !== value)
        throw new Error(`scripts.${name} 已有其他用途`);
      pkg.scripts[name] = value;
    }
    if (migrateLegacyHooks && kind === "frontend") {
      const changes = migrateLintStaged(pkg);
      if (changes.length)
        legacyMigrations.push({ target: packageTarget, kind: "confirmed-readonly-lint-staged", changes });
    }
    propose(packageTarget, json(pkg));
    const hooksContent = [".husky/pre-commit", ".husky/pre-push", ".githooks/pre-commit", ".githooks/pre-push"]
      .map((file) => {
        try {
          const previous = readTarget(file) || "";
          return migrateLegacyHooks && kind === "frontend"
            ? migrateFrontendHook(path.basename(file), previous, readSource)
            : previous;
        } catch {
          return "";
        }
      })
      .join("\n");
    if (/--fix\b|--write\b|prettier\s+--write/.test(stable(pkg["lint-staged"] || {}) + hooksContent))
      addGap(
        "LEGACY-SILENT-REPAIR",
        "既有 lint-staged/Hook 会自动写源码；技术经理应评审拆为只读检查与确认后修复，本工具保留原行为"
      );
    if (
      /wl-skills-kit.*(?:validate|--pre-commit|--typecheck)|wl-skills-bd(?:\.js)?["\']?\s+validate\b/.test(hooksContent)
    )
      addGap(
        "LEGACY-DUPLICATE-CHECK",
        "旧 Hook 与 Gate 可能重复检查；技术经理批准唯一检查生产者后再迁移，本工具保留原检查"
      );
  });

  let approvedPolicy,
    detectedFrontendTests = null;
  function frontendBusinessEntries() {
    if (kind !== "frontend") return [];
    const pkg = JSON.parse(readTarget("package.json"));
    const entries = [];
    if (typeof pkg.scripts?.["validate:deps"] === "string")
      entries.push({
        id: "FE-DEPENDENCY-CONTRACT",
        tool: "project-script",
        script: "validate:deps",
        scriptHash: hash(pkg.scripts["validate:deps"]),
        dimension: "工程资产与持续治理",
      });
    const business = pkg.scripts?.["validate:steelmaking"];
    if (typeof business === "string" && !/["'`$;|<>\n\r]/.test(business)) {
      const segments = business.split("&&").map((x) => x.trim());
      const tests = segments
        .filter((x) => /^node --test (?:[A-Za-z0-9_./-]+\.test\.(?:mjs|cjs|js)(?:\s+|$))+$/.test(x))
        .flatMap((x) => x.split(/\s+/).slice(2));
      if (tests.length) {
        tests.forEach((file) => {
          if (readTarget(file) === null) throw new Error(`已登记业务测试缺失: ${file}`);
        });
        detectedFrontendTests = { schemaVersion: 1, testFiles: tests, requiredTests: [], requiredSuites: [] };
        const existingPlan = readTarget("quality/frontend-tests.plan.json");
        if (
          existingPlan !== null &&
          stable([...JSON.parse(existingPlan).testFiles].sort()) !== stable([...tests].sort())
        )
          throw new Error("已登记业务必测计划与脚本范围不同；先审阅适配，不覆盖自定义必测项");
        entries.push({
          id: "FE-BUSINESS-CONTRACTS",
          tool: "project-script",
          script: "validate:steelmaking",
          scriptHash: hash(business),
          omitNodeTests: true,
          nodeTestPlan: "quality/frontend-tests.plan.json",
          pairedTestCheck: "FE-BUSINESS-TESTS",
          dimension: "编码规范",
        });
        entries.push({
          id: "FE-BUSINESS-TESTS",
          tool: "node-tests",
          plan: "quality/frontend-tests.plan.json",
          planHash: hash(readTarget("quality/frontend-tests.plan.json") || json(detectedFrontendTests)),
          dimension: "测试规范",
        });
      }
    }
    for (const entry of entries) entry.profiles = ["standard", "release"];
    return entries;
  }
  step("quality/policy.yml", () => {
    const existingPolicies = ["quality/policy.yml", "quality/policy.yaml", "quality/policy.json"].filter(
      (file) => readTarget(file) !== null
    );
    if (adoption && existingPolicies.length) {
      if (existingPolicies.length !== 1)
        throw new Error("已接项目存在多个策略文件；先审阅消除遮蔽，升级不选择其中一份");
      const relative = existingPolicies[0],
        previous = committedText(relative),
        config = loadConfig(root);
      if (
        (projectName && config.policy.project !== projectName) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,199}$/.test(config.policy.project)
      )
        throw new Error("已接策略项目标识与当前项目不一致");
      approvedPolicy = config.policy;
      const requiredOld =
        kind === "frontend"
          ? ["FE-ESLINT", "FE-TYPECHECK", "FE-KIT", "FE-UI"]
          : ["BE-PL-UNIT", "BE-PL-BD", "BE-PL-CHECKSTYLE", "BE-PL-PMD", "BE-PL-SPOTBUGS"];
      const defaultPolicy = parseYamlLite(fromExample(kind + "/policy.yml"));
      const businessEntries = allowDependencyUpdates ? frontendBusinessEntries() : [];
      const missing = [...defaultPolicy.checks, ...businessEntries].filter(
        (check) => !approvedPolicy.checks.some((old) => old.id === check.id)
      );
      if (
        allowDependencyUpdates &&
        missing.length &&
        requiredOld.every((id) => approvedPolicy.checks.some((check) => check.id === id))
      ) {
        const source = templates();
        const previousPreset = JSON.parse(
          readSource(path.join(source.root, "assets/quality-preset-0.11.json"), "固定0.11预设迁移口径")
        )[kind];
        const replaceIds = kind === "backend" ? ["BE-PL-CHECKSTYLE", "BE-PL-PMD", "BE-PL-SPOTBUGS"] : [];
        for (const id of replaceIds) {
          if (
            stable(approvedPolicy.checks.find((check) => check.id === id)) !==
            stable(previousPreset.checks.find((check) => check.id === id))
          )
            throw new Error("旧Java原生生产器存在自定义差异，不能重复执行或静默丢失；工程维护者先按实际范围适配");
        }
        approvedPolicy.checks = approvedPolicy.checks.filter((check) => !replaceIds.includes(check.id));
        const additions = missing.map((check) => structuredClone(check));
        const reference = additions.find((check) => check.tool === "java-scan");
        if (reference) {
          const existingPlan = readTarget(reference.plan);
          if (existingPlan !== null) reference.planHash = hash(existingPlan);
          approvedPolicy.checks.unshift(reference);
        }
        approvedPolicy.checks.push(...additions.filter((check) => check !== reference));
        approvedPolicy.releaseRequires = [
          ...new Set([
            ...(approvedPolicy.releaseRequires || []).filter((id) => !replaceIds.includes(id)),
            ...additions.map((check) => check.id),
          ]),
        ];
        const updated = json(approvedPolicy);
        legacyMigrations.push({
          target: relative,
          kind: "approved-complete-detector-preset-upgrade",
          beforeHash: hash(previous),
          afterHash: hash(updated),
          preservedCustomCheckIds: approvedPolicy.checks
            .filter((check) => !additions.some((added) => added.id === check.id))
            .map((check) => check.id),
        });
        propose(relative, updated);
        return;
      }
      propose(relative, previous);
      return;
    }
    const alternatives = ["quality/policy.yaml", "quality/policy.json"].filter((file) => readTarget(file) !== null);
    if (alternatives.length)
      throw new Error(
        "已有其他格式策略 " + alternatives.join(", ") + "；请技术经理先审核合并，不能新建 policy.yml 遮蔽原必需检查"
      );
    let policy = fromExample(kind + "/policy.yml");
    const entries = frontendBusinessEntries();
    if (entries.length) {
      const parsed = parseYamlLite(policy);
      parsed.releaseRequires = [...new Set([...parsed.releaseRequires, ...entries.map((entry) => entry.id)])];
      parsed.checks.push(...entries);
      policy = json(parsed);
    }
    if (projectName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,199}$/.test(projectName))
      throw new Error("项目标识格式无效");
    approvedPolicy = policy.trimStart().startsWith("{") ? JSON.parse(policy) : parseYamlLite(policy);
    if (projectName) approvedPolicy.project = projectName;
    const desired = entries.length
      ? json(approvedPolicy)
      : projectName
        ? policy.replace(/^project: .*$/m, `project: ${JSON.stringify(projectName)}`)
        : policy;
    propose("quality/policy.yml", desired, undefined, true);
  });
  if (kind === "frontend")
    step("quality/frontend-tests.plan.json", () => {
      const existing = readTarget("quality/frontend-tests.plan.json");
      if (existing !== null) {
        if (adoption) committedText("quality/frontend-tests.plan.json");
        const plan = JSON.parse(existing);
        if (plan.schemaVersion !== 1 || !Array.isArray(plan.testFiles) || !plan.testFiles.length)
          throw new Error("既有前端必测计划无效");
        propose("quality/frontend-tests.plan.json", existing);
      } else if (detectedFrontendTests)
        propose("quality/frontend-tests.plan.json", json(detectedFrontendTests), undefined, true);
    });
  step("quality/review-policy.json", () => {
    if (!approvedPolicy) throw new Error("缺少已核验的项目策略");
    const previous = readTarget("quality/review-policy.json");
    if (adoption && previous !== null) {
      committedText("quality/review-policy.json");
      validateReviewPolicy(JSON.parse(previous), approvedPolicy.project);
      propose("quality/review-policy.json", previous);
      return;
    }
    const source = templates();
    const review = JSON.parse(
      readSource(path.join(source.root, "templates/quality/review-policy.json"), source.origin)
    );
    const policyText = fromExample(kind + "/policy.yml");
    const declared = /^project:\s*(.+)$/m.exec(policyText)?.[1]?.trim();
    const actualProject =
      approvedPolicy.project || projectName || (declared?.startsWith('"') ? JSON.parse(declared) : declared);
    if (!actualProject || !Array.isArray(review.dimensions) || review.dimensions.length !== 9)
      throw new Error("九维Review模板或项目标识无效");
    review.project = actualProject;
    propose("quality/review-policy.json", json(review), undefined, true);
  });
  step("quality/review-evidence.plan.json", () => {
    if (!approvedPolicy) throw new Error("缺少已纳入批准计划的 Gate 策略，不能推断 Review 必需测试");
    const previous = readTarget("quality/review-evidence.plan.json");
    if (previous !== null) {
      if (adoption) committedText("quality/review-evidence.plan.json");
      const existing = JSON.parse(previous);
      const requiredIds = existing.requiredTestCheckIds === undefined ? [] : existing.requiredTestCheckIds;
      if (
        existing.schemaVersion !== 1 ||
        existing.project !== approvedPolicy.project ||
        !Array.isArray(existing.evidence) ||
        !Array.isArray(requiredIds) ||
        requiredIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) ||
        new Set(requiredIds).size !== requiredIds.length
      )
        throw new Error("既有 Review 证据计划版本/项目/必需测试编号无效，保留原件并请技术经理核对");
      // The existing plan owns its approved test scope and evidence mapping.
      propose("quality/review-evidence.plan.json", previous);
      return;
    }
    const source = templates(),
      evidencePlan = JSON.parse(
        readSource(path.join(source.root, "templates/quality/review-evidence.plan.json"), source.origin)
      );
    evidencePlan.project = approvedPolicy.project;
    evidencePlan.requiredTestCheckIds = approvedPolicy.checks
      .filter((check) => ["junit", "node-tests"].includes(check.tool) && check.required !== false)
      .map((check) => check.id);
    if (
      evidencePlan.requiredTestCheckIds.some(
        (id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)
      ) ||
      new Set(evidencePlan.requiredTestCheckIds).size !== evidencePlan.requiredTestCheckIds.length
    )
      throw new Error("批准策略的 JUnit 检查编号无效或重复");
    if (!evidencePlan.project || !Array.isArray(evidencePlan.evidence)) throw new Error("Review证据计划模板无效");
    propose("quality/review-evidence.plan.json", json(evidencePlan), undefined, true);
  });
  step("scripts/quality/project-actions.mjs", () =>
    proposeManaged("scripts/quality/project-actions.mjs", fromExample("automation/project-actions.mjs"))
  );
  step("scripts/quality/workspace-setup.mjs", () =>
    proposeManaged("scripts/quality/workspace-setup.mjs", fromExample("automation/workspace-setup.mjs"))
  );
  step("scripts/quality/run.mjs", () => {
    if (kind === "backend") return proposeManaged("scripts/quality/run.mjs", fromExample("backend/run.mjs"));
    const source = templates();
    proposeManaged(
      "scripts/quality/run.mjs",
      readSource(path.join(source.root, "templates/scripts-quality/run.mjs"), source.origin)
    );
  });
  if (kind === "backend") {
    step("quality/java-reference.plan.json", () => {
      const previous = readTarget("quality/java-reference.plan.json");
      if (previous !== null) {
        if (adoption) committedText("quality/java-reference.plan.json");
        const plan = JSON.parse(previous);
        if (
          plan.schemaVersion !== 1 ||
          !Array.isArray(plan.modules) ||
          !plan.modules.length ||
          !Array.isArray(plan.excludes)
        )
          throw new Error("Java完整参考计划无效");
        propose("quality/java-reference.plan.json", previous);
      } else {
        const source = templates();
        propose(
          "quality/java-reference.plan.json",
          readSource(path.join(source.root, "templates/quality/java-reference.plan.json"), source.origin),
          undefined,
          true
        );
      }
    });
    step("scripts/quality/java-unit.mjs", () =>
      proposeManaged("scripts/quality/java-unit.mjs", fromExample("backend/java-unit.mjs"))
    );
    step("quality/java-unit.plan.json", () => {
      const previous = readTarget("quality/java-unit.plan.json");
      if (adoption && previous !== null) {
        committedText("quality/java-unit.plan.json");
        const plan = JSON.parse(previous);
        if (
          plan.schemaVersion !== 1 ||
          typeof plan.prepareDependencies !== "boolean" ||
          (plan.offline !== undefined && typeof plan.offline !== "boolean") ||
          !Array.isArray(plan.modules) ||
          !plan.modules.length ||
          new Set(plan.modules.map((entry) => entry?.path)).size !== plan.modules.length
        )
          throw new Error("已接 Java 必测计划结构无效");
        const reports = new Set();
        for (const module of plan.modules) {
          safeTarget(root, `${module.path}/pom.xml`);
          if (
            typeof module.path !== "string" ||
            !module.path ||
            module.path.includes("\\") ||
            module.path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
            !existsSync(safeTarget(root, `${module.path}/pom.xml`)) ||
            !Array.isArray(module.reportFiles) ||
            !module.reportFiles.length
          )
            throw new Error("已接 Java 模块/POM/报告全集无效");
          for (const report of module.reportFiles) {
            safeTarget(root, report);
            if (
              typeof report !== "string" ||
              path.posix.dirname(report) !== `${module.path}/target/surefire-reports` ||
              !/^TEST-.+\.xml$/.test(path.posix.basename(report)) ||
              reports.has(report)
            )
              throw new Error("已接 Java 必测报告必须是模块内明确且无重复的 Surefire XML");
            reports.add(report);
          }
        }
        propose("quality/java-unit.plan.json", previous);
      } else propose("quality/java-unit.plan.json", fromExample("backend/java-unit.plan.json"), undefined, true);
    });
  }

  let hooks = { configuredPath: null, destination: ".githooks", pathConfigured: false, executionValidated: false };
  step("Git Hook 路径", () => {
    const configuredPath = git(root, ["config", "--path", "--get", "core.hooksPath"], true);
    if (configuredPath) {
      const resolved = path.resolve(root, configuredPath);
      if (resolved === root || !resolved.startsWith(`${root}${path.sep}`))
        throw new Error("core.hooksPath 指向项目外或项目根，不能自动写入");
      let destination = path.relative(root, resolved);
      // 先验证真实接收路径，不能借映射绕过 _ 目录符号链接。
      safeTarget(root, path.join(destination, ".wl-hook-path-probe"));
      if (destination.replaceAll(path.sep, "/") === ".husky/_") {
        destination = ".husky";
        if (!existsSync(path.join(root, ".husky/_/h")))
          addGap(
            "HUSKY-DISPATCHER-REQUIRED",
            "core.hooksPath 已指向 .husky/_，但未见 Husky 转发器；技术经理通过已批准 prepare 流程安装并验证，不能只凭路径声明认为 Hook 已激活"
          );
      }
      hooks = { configuredPath, destination, pathConfigured: true, executionValidated: false };
    } else if (activateHooks) {
      hooks.activation = { action: "set-local-hooks-path", before: null, after: ".githooks" };
    } else {
      addGap(
        "HOOKS-NOT-ACTIVATED",
        "已生成 .githooks，但 core.hooksPath 未配置；可在同一受控计划中选择 activateHooks 激活并验收"
      );
    }
    if (migrateLegacyHooks && kind === "backend" && hooks.destination === ".githooks") {
      const original = readTarget(".githooks/commit-msg") || "";
      if (
        original &&
        knownLegacy("backend", "commit-msg", original, readSource) &&
        !readTarget(".githooks/pre-push") &&
        !readTarget(".githooks/pre-commit")
      ) {
        hooks = {
          ...hooks,
          destination: "scripts/quality/git-hooks",
          pathConfigured: false,
          preservedBdManagedHook: { path: ".githooks/commit-msg", sha256: hash(original) },
          ...(activateHooks
            ? {
                activation: {
                  action: "set-local-hooks-path",
                  before: configuredPath || null,
                  after: "scripts/quality/git-hooks",
                },
              }
            : {}),
        };
        legacyMigrations.push({
          target: "Git core.hooksPath",
          kind: "separate-gate-dispatcher-preserve-bd-managed-file",
          after: hooks.destination,
        });
      }
    }
    const actions = kind === "frontend" ? ["pre-commit", "pre-push", "commit-msg"] : ["pre-push", "commit-msg"];
    for (const action of actions) {
      const relative = path.join(hooks.destination, action);
      step(relative, () => {
        let previous = readTarget(relative) || "";
        if (migrateLegacyHooks && kind === "frontend") {
          const migrated = migrateFrontendHook(action, previous, readSource);
          if (migrated !== previous) legacyMigrations.push({ target: relative, kind: "known-kit-block-to-gate" });
          previous = migrated;
        }
        if (hooks.preservedBdManagedHook && action === "commit-msg" && !previous) previous = fixedLocalBdCommitHook();
        if (/--fix\b|--write\b/.test(previous) && !gaps.some((gap) => gap.id === "LEGACY-SILENT-REPAIR"))
          addGap(
            "LEGACY-SILENT-REPAIR",
            "既有 Hook 会自动写源码；技术经理应评审拆为只读检查与确认后修复，本工具保留原行为"
          );
        if (
          /wl-skills-kit.*(?:validate|--pre-commit|--typecheck)|wl-skills-bd(?:\.js)?["\']?\s+validate\b/.test(
            previous
          ) &&
          !gaps.some((gap) => gap.id === "LEGACY-DUPLICATE-CHECK")
        )
          addGap(
            "LEGACY-DUPLICATE-CHECK",
            "旧 Hook 与 Gate 可能重复检查；技术经理批准唯一检查生产者后再迁移，本工具保留原检查"
          );
        propose(relative, hookText(previous, action), 0o755);
      });
    }
    addGap("HOOK-EXECUTION-UNVERIFIED", "Hook 文件配置不代表已实际触发；需在装好依赖后做正常/违规提交与推送验收");
  });

  if (workspaceRegistry !== undefined)
    step("quality/workspace.json", () => {
      let registry;
      try {
        registry = new URL(workspaceRegistry);
      } catch {
        throw new Error("工作副本清单需要明确批准的HTTPS安装源");
      }
      if (registry.protocol !== "https:" || registry.username || registry.password || registry.search || registry.hash)
        throw new Error("工作副本安装源必须为不带凭据或查询参数的HTTPS地址");
      registry.pathname = registry.pathname.replace(/\/?$/, "/");
      const pkg = JSON.parse(files.find((file) => file.path === packageTarget)?.afterContent || "{}");
      if (kind === "frontend" && !/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager || ""))
        throw new Error(
          "PC项目缺少固定 packageManager（如 pnpm@10.34.5）；由技术经理确认项目运行环境后写入，再接入，不能生成无法复现的新克隆清单"
        );
      const actions = kind === "frontend" ? ["pre-commit", "pre-push", "commit-msg"] : ["pre-push", "commit-msg"];
      const hookFiles = actions.map((action) => {
        const relative = path.join(hooks.destination, action).replaceAll(path.sep, "/");
        const planned = files.find((file) => file.path.replaceAll(path.sep, "/") === relative);
        if (!planned) throw new Error("缺少批准的 Hook 文件：" + relative);
        return { path: relative, sha256: planned.afterHash };
      });
      const previous = readTarget("quality/workspace.json");
      let existing = null;
      if (previous !== null) {
        existing = JSON.parse(previous);
        if (
          existing.schemaVersion !== 1 ||
          existing.kind !== "wl-quality-workspace" ||
          existing.projectKind !== kind ||
          existing.dependencyDirectory !== (kind === "backend" ? "quality-tools" : ".") ||
          ![VERSIONS.gate, adoption?.manifest.gateVersion].includes(existing.gateVersion) ||
          (existing.project !== undefined && existing.project !== approvedPolicy?.project)
        )
          throw new Error("既有工作副本清单不是当前已批准接入身份，不能自动覆盖");
      }
      const desired = json({
        ...(existing || {}),
        schemaVersion: 1,
        kind: "wl-quality-workspace",
        projectKind: kind,
        gateVersion: VERSIONS.gate,
        registry: registry.href,
        dependencyDirectory: kind === "backend" ? "quality-tools" : ".",
        packageManager: kind === "backend" ? "npm" : pkg.packageManager,
        project: approvedPolicy?.project,
        hooksPath: (hooks.activation?.after || hooks.configuredPath || hooks.destination).replaceAll(path.sep, "/"),
        hookFiles,
        managedFiles,
      });
      if (previous !== null && previous !== desired && adoption && !allowDependencyUpdates)
        throw new Error("已接清单版本/受管摘要更新须明确允许依赖与受管资产升级，再预览实际差异");
      if (previous !== null && previous !== desired && !adoption) {
        // A first setup can span several confirmations before its adoption commit.
        // Only the manifest produced by this same fixed package may continue.
        if (
          existing.gateVersion !== VERSIONS.gate ||
          !Array.isArray(existing.managedFiles) ||
          existing.managedFiles.some(
            (entry) => !managedFiles.some((known) => known.path === entry?.path && known.sha256 === entry.sha256)
          )
        )
          throw new Error("未提交清单并非本固定版本生成；保留原件，请先审阅接入身份");
      }
      propose("quality/workspace.json", desired);
    });

  step(".gitignore", () => {
    const previous = readTarget(".gitignore") || "";
    const source = templates();
    const generated = readSource(path.join(source.root, "templates/quality/generated.gitignore"), source.origin);
    const required = [
      ...generated
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
      kind === "backend" ? "/quality-tools/node_modules/" : "/node_modules/",
      "/.quality-onboarding-backups/",
      "/.quality-onboarding.lock",
      "/.quality-onboarding-execution.lock",
      "/.quality-workspace.lock",
    ];
    const existing = new Set(previous.split(/\r?\n/).map((line) => line.trim()));
    const missing = required.filter((line) => !existing.has(line));
    const suffix = missing.length
      ? `${previous && !previous.endsWith("\n") ? "\n" : ""}\n# wl-quality-onboarding generated artifacts\n${missing.join("\n")}\n`
      : "";
    propose(".gitignore", previous + suffix);
  });

  step(".vscode/tasks.json", () => {
    const desired = JSON.parse(fromExample("automation/ide-tasks.json"));
    const previous = readTarget(".vscode/tasks.json");
    let tasks;
    try {
      tasks = previous === null ? { version: "2.0.0", tasks: [], inputs: [] } : JSON.parse(previous);
    } catch {
      throw new Error("既有 IDE tasks 非严格 JSON；为保护注释/自定义格式，请技术经理先评审合并");
    }
    if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) throw new Error("IDE tasks 必须是对象");
    if (tasks.version !== undefined && tasks.version !== "2.0.0") throw new Error("既有 IDE tasks 版本不兼容");
    tasks.version = "2.0.0";
    if (tasks.inputs !== undefined && !Array.isArray(tasks.inputs)) throw new Error("IDE inputs 必须是数组");
    const legacyInputs = (tasks.inputs || []).filter((input) => input?.id === LEGACY_CONFIRM_INPUT.id);
    if (legacyInputs.length > 1 || legacyInputs.some((input) => stable(input) !== stable(LEGACY_CONFIRM_INPUT)))
      throw new Error("旧受管确认输入与历史配套不同；请技术经理先评审合并，不自动删除自有同名 input");
    if (legacyInputs.length) tasks.inputs = tasks.inputs.filter((input) => input.id !== LEGACY_CONFIRM_INPUT.id);
    tasks.tasks = mergeEntries(tasks.tasks || [], desired.tasks, "label", "IDE tasks");
    tasks.inputs = mergeEntries(tasks.inputs || [], desired.inputs || [], "id", "IDE inputs");
    propose(".vscode/tasks.json", json(tasks));
  });

  for (const [name, version] of Object.entries(dependencies)) {
    const relative = `${kind === "backend" ? "quality-tools/" : ""}node_modules/${name}/package.json`;
    try {
      const absolute = path.join(root, relative);
      const actual = JSON.parse(readFileSync(absolute, "utf8"));
      const installedRoot = realpathSync(path.dirname(absolute));
      if (!installedRoot.startsWith(`${root}${path.sep}`) || actual.name !== name || actual.version !== version)
        throw new Error("安装路径/版本不符合批准清单");
    } catch {
      addGap(
        "DEPENDENCY-INSTALL-REQUIRED",
        `${name}@${version} 尚未核验安装；技术经理使用批准 registry/镜像安装并锁定，本工具不运行安装`
      );
    }
  }
  addGap(
    "NATIVE-ASSETS-VERIFICATION",
    "安装/升级包不会自动同步项目原生受管资产；技术经理按对应包的受控接入/update 流程复核资产版本，本工具不复制 Kit/UI/BD 原生规则资产"
  );
  let environment;
  try {
    environment = onboardingEnvironment({
      root,
      kind,
      manifestContent: files.find((file) => file.path === packageTarget)?.afterContent,
    });
    for (const blocker of environment.blockers) {
      addGap(blocker.id, blocker.reason, blocker.nextOwner);
      hardConflicts.push({ target: "Node environment", reason: blocker.reason, nextOwner: blocker.nextOwner });
    }
  } catch (error) {
    conflict("Node environment", error.message);
  }
  for (const relative of [
    kind === "frontend" ? "pnpm-lock.yaml" : "quality-tools/package-lock.json",
    "quality/rules.lock.json",
  ]) {
    try {
      if (readTarget(relative) === null)
        addGap("LOCK-VERIFICATION-REQUIRED", `${relative} 缺失；安装后在批准环境采集实际版本并审核`);
    } catch (error) {
      conflict(relative, error.message);
    }
  }
  if (kind === "backend") {
    try {
      const pom = readTarget("pom.xml");
      if (pom === null)
        throw new Error("本 backend 配套只适用于 Java/Maven 项目；根目录缺 pom.xml，不自动接入其他技术栈");
      for (const profile of ["wl-quality-audit", "wl-quality-unit"])
        if (!new RegExp(`<id>\\s*${profile}\\s*</id>`).test(pom))
          addGap(
            "POM-PROFILE-REQUIRED",
            `根 POM 未见 ${profile}；后端负责人合并并验证实际有效 POM，本工具不写 POM`,
            "后端负责人"
          );
      addGap(
        "JAVA-SCOPE-AND-TESTS",
        "PL 示例的三类六例只用于接线；后端/测试负责人批准真实模块全集、业务必测、覆盖率与依赖环境",
        "后端/测试负责人"
      );
    } catch (error) {
      conflict("pom.xml", error.message);
    }
  }
  addGap(
    "CENTRAL-CI-AND-RELEASE",
    "统一 CI 模板引用、强制检查、候选与制品验证尚未验收；本工具不修改 CI",
    "流水线维护者"
  );
  addGap(
    "REVIEW-AND-BRANCH-PERMISSIONS",
    "分支权限和独立 Review 放行尚未验收；本工具不访问仓库 API",
    "仓库/流水线维护者"
  );
  addGap(
    "QUALITY-SERVICE-AND-FEISHU",
    "可信来源、认证认领、台账、飞书与独立关闭尚未验收；本工具不注册或发送消息",
    "统一质量服务维护者"
  );
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true);
  if (!head) addGap("GIT-HEAD-REQUIRED", "仓库尚无真实 HEAD；正式 Gate 检查必须绑定真实版本");
  const plan = {
    schemaVersion: 1,
    kind,
    root,
    head,
    status: hardConflicts.length ? "configuration-blocked" : "configuration-planned",
    approvals: {
      allowDependencyUpdates: !!allowDependencyUpdates,
      activateHooks: !!activateHooks,
      migrateLegacyHooks: !!migrateLegacyHooks,
    },
    dependencyChanges,
    legacyMigrations,
    requestedGateTemplateRoot: gateTemplateRoot ? path.resolve(gateTemplateRoot) : null,
    gateTemplateSource,
    hooks,
    sources,
    files,
    hardConflicts,
    gaps,
    environment,
    excludedActions: [
      "依赖安装/联网",
      "POM 修改",
      ...(activateHooks ? ["Git 远端操作"] : ["Git 配置与远端操作"]),
      "CI/部署",
      "权限/API/飞书注册",
      "业务测试或修复",
    ],
    acceptance: "本地配置计划；不是项目、流水线或整改闭环验收",
  };
  plan.planHash = hash(stable(plan));
  return plan;
}

export function applyConfiguration(options) {
  if (!options.confirm || !options.planHash) throw new Error("应用配置必须携带 --plan-hash 与显式 --confirm");
  const plan = planConfiguration(options);
  if (plan.hardConflicts.length) throw new Error("存在配置冲突，零写入；先处理 gaps 后重新预览");
  if (options.planHash !== plan.planHash) throw new Error("计划或目标文件已变化，planHash 不一致，零写入；请重新预览");
  const root = plan.root;
  const lockPath = safeTarget(root, ".quality-onboarding.lock");
  const changed = plan.files.filter((file) => file.action !== "unchanged");
  const madeDirectories = [];
  const written = [];
  const before = new Map();
  let lock;
  let hooksActivated = false;
  const ensureDirectory = (absolute) => {
    if (existsSync(absolute)) return;
    const parent = path.dirname(absolute);
    if (parent !== absolute) ensureDirectory(parent);
    mkdirSync(absolute);
    madeDirectories.push(absolute);
  };
  try {
    lock = openSync(lockPath, "wx", 0o600);
    // 获取独占配置锁后重算，阻止预览和执行之间的目标或配套漂移。
    if (planConfiguration(options).planHash !== plan.planHash) throw new Error("获取配置锁后计划发生变化，零写入");
    for (const file of changed) {
      const absolute = safeTarget(root, file.path);
      before.set(
        file.path,
        existsSync(absolute) ? { content: readFileSync(absolute), mode: lstatSync(absolute).mode & 0o777 } : null
      );
    }
    // 先备份全部既有文件，备份失败不写目标文件。
    for (const [relative, original] of before)
      if (original) {
        const backup = safeTarget(root, path.join(".quality-onboarding-backups", plan.planHash, relative));
        ensureDirectory(path.dirname(backup));
        if (existsSync(backup) && hash(readFileSync(backup)) !== hash(original.content))
          throw new Error("已有接入备份内容冲突");
        if (!existsSync(backup)) writeFileSync(backup, original.content, { flag: "wx", mode: 0o600 });
      }
    for (const file of changed) {
      const absolute = safeTarget(root, file.path);
      const currentHash = existsSync(absolute) ? hash(readFileSync(absolute)) : null;
      if (currentHash !== file.beforeHash) throw new Error(`配置期间文件变化：${file.path}`);
      ensureDirectory(path.dirname(absolute));
      const temporary = safeTarget(root, `${file.path}.wl-quality-${plan.planHash.slice(0, 12)}.tmp`);
      let temporaryCreated = false;
      try {
        writeFileSync(temporary, file.afterContent, { flag: "wx", mode: file.afterMode });
        temporaryCreated = true;
        chmodSync(temporary, file.afterMode);
        renameSync(temporary, absolute);
        written.push(file.path);
      } finally {
        if (temporaryCreated && existsSync(temporary)) rmSync(temporary);
      }
    }
    if (plan.hooks.activation) {
      if (git(root, ["config", "--path", "--get", "core.hooksPath"], true) !== plan.hooks.activation.before)
        throw new Error("Hook 激活前 Git 配置发生变化，回滚本次配置");
      git(root, ["config", "--local", "core.hooksPath", plan.hooks.activation.after]);
      hooksActivated = true;
    }
    return {
      schemaVersion: 1,
      status: "configuration-applied",
      root,
      kind: plan.kind,
      planHash: plan.planHash,
      hooks: { ...plan.hooks, pathConfigured: hooksActivated || plan.hooks.pathConfigured, executionValidated: false },
      approvals: plan.approvals,
      dependencyChanges: plan.dependencyChanges,
      files: changed.map(({ path: file, action, afterHash }) => ({ path: file, action, afterHash })),
      backupDirectory: changed.some((file) => file.beforeHash)
        ? path.join(root, ".quality-onboarding-backups", plan.planHash)
        : null,
      gaps: plan.gaps,
      acceptance: "仅本地配置已应用；缺项未验收，不能登记项目接入通过",
    };
  } catch (error) {
    if (hooksActivated) {
      if (plan.hooks.activation.before)
        git(root, ["config", "--local", "core.hooksPath", plan.hooks.activation.before]);
      else git(root, ["config", "--local", "--unset", "core.hooksPath"], true);
    }
    // 只恢复本次已写文件，不使用 git reset，不动其他文件。
    for (const relative of [...written].reverse()) {
      const absolute = safeTarget(root, relative);
      const original = before.get(relative);
      if (original) {
        writeFileSync(absolute, original.content);
        chmodSync(absolute, original.mode);
      } else rmSync(absolute);
    }
    throw error;
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      rmSync(lockPath);
    }
    for (const directory of [...madeDirectories].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        /* 有备份/有效文件的目录保留。 */
      }
    }
  }
}

export function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--apply", "--confirm", "--allow-dependency-updates"].includes(arg)) {
      result[arg === "--allow-dependency-updates" ? "allowDependencyUpdates" : arg.slice(2)] = true;
      continue;
    }
    if (["--kind", "--root", "--plan-hash", "--gate-template-root"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺值`);
      const key =
        arg === "--plan-hash" ? "planHash" : arg === "--gate-template-root" ? "gateTemplateRoot" : arg.slice(2);
      if (result[key] !== undefined) throw new Error(`${arg} 不能重复`);
      result[key] = value;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  if (!result.kind || !result.root)
    throw new Error(
      "用法：configure.mjs --kind frontend|backend --root PATH [--gate-template-root PATH] [--allow-dependency-updates] [--apply --plan-hash HASH --confirm]"
    );
  if (!result.apply && (result.confirm || result.planHash)) throw new Error("--plan-hash/--confirm 仅用于 --apply");
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.apply ? applyConfiguration(options) : planConfiguration(options);
    process.stdout.write(json(result));
    if (result.hardConflicts?.length) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`[quality-onboarding] ${error.message}\n`);
    process.exitCode = 2;
  }
}
