import path from "node:path";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { safePath } from "./source-state.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const registryVersion = (value) => typeof value === "string" && value.length > 0 && value.length <= 512
  && (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value) || /^[~^<>=*v\d][0-9A-Za-z.*+_~^<>=| \t-]*$/.test(value));
function approvedUrl(value, approved) {
  let url; try { url = new URL(value); } catch { throw new Error("锁文件含无法核验的tarball地址"); }
  const registry = new URL(approved);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin !== registry.origin || !url.pathname.startsWith(registry.pathname))
    throw new Error(`锁文件tarball不在本次批准源：${url.origin}；先审阅锁迁移，不能靠--registry覆盖已有resolved地址`);
  return { origin: url.origin, path: url.pathname };
}
export function verifyLockOrigins(root, kind, approved) {
  const relative = kind === "backend" ? "quality-tools/package-lock.json" : "pnpm-lock.yaml";
  const file = safePath(root, relative);
  if (!existsSync(file)) return { path: relative, present: false, sha256: null, tarballs: [] };
  const text = readFileSync(file, "utf8"), addresses = [], localTarballs = [];
  const local = (value) => {
    const relative = path.normalize(path.join(kind === "backend" ? "quality-tools" : ".", value.slice(5)));
    const target = safePath(root, relative);
    if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error("本地tarball必须是项目内可核验的普通文件");
    localTarballs.push({ path: relative, sha256: hash(readFileSync(target)) });
  };
  if (kind === "backend") {
    const visit = (value) => { if (!value || typeof value !== "object") return;
      if (typeof value.resolved === "string") {
        if (/^https?:/.test(value.resolved)) addresses.push(value.resolved);
        else if (value.resolved.startsWith("file:")) local(value.resolved);
        else if (!value.link) throw new Error("工具锁含未批准Git/非HTTPS resolved，不自动安装");
      }
      for (const item of Object.values(value)) if (item && typeof item === "object") visit(item);
    };
    visit(JSON.parse(text));
  } else {
    // Only actual resolution fields are download locations. Deprecation prose
    // can contain unrelated documentation URLs (for example eslint.org).
    for (const match of text.matchAll(/(?:tarball|registry|resolved):\s*['"]?(https?:\/\/[^\s"'<>{},)]+)/g)) addresses.push(match[1]);
    if (/(?:tarball|resolution):\s*(?:git\+|git:|ssh:)/m.test(text)) throw new Error("前端锁含未批准Git tarball来源");
    if (/resolution:\s*\{[^}\r\n]*\b(?:repo|repository|commit):/m.test(text) || /resolution:\s*\n(?:[ \t]+[^\n]*\n){0,8}[ \t]+(?:repo|repository|commit):/m.test(text))
      throw new Error("前端锁含未批准Git/仓库解析，不通过registry覆盖它");
    for (const match of text.matchAll(/tarball:\s*['"]?(file:[^\s,'"}]+)/g)) local(match[1]);
  }
  const tarballs = [...new Set(addresses)].sort().map((url) => approvedUrl(url, approved));
  return { path: relative, present: true, sha256: hash(text), tarballs, localTarballs };
}
export function registryInstallationEvidence({ root, kind, approved, executable, manager, manifestContent, runner = spawnSync }) {
  const manifest = JSON.parse(manifestContent || readFileSync(safePath(root, kind === "backend" ? "quality-tools/package.json" : "package.json"), "utf8"));
  const dependencySources = [];
  for (const bucket of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) for (const [name, value] of Object.entries(manifest[bucket] || {})) {
    if (registryVersion(value)) { dependencySources.push({ bucket, name, source: "approved-registry", version: value }); continue; }
    if (typeof value === "string" && value.startsWith("npm:")) {
      const alias = /^npm:((?:@[^/@\s]+\/)?[^@\s/]+)(?:@(.+))?$/.exec(value);
      if (alias && registryVersion(alias[2] || "latest")) { dependencySources.push({ bucket, name, source: "approved-registry-alias", package: alias[1], version: alias[2] || "latest" }); continue; }
    }
    if (typeof value === "string" && value.startsWith("https:")) {
      const url = approvedUrl(value, approved); dependencySources.push({ bucket, name, source: "approved-registry-tarball", ...url }); continue;
    }
    if (typeof value === "string" && value.startsWith("file:") && !value.startsWith("file://") && !/[\\%?#\u0000-\u001f]/.test(value) && /\.(?:tgz|tar\.gz)$/.test(value)) {
      const relative = path.normalize(path.join(kind === "backend" ? "quality-tools" : ".", value.slice(5))), target = safePath(root, relative);
      if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error("安装清单file引用须为项目内已存在普通tarball，不能安装目录/链接/未知来源");
      dependencySources.push({ bucket, name, source: "project-tarball", path: relative, sha256: hash(readFileSync(target)) }); continue;
    }
    throw new Error(`安装清单 ${bucket}.${name} 使用未批准的Git/URL/目录或未知引用；先提供受控来源适配，不能以--registry冒充约束所有下载源`);
  }
  // Never expose config-list output: it can contain credentials. Retain registry keys only.
  const readOnlyFlags = manager === "pnpm" ? ["--config.pm-on-fail=ignore", "--config.manage-package-manager-versions=false"] : [];
  const listed = runner(executable, ["config", "list", "--json", ...readOnlyFlags, ...(kind === "backend" ? ["--prefix", "quality-tools"] : [])], { cwd: root, shell: false, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error("无法读取包管理器实际registry配置，拒绝猜测安装来源");
  let config; try { config = JSON.parse(listed.stdout || ""); } catch { throw new Error("实际registry配置不是可核验JSON"); }
  const registries = Object.fromEntries(Object.entries(config).filter(([key]) => key === "registry" || /^@[^\s:]+:registry$/.test(key)));
  const scopes = new Set(["@agile-team"]);
  for (const key of Object.keys(registries)) if (key !== "registry") scopes.add(key.slice(0, -":registry".length));
  for (const bucket of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) for (const name of Object.keys(manifest[bucket] || {})) if (name.startsWith("@") && name.includes("/")) scopes.add(name.split("/")[0]);
  for (const value of Object.values(registries)) {
    if (typeof value !== "string") throw new Error("实际registry配置值无效");
    let url; try { url = new URL(value); } catch { throw new Error("实际registry配置含不能解析的地址"); }
    if (url.username || url.password || url.search || url.hash) throw new Error("registry URL含凭据或查询参数；移至受控认证环境后再接入");
  }
  const overrides = [...scopes].sort().map((scope) => manager === "pnpm" ? `--config.${scope}:registry=${approved}` : `--${scope}:registry=${approved}`);
  // Configuration inspection may ignore PM version only to remain read-only.
  // Installation must instead reject a mismatched runtime, never download one
  // through the user's implicit package-manager registry.
  const packageManagerFlags = manager === "pnpm" ? ["--config.pm-on-fail=error", "--config.manage-package-manager-versions=false", "--config.package-manager-strict-version=true"] : [];
  const match = /\bpnpm\/(\d+\.\d+\.\d+)/.exec(config.userAgent || config["user-agent"] || "");
  return { effectiveRegistryConfiguration: registries, scopedRegistryOverrides: overrides, packageManagerFlags,
    dependencySources,
    packageManager: { expected: manifest.packageManager || null, observed: match ? `pnpm@${match[1]}` : null, installationVersionEnforced: manager === "pnpm" }, lock: verifyLockOrigins(root, kind, approved),
    acceptance: "实际scope registry纳入计划，并以CLI逐scope强制批准源；旧锁resolved预检，安装后再次核验tarball源" };
}
