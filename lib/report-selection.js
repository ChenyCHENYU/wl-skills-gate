import path from "node:path";
import { lstatSync, readdirSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { safePath, git, fileHash } from "./source-state.js";

// Explicit paths keep the approved report set reviewable. Globs cannot prove a
// missing module/suite existed, so they are deliberately not expanded here.
export function reportPaths(check) {
  return check.files || (check.file ? [check.file] : []);
}

export function validateReportSelection(check, root) {
  if (check.files !== undefined) {
    if (check.tool !== "junit" || check.file !== undefined || !Array.isArray(check.files) || !check.files.length) {
      throw new Error("files 仅允许 JUnit 非空显式报告数组，且与 file 互斥");
    }
    validatePaths(check.files, root, "files");
    if (!Array.isArray(check.reportDirs) || !check.reportDirs.length) throw new Error("JUnit files 必须声明 reportDirs，核验全部原始 XML 覆盖");
  }
  if (check.reportDirs !== undefined) {
    if (check.tool !== "junit" || !Array.isArray(check.reportDirs) || !check.reportDirs.length) throw new Error("reportDirs 仅允许 JUnit 非空显式目录数组");
    validatePaths(check.reportDirs, root, "reportDirs");
    const directories = new Set(check.reportDirs.map((p) => path.resolve(root, p)));
    const parents = new Set(reportPaths(check).map((p) => path.dirname(safePath(root, p))));
    if (!parents.size || directories.size !== parents.size || [...parents].some((p) => !directories.has(p))) {
      throw new Error("reportDirs 必须准确列出每份 JUnit 报告的直接父目录，不允许遗漏或扩大范围");
    }
    for (const file of reportPaths(check)) if (!file.endsWith(".xml")) throw new Error("reportDirs 内 JUnit 报告必须为 .xml 文件");
  }
  for (const field of ["requiredTests", "requiredSuites"]) {
    if (check[field] !== undefined && (check.tool !== "junit" || !Array.isArray(check[field]) ||
      check[field].some((id) => typeof id !== "string" || !id.trim()) || new Set(check[field]).size !== check[field].length)) {
      throw new Error(`${field} 仅允许 JUnit 无重复的字符串数组`);
    }
  }
  if (check.tool === "junit" && !reportPaths(check).length) throw new Error("JUnit 必须声明 file 或 files");
}

function validatePaths(paths, root, field) {
  const normalized = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim() || /[*?{}\[\]]/.test(p) || p.includes("\\") || p.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`${field} 必须为项目内无 glob/越界的显式相对路径`);
    }
    normalized.push(safePath(root, p));
  }
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} 不允许重复或路径别名`);
}

export function reportInventory(check, ctx) {
  const found = [];
  for (const dir of check.reportDirs || []) {
    const base = safePath(ctx.root, dir);
    let stat;
    try { stat = lstatSync(base); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    if (!stat.isDirectory()) throw new Error(`报告目录不是普通目录: ${dir}`);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`报告目录不允许符号链接: ${relative}`);
      // Surefire emits flat XML. Nested XML inventories need a separately
      // approved direct directory, rather than silently expanding the scope.
      if (entry.isDirectory()) throw new Error(`报告目录含未登记子目录: ${relative}`);
      if (!entry.name.endsWith(".xml")) continue;
      const file = safePath(ctx.root, relative);
      if (!lstatSync(file).isFile()) throw new Error(`报告不是普通文件: ${relative}`);
      found.push(file);
    }
  }
  return found.sort();
}

export function validateReportInventory(check, ctx) {
  if (!check.reportDirs) return;
  const expected = reportPaths(check).map((p) => safePath(ctx.root, p)).sort();
  const actual = reportInventory(check, ctx);
  if (expected.length !== actual.length || expected.some((p, i) => p !== actual[i])) {
    throw new Error("JUnit 报告全集与 files/reportDirs 不一致（缺失或存在未登记原始 XML）");
  }
}

function trackedFiles(ctx) {
  if (!ctx.trackedFiles) {
    try { ctx.trackedFiles = new Set(git(["ls-files", "-z"], ctx.root).split("\0").filter(Boolean)); }
    catch { ctx.trackedFiles = new Set(); }
  }
  return ctx.trackedFiles;
}

export function assertReportOutput(file, ctx) {
  const relative = path.relative(ctx.root, file).split(path.sep).join("/");
  safePath(ctx.root, relative);
  if (trackedFiles(ctx).has(relative)) throw new Error(`报告输出覆盖已跟踪源码: ${relative}`);
  if (ctx.sourceFiles?.has(relative)) throw new Error(`报告输出覆盖本轮源码快照: ${relative}；请改用独立生成目录`);
  try { if (!lstatSync(file).isFile()) throw new Error(`报告输出不是普通文件: ${relative}`); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}

export function cleanReportOutputs(checks, ctx) {
  const files = [...new Set(checks.flatMap((c) => [
    ...reportPaths(c).map((p) => safePath(ctx.root, p)), ...reportInventory(c, ctx),
  ]))];
  // Preflight all paths before deleting anything; a bad last module must not
  // partially delete approved input files in an earlier module.
  for (const file of files) assertReportOutput(file, ctx);
  for (const file of files) { rmSync(file, { force: true }); mkdirSync(path.dirname(file), { recursive: true }); }
}

export function bindProducedReports(files, ctx) {
  const reports = files.map((file) => {
    assertReportOutput(file, ctx);
    if (!lstatSync(file).isFile()) throw new Error("生产报告不是普通文件");
    return { file: path.relative(ctx.root, file).split(path.sep).join("/"), sha256: fileHash(file) };
  });
  ctx.producedReports ||= new Map();
  for (const report of reports) ctx.producedReports.set(report.file, report.sha256);
  return reports;
}

export function verifyProducedReports(ctx) {
  for (const [relative, hash] of ctx.producedReports || []) {
    const file = safePath(ctx.root, relative);
    if (!lstatSync(file).isFile() || fileHash(file) !== hash) throw new Error(`已消费报告在本轮完成前发生变化: ${relative}`);
  }
}

export function readReportContent(file, ctx) {
  const relative = path.relative(ctx.root, file).split(path.sep).join("/");
  safePath(ctx.root, relative);
  try { if (!lstatSync(file).isFile()) throw new Error("摄入报告不是普通文件"); }
  catch (e) { if (e.code === "ENOENT") throw new Error(`结果文件缺失: ${relative}`); throw e; }
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = ctx.producedReports?.get(relative);
  if (expected && expected !== sha256) throw new Error(`生产报告在解析前发生变化: ${relative}`);
  return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), sha256 };
}
