#!/usr/bin/env node
// 已接项目的新克隆入口：check 只读、不联网；init 在实际计划确认后初始化本机工作区。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");

function committed(relative) {
  const file = path.join(root, relative);
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(root + path.sep)) throw new Error(`缺少项目内已提交文件：${relative}`);
  const result = spawnSync("git", ["-C", root, "show", `HEAD:${relative}`], { shell: false });
  if (result.status !== 0 || hash(result.stdout) !== hash(readFileSync(file))) throw new Error(`${relative} 尚未提交或与 HEAD 不一致，请先由接入负责人确认接线`);
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main() {
  const action = process.argv[2] || "check";
  if (!["check", "init"].includes(action) || process.argv.length > 3) throw new Error("工作区入口仅接受 check 或 init");
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 12) throw new Error("工作区质量环境需要 Node 22.12+；请使用批准执行环境，不自动安装或切换 Node");
  const gitRoot = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", shell: false });
  if (gitRoot.status !== 0 || realpathSync(gitRoot.stdout.trim()) !== realpathSync(root)) throw new Error("初始化入口必须位于实际业务 Git 根的 scripts/quality，不支持聚合根或跨项目安装");
  const manifest = committed("quality/workspace.json");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "wl-quality-workspace" || !["frontend", "backend"].includes(manifest.projectKind)
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.gateVersion || "")
    || manifest.dependencyDirectory !== (manifest.projectKind === "backend" ? "quality-tools" : ".")) throw new Error("已接项目工作区清单无效，不能猜测安装范围");
  let registry;
  try { registry = new URL(manifest.registry); } catch { throw new Error("工作区清单没有有效批准安装源"); }
  if (registry.protocol !== "https:" || registry.username || registry.password || registry.search || registry.hash) throw new Error("批准安装源必须是无凭据的 HTTPS URL");
  const prefix = manifest.projectKind === "backend" ? "quality-tools/" : "";
  const pkg = committed(`${prefix}package.json`);
  if ((pkg.devDependencies?.["@agile-team/wl-skills-gate"] || pkg.dependencies?.["@agile-team/wl-skills-gate"]) !== manifest.gateVersion) throw new Error("Gate 固定声明与已接清单不同");
  const lock = path.join(root, manifest.projectKind === "backend" ? "quality-tools/package-lock.json" : "pnpm-lock.yaml");
  if (!existsSync(lock) || !lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink()) throw new Error("已接项目缺少普通依赖锁，请交接入负责人处理");
  const locked = spawnSync("git", ["-C", root, "show", `HEAD:${path.relative(root, lock).split(path.sep).join("/")}`], { shell: false });
  if (locked.status !== 0 || hash(locked.stdout) !== hash(readFileSync(lock))) throw new Error("依赖锁尚未提交或与 HEAD 不一致；本次不下载引导包");
  const local = path.join(root, prefix, "node_modules/@agile-team/wl-skills-gate");
  let cli;
  if (existsSync(path.join(local, "package.json"))) {
    const directory = realpathSync(local);
    if (!directory.startsWith(root + path.sep)) throw new Error("本地 Gate 在项目外，拒绝执行全局或外部链接");
    const installed = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    if (installed.name !== "@agile-team/wl-skills-gate" || installed.version !== manifest.gateVersion) throw new Error("本地 Gate 版本不符；请接入负责人提供清单指定的固定执行环境");
    cli = path.join(directory, "bin/wl-skills-gate.js");
  }
  const args = ["setup", "workspace", "--root", root, ...(action === "check" ? ["--preview", "--json"] : [])];
  let result;
  if (cli) result = spawnSync(process.execPath, [cli, ...args], { cwd: root, shell: false, stdio: "inherit" });
  else {
    if (action === "check") {
      console.error(`[quality] 工作区待初始化：缺少固定 Gate ${manifest.gateVersion}。请选择“初始化已接项目工作区”；本次只读检查不联网、不安装。`);
      return 2;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("首次初始化需要交互终端确认固定引导包；未授权，不联网、不安装");
    console.log(`[quality] 项目：${root}\n[quality] 固定引导包：@agile-team/wl-skills-gate@${manifest.gateVersion}\n[quality] 批准源：${registry.href}\n[quality] 仅获取固定引导工具；项目安装与 Hook 激活还会展示实际计划，另行确认。`);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let answer; try { answer = await terminal.question("获取上述固定引导工具？输入 1 确认，其他输入取消："); } finally { terminal.close(); }
    if (answer.trim() !== "1") { console.log("[quality] 已取消；项目未修改。"); return 0; }
    // Fixed package/version and registry only; never use latest or a global Gate.
    result = spawnSync("npx", ["--yes", "--ignore-scripts", "--registry", registry.href, `--@agile-team:registry=${registry.href}`,
      "--package", `@agile-team/wl-skills-gate@${manifest.gateVersion}`, "--", "wl-skills-gate", ...args], { cwd: root, shell: false, stdio: "inherit" });
  }
  if (result.error || result.signal) throw new Error(`工作区执行器失效：${result.error?.message || result.signal}`);
  return Number.isInteger(result.status) ? result.status : 2;
}

try { process.exitCode = await main(); } catch (error) { console.error(`[quality] ${error.message}`); process.exitCode = 2; }
