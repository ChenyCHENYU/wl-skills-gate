import path from "node:path";
import { readFileSync, lstatSync } from "node:fs";
import { runCommand, quote, redactLog } from "../exec.js";
import { safePath, fileHash } from "../source-state.js";
import { javaDistribution, javaReferenceLock, JAVA_REFERENCE_VERSION } from "../java-distribution.js";
import { parseJavaReport } from "./java-xml.js";
import { parseXml } from "../xml.js";
import { parseFindingsPayload } from "../finding-input.js";
import { bindProducedReports, assertReportOutput } from "../report-selection.js";
import { sha256 } from "../util.js";

const ENGINES = ["pmd", "p3c", "checkstyle", "cpd", "ccn", "spotbugs"];
const integer = (n, min = 0) => Number.isInteger(n) && n >= min;
// Only Gate-owned repository-root outputs are reserved. Absolute anchors plus the
// trailing slash keep similarly named business directories and files in scope.
export function javaSourceExcludes(root, configured = []) {
  const anchor = path.resolve(root).split(path.sep).join("/").replace(/\/$/, "");
  if (anchor.includes(",")) throw new Error("Java固定扫描器的排除参数暂不支持含逗号的项目路径，请将工作副本放到无逗号路径");
  return [...new Set([...configured, ...["quality-reports", ".quality-onboarding-backups"].map(name => `${anchor}/${name}/`)])];
}
export function parseJavaMetrics(manifest, raw, root) {
  const rows = new Map(manifest.scope.source.files.map((row) => [row.path, row]));
  const findings = [],
    intervals = new Map();
  const file = (value, line, length) => {
    const relative = path.isAbsolute(value) ? path.relative(root, value).split(path.sep).join("/") : value;
    if (!rows.has(relative) || !integer(line, 1) || !integer(length, 1) || line + length - 1 > rows.get(relative).lines)
      throw new Error("指标包含范围外源码/行区间");
    return relative;
  };
  const cpd = parseXml(raw.cpd);
  if (cpd.name !== "pmd-cpd" || cpd.children.some((x) => !["duplication", "file"].includes(x.name)))
    throw new Error("CPD结构/分析错误");
  for (const entry of cpd.children.filter((x) => x.name === "file")) {
    const relative = path.relative(root, entry.attrs.path).split(path.sep).join("/");
    if (!rows.has(relative)) throw new Error("CPD输入清单超出批准源码");
  }
  const blocks = cpd.children.filter((x) => x.name === "duplication");
  for (const block of blocks) {
    const lines = Number(block.attrs.lines),
      tokens = Number(block.attrs.tokens);
    const locations = block.children.filter((x) => x.name === "file");
    if (!integer(lines, 1) || !integer(tokens, 100) || locations.length < 2) throw new Error("CPD缺少有效重复块/位置");
    const related = locations.map((location) => {
      const decimal=value=>{if(typeof value!=="string"||!(/^[1-9][0-9]*$/).test(value))throw Error("CPD行位置须为合法正整数");return Number(value);};
      const line=decimal(location.attrs.line);
      const endLine=Object.hasOwn(location.attrs,"endline")?decimal(location.attrs.endline):line+lines-1;
      return {file:file(location.attrs.path,line,endLine-line+1),line,endLine};
    });
    const fragments = block.children.filter((child) => child.name === "codefragment");
    if (fragments.length !== 1 || !fragments[0].text.trim())
      throw new Error("CPD缺少可核验的重复片段，不能仅凭位置生成发现");
    const blockHash = sha256(fragments[0].text);
    for (const location of related) {
      const ranges = intervals.get(location.file) || [];
      ranges.push([location.line, location.endLine]);
      intervals.set(location.file, ranges);
      findings.push({
        ruleId: "CPD/DUPLICATE-CODE",
        severity: "warning",
        ...location,
        message: `${tokens} tokens / ${lines}行重复代码；共${related.length}处`,
        suggestion: "核对业务边界，提取公共逻辑并保留各场景回归；不自动合并业务代码",
        context: JSON.stringify({
          engine: "CPD",
          version: "6.55.0",
          tokens,
          blockHash,
          relatedFiles: [...new Set(related.map((location) => location.file))].sort(),
        }),
        relatedLocations: related,
      });
    }
  }
  let duplicateLines = 0;
  for (const ranges of intervals.values()) {
    let end = 0;
    for (const [start, stop] of ranges.sort((a, b) => a[0] - b[0])) {
      duplicateLines += Math.max(0, stop - Math.max(end, start - 1));
      end = Math.max(end, stop);
    }
  }
  const ccn = JSON.parse(raw.ccn);
  if (
    !integer(ccn.total_functions) ||
    !integer(ccn.risky_count) ||
    ccn.analysisErrors !== 0 ||
    ccn.analyzedFiles !== rows.size ||
    !Array.isArray(ccn.risky) ||
    ccn.risky_count !== ccn.risky.length ||
    ccn.risky_count > ccn.total_functions ||
    !Number.isFinite(ccn.avg_ccn)
  )
    throw new Error("CCN统计不完整/失效");
  for (const fn of ccn.risky) {
    if (!integer(fn.ccn, 16) || typeof fn.func !== "string" || !fn.func.trim() || !integer(fn.end, fn.start))
      throw new Error("CCN函数统计非法");
    findings.push({
      ruleId: "CCN/COMPLEX-FUNCTION",
      severity: "warning",
      file: file(fn.file, fn.start, fn.end - fn.start + 1),
      line: fn.start,
      endLine: fn.end,
      message: `${fn.func} CCN=${fn.ccn}（阈值15）`,
      suggestion: "先补分支回归，再按职责拆分；不能机械改写业务分支",
      context: JSON.stringify({ engine: "lizard", version: "1.24.1", complexity: fn.ccn, function: fn.func }),
    });
  }
  return {
    findings,
    metrics: {
      duplicateBlocks: blocks.length,
      duplicateLines,
      totalLines: manifest.scope.source.lineCount,
      duplicatePercent: manifest.scope.source.lineCount
        ? Number(((100 * duplicateLines) / manifest.scope.source.lineCount).toFixed(2))
        : 0,
      functions: ccn.total_functions,
      averageCcn: ccn.avg_ccn,
      riskyFunctions: ccn.risky_count,
    },
  };
}

