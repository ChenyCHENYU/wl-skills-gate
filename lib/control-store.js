import path from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const NONCE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeDurableJson(file, value) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
function lockSnapshot(lock, stateFile) {
  controlledPath(lock);
  const directory = lstatSync(lock);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("中央执行器锁不是受控真实目录，不能恢复");
  const ownerFile = path.join(lock, "owner.json");
  let metadata, raw;
  try {
    metadata = lstatSync(ownerFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384) throw new Error("invalid-owner");
    raw = readFileSync(ownerFile, "utf8");
  } catch { throw new Error("中央执行器旧锁缺少有效owner，不能猜测或删除；需受控人工核对"); }
  let owner; try { owner = JSON.parse(raw); } catch { throw new Error("中央执行器锁owner损坏，不能恢复"); }
  if (owner.schemaVersion !== 1 || owner.kind !== "central-json-lock" || owner.stateFile !== stateFile || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.hostname !== "string" || !owner.hostname || owner.hostname.length > 255 || !NONCE.test(owner.nonce || "") || !Number.isFinite(Date.parse(owner.start)))
    throw new Error("中央执行器锁owner身份损坏，不能恢复");
  return { owner, raw, dev: directory.dev, ino: directory.ino };
}
function sameLock(left, right) { return left.dev === right.dev && left.ino === right.ino && left.raw === right.raw; }
function processDefinitelyExited(owner) {
  if (owner.hostname !== hostname()) throw new Error("中央执行器锁来自其他主机，不能按本机PID或超时删除");
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code === "ESRCH") return true; throw new Error("无法证明锁owner进程已退出，拒绝恢复"); }
  throw new Error("中央执行器已有活锁；请串行执行，不能按超时强制删除");
}
function acquireLock(lock, stateFile) {
  const owner = { schemaVersion: 1, kind: "central-json-lock", stateFile, pid: process.pid, hostname: hostname(), nonce: randomUUID(), start: new Date().toISOString() };
  const pending = `${lock}.pending-${owner.nonce}`;
  mkdirSync(pending, { mode: 0o700 });
  let published = false, ownDirectory;
  try {
    writeDurableJson(path.join(pending, "owner.json"), owner); syncDirectory(pending);
    ownDirectory = lstatSync(pending);
    for (let attempt = 0; attempt < 8; attempt++) {
      let existing;
      try { existing = lockSnapshot(lock, stateFile); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!existing) {
        try { renameSync(pending, lock); published = true; syncDirectory(path.dirname(lock)); return { owner, dev: ownDirectory.dev, ino: ownDirectory.ino }; }
        catch (error) { if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) throw error; continue; }
      }
      processDefinitelyExited(existing.owner);
      let current;
      try { current = lockSnapshot(lock, stateFile); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!sameLock(existing, current)) continue;
      // Every recovery of the same old owner uses the same permanent, nonempty
      // destination. Once one worker moves it, a late rival cannot rename the
      // winner's new live lock over that destination.
      const quarantine = `${lock}.recovered-${existing.owner.nonce}`;
      controlledPath(quarantine);
      if (existsSync(quarantine)) throw new Error("同owner恢复隔离目录已存在，未移动当前锁；等待竞争执行器完成后重试");
      try { renameSync(lock, quarantine); }
      catch (error) { if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) continue; throw error; }
      const recovered = lockSnapshot(quarantine, stateFile);
      if (!sameLock(existing, recovered)) throw new Error("恢复隔离的锁inode/owner与已核对对象不同，保留证据并停止");
      syncDirectory(path.dirname(lock));
      // Never remove quarantine, even after success. It is both evidence and a
      // permanent barrier against delayed recovery workers for this old nonce.
    }
    throw new Error("中央执行器锁正在竞争变化，请串行重试；未删除其他owner的锁");
  } catch (error) {
    // A failed parent-directory sync after a successful publish must not leave
    // a live-PID lock owned by a caller that never entered the critical section.
    if (published) { try { releaseLock(lock, stateFile, { owner, dev: ownDirectory.dev, ino: ownDirectory.ino }); } catch {} }
    throw error;
  } finally { if (!published) rmSync(pending, { recursive: true, force: true }); }
}
function releaseLock(lock, stateFile, held) {
  let current;
  try { current = lockSnapshot(lock, stateFile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (current.owner.nonce !== held.owner.nonce || current.owner.pid !== held.owner.pid || current.dev !== held.dev || current.ino !== held.ino)
    throw new Error("中央执行器锁owner已变化，拒绝删除其他执行器的锁");
  rmSync(lock, { recursive: true }); syncDirectory(path.dirname(lock));
}

export function controlledPath(file) {
  if (typeof file !== "string" || !file) throw new Error("缺少受控路径");
  const full = path.resolve(file); let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (existsSync(current) || (() => { try { return !!lstatSync(current); } catch (e) { if (e.code !== "ENOENT") throw e; return false; } })()) {
      if (lstatSync(current).isSymbolicLink()) throw new Error("受控路径不能含符号链接或断链");
    }
  }
  return full;
}
export function readControlledJson(file) { return JSON.parse(readFileSync(controlledPath(file), "utf8")); }
export function writeExclusiveJson(file, value) {
  file = controlledPath(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeDurableJson(file, value); syncDirectory(path.dirname(file)); return file;
}
export function acquireControlledLock(lockFile, stateFile = lockFile) {
  lockFile = controlledPath(lockFile); stateFile = controlledPath(stateFile);
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const held = acquireLock(lockFile, stateFile); return () => releaseLock(lockFile, stateFile, held);
}
export async function lockedJson(file, initial, change) {
  file = controlledPath(file); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + ".lock", temporary = file + "." + randomUUID() + ".tmp";
  const held = acquireLock(lock, file);
  try {
    const state = existsSync(file) ? readControlledJson(file) : structuredClone(initial);
    const checkpoint = () => { writeDurableJson(temporary, state); renameSync(temporary, file); syncDirectory(path.dirname(file)); };
    const result = await change(state, checkpoint);
    checkpoint(); return result;
  } finally { rmSync(temporary, { force: true }); releaseLock(lock, file, held); }
}
