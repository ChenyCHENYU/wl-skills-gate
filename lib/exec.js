import { spawn } from "node:child_process";
import { openSync, closeSync, statSync } from "node:fs";

export function runCommand(command, { cwd, timeoutMs = 600000, env, maxOutputBytes = 8 * 1024 * 1024, stdoutFile } = {}) {
  return new Promise((resolve) => {
    let child;
    let fd;
    try {
      if (stdoutFile) fd = openSync(stdoutFile, "w", 0o600);
      child = spawn(command, { shell: true, cwd, env: env || process.env, detached: process.platform !== "win32",
        stdio: ["ignore", fd ?? "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: String(e.message), spawnError: e.message, timedOut: false });
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let outputBytes = 0;
    const kill = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      outputBytes += d.length;
      if (outputBytes > maxOutputBytes) { truncated = true; kill(); return; }
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      outputBytes += d.length;
      if (outputBytes > maxOutputBytes) { truncated = true; kill(); return; }
      stderr += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${e.message}`, spawnError: e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutFile) {
        try { truncated ||= statSync(stdoutFile).size + outputBytes > maxOutputBytes; }
        catch { truncated = true; }
      }
      resolve({ code: truncated ? null : code, stdout, stderr, spawnError: truncated ? "输出超过上限" : null, timedOut, truncated });
    });
  });
}

export function quote(file) {
  return `"${String(file).replace(/(["\\`$])/g, "\\$1")}"`;
}

export function redactLog(text, env = process.env) {
  let value = String(text || "");
  for (const [key, secret] of Object.entries(env)) {
    if (/(?:TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE_KEY|WEBHOOK)/i.test(key) && typeof secret === "string" && secret.length >= 4) value = value.split(secret).join("[REDACTED]");
  }
  return value.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:authorization\s*[:=]\s*(?:bearer\s+)?|(?:token|password|passwd|secret|_authToken)\s*[:=]\s*))[^\s,;]+/gi, "$1[REDACTED]");
}
