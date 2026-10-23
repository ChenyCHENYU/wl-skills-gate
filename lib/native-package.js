import path from "node:path";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { sha256, stableStringify } from "./util.js";

// npm/pnpm dependencies own their nested node_modules (including .bin links).
// Bind only the native package's shipped files here. The approved lock/source
// checks separately bind dependency installation; artifactDigest stays strict.
export function nativePackageDigest(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("原生包根必须是真实目录，不能为符号链接");
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!relative && entry.name === "node_modules") continue;
      const file = path.join(directory, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("原生包自有文件不能含符号链接");
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) entries.push([name, sha256(readFileSync(file)), lstatSync(file).mode & 0o777]);
      else throw new Error("原生包自有文件包含特殊文件");
    }
  };
  visit(root);
  if (!entries.length) throw new Error("原生包自有文件为空");
  return sha256(stableStringify(entries));
}
