import path from "node:path";
import { readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { planConfiguration, applyConfiguration } from "./onboard-config.js";
import { planCompleteOnboarding, executeCompleteOnboarding } from "./onboard-complete.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(PACKAGE_ROOT, "templates/onboarding");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function projectFile(root, relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) return null;
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(root + path.sep))
    throw new Error(`项目身份文件必须是仓库内普通文件：${relative}`);
  return readFileSync(file, "utf8");
}

export function detectProject({ root = ".", kind = "auto" } = {}) {
  root = path.resolve(root);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("项目根必须是存在的真实目录");
  root = realpathSync(root);
  if (!["auto", "frontend", "backend"].includes(kind)) throw new Error("--kind 必须为 auto/frontend/backend");
  const packageText = projectFile(root, "package.json"), pomText = projectFile(root, "pom.xml");
  let pkg;
  try { pkg = packageText ? JSON.parse(packageText) : null; } catch { throw new Error("package.json 无法解析"); }
  const dependencies = Object.assign({}, pkg?.dependencies, pkg?.devDependencies, pkg?.optionalDependencies, pkg?.peerDependencies);
  const mobile = Object.keys(dependencies).some((name) => /^(?:@dcloudio\/|@tarojs\/|uni-app$|mpvue$|wepy$|react-native$|miniprogram-api-typings$)/.test(name))
    || existsSync(path.join(root, "pages.json"))
    || Object.values(pkg?.scripts || {}).some((value) => typeof value === "string" && /(?:\buni\b|mp-weixin|mp-alipay|build:mp-)/.test(value));
  if (kind === "auto") {
    if (pomText && dependencies.vue) throw new Error("同时发现 Maven 和 Vue；请明确 --kind，不能把聚合仓库误判成一个项目");
    if (pomText) kind = "backend";
    else if (dependencies.vue && !mobile) {
      if (!dependencies["@agile-team/wl-skills-kit"] && pkg?.name !== "wl-ui-produce")
        throw new Error("发现 Vue，但不能证明属于 PC 管理端；确认范围后使用 --kind frontend，移动 H5 不适用 PC 配套");
      kind = "frontend";
    } else throw new Error(mobile ? "发现移动/小程序项目，不能自动套用 PC 质量配套" : "未识别受支持的 PC Vue 或 Java/Maven 项目");
  }
  if (kind === "frontend" && (!dependencies.vue || mobile)) throw new Error("frontend 配套仅适用明确的 PC Vue 项目，移动/小程序/其他技术栈不适用");
  if (kind === "backend" && !pomText) throw new Error("backend 配套需要真实 Maven 根 POM");
  const preset = kind === "frontend" ? "pc-vue" : existsSync(path.join(root, "wl-produce-pl/wl-produce-pl-service/pom.xml")) ? "wl-produce-pl" : "custom-maven";
  return { root, kind, preset, projectName: kind === "frontend" ? pkg?.name || path.basename(root) : "wl-produce", identity: [packageText && { path: "package.json", sha256: digest(packageText) }, pomText && { path: "pom.xml", sha256: digest(pomText) }].filter(Boolean) };
}

function effectiveOptions(options) {
  const detected = detectProject(options);
  if (detected.preset === "custom-maven" && !options.assetRoot)
    throw new Error("已识别 Java/Maven，但内置后端配置是 wl-produce PL 的实际模块与测试；不能套用到其他项目。技术经理从包内 templates/onboarding/backend 创建项目受控配套，并以 --asset-root 指定其父目录，再走同一计划/确认流程。");
  const assetRoot = options.assetRoot ? path.resolve(options.assetRoot) : ASSETS;
  if (!existsSync(assetRoot) || !lstatSync(assetRoot).isDirectory() || lstatSync(assetRoot).isSymbolicLink()) throw new Error("--asset-root 必须是受控资产真实目录");
  return { detected, configuration: { kind: detected.kind, root: detected.root, assetRoot,
    sharedGateRoot: PACKAGE_ROOT, gateTemplateRoot: options.gateTemplateRoot || PACKAGE_ROOT,
    projectName: detected.kind === "frontend" ? detected.projectName : undefined, migrateLegacyHooks: true,
    workspaceRegistry: options.registry,
    allowDependencyUpdates: options.allowDependencyUpdates === true, activateHooks: options.activateHooks !== false } };
}

