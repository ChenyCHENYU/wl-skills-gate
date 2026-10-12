import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export function newEventId() {
  return randomUUID();
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function exists(file) {
  return existsSync(file);
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function nowIso() {
  return new Date().toISOString();
}

export function truncate(text, max = 2000) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