export async function run(check, ctx) {
  try {
    if (ctx.scope || ctx.base) throw new Error("完整Java参考检查必须使用完整批准范围");
    const planBytes = readFileSync(safePath(ctx.root, check.plan));
    if (check.planHash && sha256(planBytes) !== check.planHash) throw new Error("Java计划与批准planHash不符");
    const plan = JSON.parse(planBytes);
    if (
      plan.schemaVersion !== 1 ||
      !Array.isArray(plan.modules) ||
      !plan.modules.length ||
      plan.modules.some(
        (x) =>
          typeof x !== "string" ||
          !x ||
          x.includes(",") ||
          (x !== "." && (path.isAbsolute(x) || x.split("/").some((p) => !p || p === "." || p === "..")))
      ) ||
      new Set(plan.modules).size !== plan.modules.length
    )
      throw new Error("Java参考计划必须登记无重复的精确模块");
    if (!Array.isArray(plan.excludes) || plan.excludes.some((x) => typeof x !== "string" || !x || x.includes(",")))
      throw new Error("Java排除范围必须显式登记");
    const python = plan.python || "python3",
      distribution = await javaDistribution({ python });
    const outputRelative = `quality-reports/java-reference/${ctx.eventId}`;
    const output = safePath(ctx.root, outputRelative);
    assertReportOutput(path.join(output, "scan-manifest.json"), ctx);
    const execute = async (script, args) => {
      const command = [
        python,
        "-B",
        "-X",
        `pycache_prefix=${path.join(output, "python-cache")}`,
        path.join(distribution.home, "scripts", script),
        "--repo",
        ctx.root,
        "--out",
        output,
        ...args,
      ]
        .map(quote)
        .join(" ");
      const r = await runCommand(command, {
        cwd: ctx.root,
        timeoutMs: check.timeoutMs || 1200000,
        env: { ...process.env, PYTHONPATH: "", PYTHONSAFEPATH: "" },
      });
      if (r.code !== 0 || r.timedOut || r.truncated)
        throw new Error(`${script}失效: ${redactLog(r.stderr || r.stdout).slice(-800)}`);
    };
    // Build and analyzer runtimes can differ (for example Java 8 + Java 21).
    // An explicit approved plan wins; deployment environment fills only omissions.
    const scanJdk = plan.scanJdk || process.env.WL_SCAN_JAVA_HOME;
    const buildJdk = plan.buildJdk || process.env.WL_BUILD_JAVA_HOME;
    const common = ["--exclude", javaSourceExcludes(ctx.root, plan.excludes).join(","), ...(scanJdk ? ["--java", scanJdk] : [])];
    await execute("scan.py", [...common, "--no-report"]);
    await execute("spotbugs.py", [
      ...common,
      "--modules",
      plan.modules.join(","),
      ...(buildJdk ? ["--build-jdk", buildJdk] : []),
      ...(plan.maven ? ["--mvn", plan.maven] : []),
      ...(plan.settings ? ["--settings", safePath(ctx.root, plan.settings)] : []),
      ...(plan.online === true ? ["--online"] : []),
    ]);
    await execute("make_report.py", []);
    // Revalidate distribution after execution as well as before it.
    await javaDistribution({ python });
    const manifestFile = path.join(output, "scan-manifest.json"),
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.kitVersion !== "1.1.0" ||
      manifest.repo !== ctx.root ||
      manifest.status !== "complete" ||
      !manifest.scanComplete ||
      manifest.report.status !== "complete" ||
      !manifest.scope.source.fileCount
    )
      throw new Error("Java执行清单未完整成功");
    const consumed = [manifestFile];
    for (const engine of ENGINES) {
      const state = manifest.tools[engine];
      if (
        state?.status !== "complete" ||
        state.analysisErrors !== 0 ||
        state.identity?.distributionVersion !== javaReferenceLock().engines[engine]
      )
        throw new Error(`Java必需分析器缺失/版本不符: ${engine}`);
      for (const artifact of state.artifacts || []) {
        const absolute = safePath(ctx.root, `${outputRelative}/${artifact.file}`);
        if (!lstatSync(absolute).isFile() || fileHash(absolute) !== artifact.sha256)
          throw new Error(`Java原件失效: ${engine}`);
        consumed.push(absolute);
      }
      if (!state.artifacts?.length) throw new Error(`Java原件缺失: ${engine}`);
    }
    for (const artifact of manifest.report.artifacts || []) {
      const absolute = safePath(ctx.root, `${outputRelative}/${artifact.file}`);
      if (fileHash(absolute) !== artifact.sha256) throw new Error("Java展示报告摘要不匹配");
      consumed.push(absolute);
    }
    const read = (name) => readFileSync(path.join(output, name), "utf8");
    const sourceRoots = plan.modules.map((module) => `${module === "." ? "" : module + "/"}src/main/java`);
    const findings = ["pmd", "p3c", "checkstyle", "spotbugs"].flatMap((engine) =>
      parseJavaReport(read(`${engine}.xml`), engine, ctx, { sourceRoots })
    );
    const measured = parseJavaMetrics(manifest, { cpd: read("cpd.xml"), ccn: read("ccn.json") }, ctx.root);
    const reports = bindProducedReports([...new Set(consumed)], ctx);
    return {
      ...parseFindingsPayload({ findings: [...findings, ...measured.findings] }, "Java完整参考扫描", check, ctx),
      toolVersion: JAVA_REFERENCE_VERSION,
      toolVersionVerified: true,
      metrics: measured.metrics,
      coverage: {
        mode: "full",
        complete: true,
        requestedFiles: null,
        scannedFiles: manifest.scope.source.files.map((x) => x.path),
        scannedFileCount: manifest.scope.source.fileCount,
        engines: ENGINES,
        distributionLock: distribution.version,
        modules: plan.modules,
        ruleSets: ENGINES.map((engine) => ({ engine, ...manifest.tools[engine].identity })),
        scope: manifest.scope,
      },
      production: {
        eventId: ctx.eventId,
        commitSha: ctx.commitSha,
        sourceDigest: ctx.sourceDigest,
        reports,
        reportHash: sha256(readFileSync(manifestFile)),
        reused: false,
      },
      note: "PMD90/P3C/Checkstyle42/SpotBugs/CPD/CCN完整执行；原生HTML/CSV保留，业务测试另验",
    };
  } catch (error) {
    return { status: "invalid", reason: `完整Java参考检查失效: ${error.message}` };
  }
}
