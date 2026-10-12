import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { safePath } from "./source-state.js";

// Probe only explicitly declared roots and exact report paths; never search the repository for the first name match.
export function validateJavaSourceRoots(root, sourceRoots) {
  if (!Array.isArray(sourceRoots) || !sourceRoots.length || new Set(sourceRoots).size !== sourceRoots.length) {
    throw new Error("sourceRoots 必须是非空且无重复的项目内相对目录数组");
  }
  return sourceRoots.map(relative => {
    if (typeof relative !== "string" || !relative.trim() || relative.includes("\\") || path.isAbsolute(relative)
      || /^[A-Za-z]:/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("sourceRoots 必须声明明确项目内相对目录，不能绝对路径或越界");
    }
    const absolute = safePath(root, relative);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`sourceRoots 目录不存在或不是目录: ${relative}`);
    return { relative, absolute };
  });
}

export function spotbugsSourceFile(sourcepath, root, sourceRoots) {
  const relative = typeof sourcepath === "string" ? sourcepath.replace(/\\/g, "/") : "";
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)
    || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("SpotBugs sourcepath 非法或越界");
  const roots = validateJavaSourceRoots(root, sourceRoots ?? ["src/main/java"]);
  const matches = [];
  for (const source of roots) {
    const file = `${source.relative}/${relative}`;
    const absolute = safePath(root, file);
    if (!existsSync(absolute)) continue;
    if (!statSync(absolute).isFile()) throw new Error(`SpotBugs 源定位不是普通文件: ${file}`);
    matches.push(file);
  }
  if (matches.length !== 1) throw new Error(matches.length ? `SpotBugs 源定位歧义: ${matches.join(", ")}` : `SpotBugs 源定位不存在: ${relative}`);
  return matches[0];
}
