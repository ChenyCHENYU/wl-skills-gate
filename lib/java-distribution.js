import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { runCommand, quote } from "./exec.js";
import { sha256 } from "./util.js";

export const JAVA_REFERENCE_LOCK_FILE = fileURLToPath(new URL("../assets/java-reference.lock.json", import.meta.url));
export const JAVA_REFERENCE_VERSION =
  "code-scan-kit@1.1.0:5b18541f18e80349d30b66a3c48f97be4973dfde671da296b1d00abeb8428c8e";
export function javaReferenceLock() {
  const bytes = readFileSync(JAVA_REFERENCE_LOCK_FILE);
  if (sha256(bytes) !== JAVA_REFERENCE_VERSION.split(":")[1]) throw new Error("Gate固定Java分发锁已被替换");
  return JSON.parse(bytes);
}
const installer = fileURLToPath(new URL("../scripts/java-distribution.py", import.meta.url));
export function javaDistributionHome(env = process.env) {
  const home = path.resolve(
    env.WL_JAVA_SCAN_HOME ||
      path.join(
        env.WL_QUALITY_CACHE || path.join(homedir(), ".cache", "wl-quality"),
        "java",
        JAVA_REFERENCE_VERSION.split(":")[1]
      )
  );
  // An approved incremental install can retain a legacy node's stable HOME.
  // Only this version's exact lock selects a prepared child snapshot. Selection
  // never replaces verification: javaDistribution still checks every byte.
  const prepared = path.join(home, ".wl-releases", JAVA_REFERENCE_VERSION.split(":")[1]);
  return env.WL_JAVA_SCAN_HOME && existsSync(prepared) ? prepared : home;
}

// Installation uses a preapproved offline archive or existing fixed mirror.
// No download, lifecycle hooks or unpinned analyzer discovery during a scan.
export async function javaDistribution({ python, env = process.env } = {}) {
  python ||= env.WL_QUALITY_PYTHON || "python3";
  javaReferenceLock();
  const home = javaDistributionHome(env);
  const archive = env.WL_JAVA_SCAN_ARCHIVE;
  const action = existsSync(home) ? "verify" : archive ? "install" : null;
  if (!action)
    throw new Error(
      "完整Java分析器未准备：运维设置WL_JAVA_SCAN_ARCHIVE指向固定离线ZIP，或WL_JAVA_SCAN_HOME指向固定分发目录；Gate自动安装/核验，不允许跳过"
    );
  const command = [
    python,
    installer,
    action,
    "--directory",
    home,
    ...(archive && action === "install" ? ["--archive", archive] : []),
  ]
    .map(quote)
    .join(" ");
  const result = await runCommand(command, { timeoutMs: 180000, env });
  if (result.code !== 0 || result.timedOut || result.truncated)
    throw new Error("Java分发完整性核验/自动安装失败；固定文件缺失、被改或Python不可用，不能生成通过结果");
  return { home, version: JAVA_REFERENCE_VERSION };
}
