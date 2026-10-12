import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { sha256, stableStringify } from "./util.js";

export const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IGNORED = new Set([".git", "node_modules", "quality-reports", "target", "dist", "coverage"]);

export function git(args, root) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} 失败: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
  return args.includes("-z") ? r.stdout : r.stdout.trim();
}

export function actualSha(root) {
  try { return git(["rev-parse", "--verify", "HEAD"], root); } catch { return "unknown"; }
}

export function safePath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`必须使用项目内相对路径: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`路径越出项目: ${relative}`);
  let current = path.resolve(root);
  for (const part of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (info?.isSymbolicLink()) throw new Error(`不允许符号链接路径: ${relative}`);
  }
  return resolved;
}

export function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walk(root, dir = "", result = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, rel, result);
    else result.push(rel);
  }
  return result;
}

export function snapshotSource(root, { allFiles = false, exclude = [] } = {}) {
  const sha = actualSha(root);
  let untracked = [];
  let files;
  let tracked = new Set();
  if (sha !== "unknown") {
    const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error("无法列出已跟踪文件");
    tracked = new Set(r.stdout.split("\0").filter(Boolean));
    files = allFiles ? [...new Set([...walk(root), ...tracked])] : [...tracked];
    const others = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
    if (others.status !== 0) throw new Error("无法核验未跟踪文件");
    untracked = others.stdout.split("\0").filter(Boolean)
      .filter((rel) => !rel.split("/").some((p) => IGNORED.has(p)) && !exclude.some((p) => rel === p || rel.startsWith(`${p}/`)));
    if (!allFiles) files.push(...untracked);
  } else files = walk(root);
  const entries = {};
  for (const rel of files.sort()) {
    // Generated/untracked directories may be excluded. Tracked content is always
    // part of the approved source, even when its name is dist/target/coverage.
    if (!tracked.has(rel) && (exclude.some((p) => rel === p || rel.startsWith(`${p}/`)) || rel.split(path.sep).some((p) => IGNORED.has(p)))) continue;
    const file = path.join(root, rel);
    let stat;
    try { stat = lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; entries[rel] = { missing: true }; continue; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`源码包含非普通文件（目录/submodule/特殊文件需独立接线）: ${rel}`);
    if (stat.isFile()) safePath(root, rel);
    entries[rel] = stat.isSymbolicLink()
      ? { link: readlinkSync(file) }
      : { hash: fileHash(file), mode: stat.mode & 0o777 };
  }
  const dirty = sha === "unknown" || untracked.length > 0 || git(["diff", "--name-only", "-z", "HEAD", "--"], root).length > 0;
  return { sha, dirty, entries, digest: sha256(stableStringify(entries)) };
}

export function artifactDigest(file) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error("制品不能为符号链接");
  if (stat.isFile()) return fileHash(file);
  if (!stat.isDirectory()) throw new Error("制品必须是文件或目录");
  const entries = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("制品目录不能含符号链接");
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile()) entries.push([path.relative(file, p).split(path.sep).join("/"), fileHash(p), lstatSync(p).mode & 0o777]);
      else throw new Error("制品包含特殊文件");
    }
  };
  visit(file);
  if (!entries.length) throw new Error("制品目录为空");
  return sha256(stableStringify(entries));
}
