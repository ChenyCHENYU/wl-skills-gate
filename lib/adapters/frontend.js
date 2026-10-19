import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { safePath, git } from "../source-state.js";
import { runCommand, quote } from "../exec.js";
import { sha256 } from "../util.js";
import { parseFindingsPayload } from "../finding-input.js";
import { frontendLintConfig } from "../frontend-config.js";
import { bindProducedReports, assertReportOutput } from "../report-selection.js";

const gate = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const ignored = new Set([".git", "node_modules", "dist", "build", "out", "coverage", "quality-reports", ".cache"]);
const code = /\.(?:[cm]?[jt]sx?|vue)$/i;
const dependencies = {
  typed: ["eslint", "typescript", "@typescript-eslint/parser", "@typescript-eslint/eslint-plugin", "vue-eslint-parser"],
  security: [
    "eslint",
    "eslint-plugin-vue",
    "eslint-plugin-security",
    "eslint-plugin-no-unsanitized",
    "eslint-plugin-vuejs-accessibility",
  ],
  duplicates: ["jscpd"],
  architecture: ["dependency-cruiser"],
  secrets: ["@secretlint/node", "@secretlint/secretlint-rule-preset-recommend"],
  dependencies: [],
  licenses: [],
};
export function frontendVersion(analyzer) {
  if (!Object.hasOwn(dependencies, analyzer)) throw new Error("未知前端分析器");
  return `gate-frontend-v1/${analyzer}:${sha256(
    JSON.stringify({
      dependencies: gate.dependencies,
      adapter: sha256(readFileSync(fileURLToPath(import.meta.url))),
      config: sha256(readFileSync(new URL("../frontend-config.js", import.meta.url))),
      organization: sha256(readFileSync(new URL("../rules/organization-secrets.js", import.meta.url))),
      worker: sha256(readFileSync(new URL("../frontend-worker.js", import.meta.url))),
    })
  )}`;
}
function packageRoot(name) {
  let entry;
  try {
    entry = import.meta.resolve(`${name}/package.json`);
  } catch {
    entry = import.meta.resolve(name);
  }
  let directory = path.dirname(fileURLToPath(entry));
  while (true) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === name) {
        if (pkg.version !== gate.dependencies[name]) throw new Error(`Gate原生分析器版本漂移: ${name}`);
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`原生分析器不可定位: ${name}`);
    directory = parent;
  }
}
export function frontendFiles(root, targets = ["src"]) {
  const found = new Set();
  const visit = (relative) => {
    const file = relative === "." ? root : safePath(root, relative),
      stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`前端扫描范围含符号链接: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(file))
        if (!ignored.has(entry)) visit(relative === "." ? entry : `${relative}/${entry}`);
    } else if (stat.isFile()) found.add(relative);
    else throw new Error(`前端输入不是普通文件: ${relative}`);
  };
  for (const target of targets) visit(target);
  return [...found].sort();
}
const finding = (ruleId, severity, file, line, message, suggestion, extra = {}) => ({
  ruleId,
  severity,
  file,
  line,
  message,
  suggestion,
  ...extra,
});

async function lint(root, files, analyzer) {
  if (analyzer === "typed") {
    if (!existsSync(path.join(root, "tsconfig.json"))) throw new Error("类型感知检查缺少tsconfig.json");
    const parser = await import("@typescript-eslint/parser");
    parser.clearCaches();
  }
  const { ESLint } = await import("eslint");
  const engine = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: await frontendLintConfig(root, analyzer),
    ignore: false,
    fix: false,
    allowInlineConfig: false,
  });
  const findings = [],
    raw = [];
  for (const file of files) {
    // Explicit inputs, including clean files, are checked; default ignores cannot hide an input.
    const [result] = await engine.lintText(readFileSync(safePath(root, file), "utf8"), {
      filePath: file,
      warnIgnored: true,
    });
    if (!result || result.fatalErrorCount || result.messages.some((m) => !m.ruleId))
      throw new Error(`ESLint类型/语法/范围失效: ${file}；${result?.messages?.[0]?.message || "无结果"}`);
    raw.push({ filePath: file, messages: result.messages.map(({ source, ...m }) => m) });
    for (const m of result.messages)
      findings.push(
        finding(
          `FE/${m.ruleId}`,
          m.severity === 2 ? "error" : "warning",
          file,
          m.line || null,
          m.message,
          m.ruleId.includes("promis")
            ? "按实际业务补await/错误处理；不要用void或空catch掩盖失败"
            : "按规则核对真实上下文，修复后复扫与业务回归",
          { endLine: m.endLine || null }
        )
      );
  }
  return { findings, raw };
}

async function duplicate(root, files, out, check) {
  const cli = path.join(packageRoot("jscpd"), "run-jscpd.js");
  const minTokens = check.minimumTokens ?? 100;
  if (!Number.isInteger(minTokens) || minTokens < 1) throw new Error("重复代码minimumTokens非法");
  const configFile = path.join(out, "jscpd-config.json");
  writeFileSync(configFile, "{}");
  const command = [
    process.execPath,
    cli,
    "--config",
    configFile,
    "--reporters",
    "json",
    "--output",
    out,
    "--min-tokens",
    String(minTokens),
    "--min-lines",
    "5",
    "--silent",
    "--absolute",
    ...files,
  ]
    .map(quote)
    .join(" ");
  const result = await runCommand(command, { cwd: root, timeoutMs: check.timeoutMs || 300000 });
  if (result.code !== 0 || result.timedOut) throw new Error("jscpd执行失效");
  const raw = JSON.parse(readFileSync(path.join(out, "jscpd-report.json"), "utf8"));
  if (
    !raw.statistics?.total ||
    !Array.isArray(raw.duplicates) ||
    !Number.isInteger(raw.statistics.total.sources) ||
    raw.statistics.total.sources < 0 ||
    raw.statistics.total.sources > files.length
  )
    throw new Error("jscpd输入覆盖不完整/结构非法");
  const findings = [];
  for (const block of raw.duplicates) {
    const related = [block.firstFile, block.secondFile].map((occurrence) => {
      const file = path.isAbsolute(occurrence.name)
        ? path.relative(realpathSync(root), occurrence.name).split(path.sep).join("/")
        : occurrence.name;
      if (
        !files.includes(file) ||
        !Number.isInteger(occurrence.start) ||
        occurrence.start < 1 ||
        !Number.isInteger(occurrence.end) ||
        occurrence.end < occurrence.start
      )
        throw new Error("jscpd重复位置越界");
      const lines = readFileSync(safePath(root, file), "utf8").split(/\r?\n/);
      if (occurrence.end > lines.length) throw new Error("jscpd重复位置越界");
      return { file, line: occurrence.start, endLine: occurrence.end };
    });
    const first = related[0],
      blockHash = sha256(
        readFileSync(safePath(root, first.file), "utf8")
          .split(/\r?\n/)
          .slice(first.line - 1, first.endLine)
          .join("\n")
      );
    for (const occurrence of related) {
      findings.push(
        finding(
          "FE/DUPLICATE-CODE",
          "warning",
          occurrence.file,
          occurrence.line,
          `${block.tokens} tokens / ${block.lines}行重复代码`,
          "核对业务后提取公共逻辑，保留差异行为与回归测试",
          {
            endLine: occurrence.endLine,
            context: JSON.stringify({
              blockHash,
              relatedFiles: [...new Set(related.map((location) => location.file))].sort(),
            }),
            relatedLocations: related,
          }
        )
      );
    }
  }
  return { findings, raw, metrics: raw.statistics.total };
}

async function architecture(root, files, check, out) {
  const rules = {
    forbidden: [
      { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
      { name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
      {
        name: "no-src-to-test",
        severity: "error",
        from: { path: "^src/" },
        to: { path: "(?:^|/)(?:tests?|__tests__)/" },
      },
      {
        name: "no-infrastructure-to-page",
        severity: "error",
        from: { path: "^src/(?:api|utils|store)/" },
        to: { path: "^src/views/" },
      },
    ],
    options: {
      doNotFollow: { path: "node_modules" },
      tsPreCompilationDeps: true,
      ...(existsSync(path.join(root, "tsconfig.json"))
        ? { tsConfig: { fileName: path.join(root, "tsconfig.json") } }
        : {}),
    },
  };
  const configFile = path.join(out, "dependency-cruiser.json");
  writeFileSync(configFile, JSON.stringify(rules));
  const result = await runCommand(
    [
      process.execPath,
      path.join(packageRoot("dependency-cruiser"), "bin/dependency-cruise.mjs"),
      "--config",
      configFile,
      "--output-type",
      "json",
      ...files,
    ]
      .map(quote)
      .join(" "),
    { cwd: root, timeoutMs: check.timeoutMs || 300000 }
  );
  if (result.timedOut || ![0, 1].includes(result.code)) throw new Error(`依赖图执行失效: ${result.stderr.slice(-500)}`);
  const raw = JSON.parse(result.stdout);
  if (!Array.isArray(raw.modules) || !raw.modules.length || !Array.isArray(raw.summary?.violations))
    throw new Error("依赖图结构/覆盖失效");
  const relative = (file) => (path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join("/") : file);
  const missing = files.filter((file) => !raw.modules.some((module) => relative(module.source) === file));
  if (missing.length) throw new Error(`依赖图漏扫: ${missing.slice(0, 3).join(",")}`);
  const findings = raw.summary.violations.map((v) =>
    finding(
      `FE/ARCH/${v.rule.name}`,
      "error",
      relative(v.from),
      null,
      `${v.rule.name}: ${v.from} → ${v.to}`,
      "核对依赖路径/别名/分层，解除循环或非法引用后复扫",
      { context: JSON.stringify(v) }
    )
  );
  return { findings, raw };
}

async function secrets(root, files) {
  const { createEngine } = await import("@secretlint/node");
  const preset = fileURLToPath(import.meta.resolve("@secretlint/secretlint-rule-preset-recommend"));
  const organization = fileURLToPath(new URL("../rules/organization-secrets.js", import.meta.url));
  const engine = await createEngine({
    cwd: root,
    configFileJSON: {
      rules: [
        { id: preset, rules: [{ id: "@secretlint/secretlint-rule-filter-comments", disabled: true }] },
        { id: organization },
      ],
    },
    color: false,
    formatter: "json",
    maskSecrets: true,
  });
  const findings = [],
    raw = [];
  for (const file of files) {
    const result = await engine.executeOnContent({
      filePath: safePath(root, file),
      content: readFileSync(safePath(root, file), "utf8"),
    });
    const results = JSON.parse(result.output);
    if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(results[0].messages))
      throw new Error("Secretlint结果失效");
    const messages = results
      .flatMap((x) => x.messages)
      .map((message) => ({
        ...message,
        ruleId: message.ruleId === organization ? "wl/feishu-webhook" : message.ruleId,
      }));
    raw.push({
      file,
      messages: messages.map((m) => ({ ruleId: m.ruleId, line: m.loc?.start?.line || m.line || null })),
    });
    for (const m of messages)
      findings.push(
        finding(
          `SEC/SECRET/${m.ruleId}`,
          "error",
          file,
          m.loc?.start?.line || m.line || null,
          "发现疑似凭据；已隐藏内容",
          "确认并撤销泄露凭据，改用受控密钥引用；移除文本不能代替轮换"
        )
      );
  }
  return { findings, raw };
}

async function dependencyAudit(root, check, licenses = false) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const npmLock = existsSync(path.join(root, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json";
  const manager = /^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager || "")
    ? "pnpm"
    : existsSync(path.join(root, npmLock))
      ? "npm"
      : null;
  if (!manager) throw new Error("依赖检查需要固定pnpm与锁或npm package-lock");
  if (!existsSync(path.join(root, manager === "pnpm" ? "pnpm-lock.yaml" : npmLock)))
    throw new Error("项目缺少对应固定依赖锁，拒绝用未锁定依赖审计");
  const version = await runCommand(`${quote(manager)} --version`, { cwd: root, timeoutMs: 30000 });
  if (version.code !== 0 || (manager === "pnpm" && `${manager}@${version.stdout.trim()}` !== pkg.packageManager))
    throw new Error("实际包管理器版本与项目固定版本不符");
  if (licenses && manager === "npm") {
    const tree = await runCommand("npm ls --all --json", { cwd: root, timeoutMs: check.timeoutMs || 180000 });
    if (tree.code !== 0 || tree.timedOut || tree.truncated)
      throw new Error("npm依赖树不完整；先按固定锁安装，不使用缺失依赖的许可证清单");
    const parsed = JSON.parse(tree.stdout);
    if (parsed.problems?.length || parsed.error) throw new Error("npm依赖树含缺失/非法依赖");
  }
  const args = licenses
    ? manager === "pnpm"
      ? ["licenses", "list", "--json"]
      : ["query", "*", "--json"]
    : ["audit", "--json"];
  const response = await runCommand([manager, ...args].map(quote).join(" "), {
    cwd: root,
    timeoutMs: check.timeoutMs || 180000,
  });
  if (response.timedOut || response.truncated || ![0, 1].includes(response.code))
    throw new Error("依赖/许可证原生作业失效（网络、安装或工具错误）");
  if (licenses && response.code !== 0) throw new Error("许可证清单生产失败");
  let raw = JSON.parse(response.stdout);
  if (licenses && manager === "npm") {
    if (!Array.isArray(raw) || !raw.length) throw new Error("npm许可证清单为空/非法");
    const groups = {};
    const seen = new Set();
    for (const p of raw) {
      if (p.location === "") continue; // the project itself is not a third-party dependency
      if (
        typeof p.name !== "string" ||
        typeof p.version !== "string" ||
        typeof p.location !== "string" ||
        !p.location.startsWith("node_modules/") ||
        seen.has(p.location) ||
        p.missing ||
        p.invalid
      )
        throw new Error("npm许可证依赖身份/位置非法");
      seen.add(p.location);
      const license =
        typeof p.license === "string" && p.license
          ? p.license
          : typeof p.license?.type === "string"
            ? p.license.type
            : "UNKNOWN";
      (groups[license] ||= []).push({ name: p.name, version: p.version, location: p.location });
    }
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
      (name) => !Object.hasOwn(pkg.optionalDependencies || {}, name)
    );
    if (!declared.length || declared.some((name) => !seen.has(`node_modules/${name}`)))
      throw new Error("npm许可证输入未覆盖全部直接依赖");
    raw = { ...groups };
  }
  if (raw.error || raw.errors?.length) throw new Error("依赖作业返回错误，不能当作零风险");
  const findings = [];
  if (licenses) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.keys(raw).length)
      throw new Error("许可证结果为空/结构非法");
    for (const [license, packages] of Object.entries(raw)) {
      if (
        !Array.isArray(packages) ||
        !packages.length ||
        packages.some(
          (p) =>
            !p ||
            typeof p.name !== "string" ||
            !p.name ||
            !(
              (typeof p.version === "string" && !!p.version) ||
              (Array.isArray(p.versions) &&
                p.versions.length > 0 &&
                p.versions.every((v) => typeof v === "string" && !!v))
            )
        )
      )
        throw new Error("许可证包清单非法");
      if (
        !(
          check.allowedLicenses || [
            "MIT",
            "ISC",
            "BSD-2-Clause",
            "BSD-3-Clause",
            "Apache-2.0",
            "0BSD",
            "CC0-1.0",
            "Unlicense",
          ]
        ).includes(license)
      ) {
        for (const p of packages)
          findings.push(
            finding(
              "FE/DEPENDENCY-LICENSE-REVIEW",
              "warning",
              "package.json",
              null,
              `${p.name}@${p.version || p.versions.join(",")} 许可证 ${license}待批准`,
              "交负责人核对实际用途与许可证政策，批准或替换；不自动修改依赖"
            )
          );
      }
    }
  } else {
    const advisories = raw.advisories
      ? Object.values(raw.advisories)
      : raw.vulnerabilities
        ? Object.values(raw.vulnerabilities)
        : null;
    if (!advisories || !raw.metadata?.vulnerabilities) throw new Error("漏洞数据/查询完整性统计缺失");
    const counts = raw.metadata.vulnerabilities;
    for (const level of ["critical", "high", "moderate", "low", "info"]) {
      if (
        !Number.isInteger(counts[level]) ||
        counts[level] < 0 ||
        (counts[level] > 0 && !advisories.some((v) => v.severity === level)) ||
        (counts[level] === 0 && advisories.some((v) => v.severity === level))
      )
        throw new Error("漏洞元数据与实际公告不一致，不能以空清单放行");
    }
    if (response.code !== 0 && !advisories.length) throw new Error("漏洞作业非零退出却无公告证据");
    for (const v of advisories) {
      if (!["critical", "high", "moderate", "low", "info"].includes(v.severity)) throw new Error("漏洞严重性缺失");
      findings.push(
        finding(
          `SEC/DEPENDENCY/${v.id || v.name || v.module_name}`,
          ["critical", "high"].includes(v.severity) ? "error" : "warning",
          manager === "pnpm" ? "pnpm-lock.yaml" : npmLock,
          null,
          `${v.module_name || v.name}: ${v.title || v.severity}`,
          "按公告核对实际调用与修复版本；生成升级计划，确认后更新锁并执行回归",
          { context: JSON.stringify(v) }
        )
      );
    }
  }
  return {
    findings,
    raw,
    metrics: {
      manager,
      managerVersion: version.stdout.trim(),
      queriedAt: new Date().toISOString(),
      licenseInventory: licenses,
    },
  };
}

export async function analyzeFrontendInline({ root, files, analyzer }) {
  return analyzer === "secrets" ? secrets(root, files) : lint(root, files, analyzer);
}

function isolatedAnalysis({ root, files, analyzer, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    let delivered = false;
    const worker = new Worker(new URL("../frontend-worker.js", import.meta.url), {
      workerData: { root, files, analyzer },
      execArgv: [],
      stdout: true,
      stderr: true,
      env: { ...process.env, DEBUG: "", NODE_OPTIONS: "" },
      resourceLimits: { maxOldGenerationSizeMb: 2048 },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("前端分析超时，已终止隔离执行器；不得当作通过"));
    }, timeoutMs);
    worker.once("message", (message) => {
      delivered = true;
      clearTimeout(timer);
      worker.terminate();
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      if (!delivered) reject(new Error("前端分析器异常退出、未返回结果或资源不足"));
    });
  });
}

export async function run(check, ctx) {
  try {
    const incremental = ctx.scope === "staged" && ["security", "secrets"].includes(check.analyzer);
    if ((ctx.scope || ctx.base) && !incremental) throw new Error("前端完整原生检查须使用完整批准范围");
    for (const name of dependencies[check.analyzer] || []) packageRoot(name);
    const targets =
      check.targets ||
      (check.analyzer === "secrets"
        ? ["."]
        : check.analyzer === "security"
          ? ["src", "scripts", "vite", "vite.config.ts", "vite.config.js", "webpack.config.js"].filter((file) =>
              existsSync(path.join(ctx.root, file))
            )
          : ["src"]);
    let inventory = incremental
      ? git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--"], ctx.root).split("\0").filter(Boolean)
      : ["dependencies", "licenses"].includes(check.analyzer)
        ? [
            existsSync(path.join(ctx.root, "pnpm-lock.yaml"))
              ? "pnpm-lock.yaml"
              : existsSync(path.join(ctx.root, "npm-shrinkwrap.json"))
                ? "npm-shrinkwrap.json"
                : "package-lock.json",
          ]
        : ctx.sourceFiles instanceof Set
          ? [...ctx.sourceFiles]
              .filter(
                (file) =>
                  existsSync(path.join(ctx.root, file)) &&
                  targets.some((target) => target === "." || file === target || file.startsWith(target + "/"))
              )
              .sort()
          : frontendFiles(ctx.root, targets);
    if (!incremental && ctx.sourceFiles instanceof Set && !["dependencies", "licenses"].includes(check.analyzer)) {
      inventory.forEach((file) => safePath(ctx.root, file));
    }
    if (incremental && inventory.length) {
      const changed = git(["diff", "--name-only", "-z", "--", ...inventory], ctx.root)
        .split("\0")
        .filter(Boolean);
      if (changed.length) throw new Error("暂存文件含未暂存修改，拒绝扫描工作区代替暂存内容");
      inventory.forEach((file) => safePath(ctx.root, file));
    }
    const files = ["typed", "security", "duplicates", "architecture"].includes(check.analyzer)
      ? inventory.filter((x) => code.test(x))
      : inventory;
    if (!files.length && incremental)
      return {
        status: "ok",
        findings: [],
        toolVersion: frontendVersion(check.analyzer),
        toolVersionVerified: true,
        coverage: {
          mode: "staged",
          complete: true,
          requestedFiles: [],
          scannedFiles: [],
          scannedFileCount: 0,
          noApplicableFiles: true,
        },
      };
    if (!files.length) throw new Error("前端分析器输入为零");
    const out = safePath(ctx.root, `quality-reports/frontend/${ctx.eventId}/${check.id}`);
    const report = path.join(out, "native.json");
    assertReportOutput(report, ctx);
    mkdirSync(out, { recursive: true });
    const result = ["typed", "security", "secrets"].includes(check.analyzer)
      ? await isolatedAnalysis({
          root: ctx.root,
          files,
          analyzer: check.analyzer,
          timeoutMs: check.timeoutMs || 300000,
        })
      : check.analyzer === "duplicates"
        ? await duplicate(ctx.root, files, out, check)
        : check.analyzer === "architecture"
          ? await architecture(ctx.root, files, check, out)
          : await dependencyAudit(ctx.root, check, check.analyzer === "licenses");
    writeFileSync(
      report,
      JSON.stringify({ schemaVersion: 1, analyzer: check.analyzer, files, native: result.raw }, null, 2)
    );
    const reports = bindProducedReports([report], ctx);
    return {
      ...parseFindingsPayload({ findings: result.findings }, "前端原生检查", check, ctx),
      toolVersion: frontendVersion(check.analyzer),
      toolVersionVerified: true,
      production: {
        eventId: ctx.eventId,
        commitSha: ctx.commitSha,
        sourceDigest: ctx.sourceDigest,
        reports,
        reused: false,
      },
      metrics: result.metrics || null,
      coverage: {
        mode: incremental ? "staged" : "full",
        complete: true,
        requestedFiles: files,
        scannedFiles: files,
        scannedFileCount: files.length,
        targets,
        ignoredDirectories: [...ignored],
        analyzer: check.analyzer,
        ...(check.analyzer === "duplicates"
          ? {
              minimumTokens: check.minimumTokens ?? 100,
              effectiveSources: result.metrics.sources,
              note: "固定原生工具接收全部登记文件；低于原生token/行阈值的文件不参与重复匹配，effectiveSources保留原生口径",
            }
          : {}),
      },
    };
  } catch (error) {
    return { status: "invalid", reason: `前端${check.analyzer}检查失效: ${error.message}` };
  }
}