export function planOnboarding(options = {}) {
  const { detected, configuration } = effectiveOptions(options);
  const plan = planConfiguration(configuration);
  // The public approval also binds detector/configurator implementation and project classification.
  const implementation = ["lib/onboard.js", "lib/onboard-config.js", "lib/onboard-complete.js", "lib/onboard-registry.js", "lib/onboard-legacy.js", "lib/onboard-environment.js", "lib/onboard-lifecycle.js", "lib/project-actions.js", "lib/config.js", "lib/review.js", "lib/yaml-lite.js", "lib/source-state.js", "lib/util.js", "lib/doctor.js", "lib/evidence.js", "lib/validate-report.js", "templates/onboarding/legacy/frontend-common-core-postinstall.mjs", "templates/onboarding/legacy/frontend-enforce-pnpm.mjs", "templates/onboarding/legacy/managed-assets.json"].map((relative) => ({ path: relative, sha256: digest(readFileSync(path.join(PACKAGE_ROOT, relative))) }));
  const result = { ...plan, kind: "project-onboarding", projectKind: detected.kind, preset: detected.preset,
    identity: detected.identity, implementation, configurationPlanHash: plan.planHash,
    dependencyLayout: detected.kind === "backend" ? {
      directory: "quality-tools", role: "项目内 Node 质量工具依赖目录，不是另一个 npm 包或门禁引擎",
      gate: "quality-tools/node_modules/@agile-team/wl-skills-gate", nativeRules: "quality-tools/node_modules/@agile-team/wl-skills-bd",
      businessBuild: "继续由 Maven/Java 执行；Node 仅负责质量编排和证据",
    } : { directory: ".", role: "复用项目 package.json 与既有 Git 工具，Gate 统一编排" },
    capabilities: { localConfiguration: true, hookActivation: true, dependencyInstall: !!options.complete, nativeRulesUpdate: !!options.complete,
      pomMigration: !!options.complete && detected.preset === "wl-produce-pl", remoteCiRegistration: false, fullAcceptance: false } };
  if (options.complete) result.complete = planCompleteOnboarding(result, options);
  delete result.planHash;
  result.planHash = digest(stable(result));
  return result;
}

export function applyOnboarding(options = {}) {
  if (!options.confirm || !options.planHash) throw new Error("应用接入必须携带 --plan-hash 与显式 --confirm");
  const plan = planOnboarding(options);
  if (plan.planHash !== options.planHash) throw new Error("项目、接入程序、资产或计划已变化；planHash 不一致，零写入");
  const { configuration } = effectiveOptions(options);
  if (options.complete && plan.complete.blockers.length) return { ...plan, status: "onboarding-execution-blocked", files: [], complete: { ...plan.complete, localValidated: false, remoteValidated: false, businessClosureValidated: false }, acceptance: "预检存在明确阻断，未写项目文件或执行安装" };
  const applied = applyConfiguration({ ...configuration, planHash: plan.configurationPlanHash, confirm: true });
  const result = { ...applied, kind: "project-onboarding", projectKind: plan.projectKind, preset: plan.preset,
    planHash: plan.planHash, configurationPlanHash: applied.planHash, dependencyLayout: plan.dependencyLayout,
    capabilities: plan.capabilities, acceptance: "本地配置及已批准 Hook 路径已应用；依赖、原生规则、实际检查、Review、CI/通知与独立验收仍须以真实证据通过" };
  return options.complete ? executeCompleteOnboarding(plan, result, options) : result;
}

export function parseOnboardArgs(argv) {
  const result = { kind: "auto", root: "." }; const seen = new Set();
  const flags = new Map([["--apply", "apply"], ["--complete", "complete"], ["--confirm", "confirm"], ["--allow-dependency-updates", "allowDependencyUpdates"], ["--no-activate-hooks", "noActivateHooks"]]);
  const values = new Map([["--root", "root"], ["--registry", "registry"], ["--kind", "kind"], ["--plan-hash", "planHash"], ["--asset-root", "assetRoot"], ["--gate-template-root", "gateTemplateRoot"]]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`重复参数：${arg}`); seen.add(arg);
    if (flags.has(arg)) { result[flags.get(arg)] = true; continue; }
    if (!values.has(arg)) throw new Error(`未知参数：${arg}`);
    const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`${arg} 缺值`);
    result[values.get(arg)] = value;
  }
  result.activateHooks = !result.noActivateHooks; delete result.noActivateHooks;
  if (result.registry && !result.complete) throw new Error("--registry 仅用于 --complete");
  if (!result.apply && (result.confirm || result.planHash)) throw new Error("--plan-hash/--confirm 仅用于 --apply");
  return result;
}

export function runOnboardCli(argv) {
  const options = parseOnboardArgs(argv);
  const result = options.apply ? applyOnboarding(options) : planOnboarding(options);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.hardConflicts?.length || result.complete?.blockers?.length || result.status === "onboarding-execution-blocked" || result.status === "local-readiness-blocked" ? 2 : 0;
}
