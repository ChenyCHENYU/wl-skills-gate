import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { doctor } from "../../lib/doctor.js";
import { git } from "../../lib/source-state.js";

const gateVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
function fixture(t, kind = "frontend") {
  const root = mkdtempSync(path.join(tmpdir(), "wl-gate-doctor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value)); };
  const prefix = kind === "frontend" ? "" : "quality-tools/";
  const names = kind === "frontend" ? { gate: gateVersion, kit: "2.33.0", ui: "1.22.0" } : { gate: gateVersion, bd: "0.41.0" };
  const pkg = { packageManager: "pnpm@10.34.5", engines: { node: ">=22.0.0" }, devDependencies: {
    ...Object.fromEntries(Object.entries(names).map(([name, version]) => [`@agile-team/wl-skills-${name}`, version])), "vue-tsc": "3.1.0",
  } };
  write(`${prefix}package.json`, pkg);
  for (const [name, version] of Object.entries(names)) write(`${prefix}node_modules/@agile-team/wl-skills-${name}/package.json`, { name: `@agile-team/wl-skills-${name}`, version });
  write(kind === "frontend" ? "pnpm-lock.yaml" : "quality-tools/package-lock.json", kind === "frontend" ? "lockfileVersion: '9.0'\n" : { lockfileVersion: 3 });
  write(kind === "frontend" ? ".wl-skills/copilot-instructions-full.md" : ".wl-skills-bd/capabilities.json", kind === "frontend" ? "fixture assets" : { schemaVersion: 2 });
  const policy = { schemaVersion: 1, project: "doctor-fixture", releaseRequires: ["CHECK"], checks: [{
    id: "CHECK", tool: "cmd-json", command: "node forbidden.mjs", versionCommand: "node forbidden.mjs", profiles: ["standard", "release"],
  }] };
  write("quality/policy.json", policy); write("quality/rules.lock.json", { "wl-skills-gate": gateVersion, tools: { CHECK: "fixture@1" } });
  write("forbidden.mjs", "throw new Error('doctor must never run project commands');");
  if (kind === "backend") write("pom.xml", '<project><profiles><profile><id>wl-quality-audit</id></profile><profile><id>wl-quality-unit</id></profile></profiles></project>');
  git(["init", "-q"], root); git(["config", "user.name", "fixture"], root); git(["config", "user.email", "fixture@example.invalid"], root); git(["add", "."], root); git(["commit", "-qm", "fixture"], root);
  return { root, write, pkg, policy, prefix };
}
function files(root, dir = "", all = {}) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) files(root, rel, all); else all[rel] = readFileSync(path.join(root, rel)).toString("base64");
  }
  return all;
}

for (const kind of ["frontend", "backend"]) test(`doctor ${kind} 只读：不安装、不改源码、不执行声明命令`, (t) => {
  const { root } = fixture(t, kind); const before = files(root);
  const result = doctor({ root, kind });
  assert.equal(result.commandsExecuted, false); assert.equal(result.platformValidated, false); assert.equal(result.businessBehaviorValidated, false);
  assert.deepEqual(files(root), before); assert.equal(result.status, "ready-for-local-validation");
});

test("doctor 缺依赖锁/安装版本漂移可定位，不能显示ready", (t) => {
  const { root, write } = fixture(t);
  rmSync(path.join(root, "pnpm-lock.yaml")); write("node_modules/@agile-team/wl-skills-kit/package.json", { name: "@agile-team/wl-skills-kit", version: "2.29.0" });
  const r = doctor({ root, kind: "frontend" });
  assert.equal(r.status, "gaps"); assert.equal(r.checks.find((c) => c.id === "DEPENDENCY-LOCK").status, "gap");
  assert.equal(r.checks.find((c) => c.id === "INSTALLED-KIT").status, "gap");
});

test("doctor 不把POM注释、普通id或损坏XML当真实quality profile", (t) => {
  const { root, write } = fixture(t, "backend");
  for (const xml of [
    '<project><!-- <profile><id>wl-quality-audit</id></profile><profile><id>wl-quality-unit</id></profile> --></project>',
    '<project><repositories><repository><id>wl-quality-audit</id></repository><repository><id>wl-quality-unit</id></repository></repositories></project>',
    '<project><profile><id>wl-quality-audit</id></profile><profile><id>wl-quality-unit</id></profile>',
  ]) {
    write("pom.xml", xml); const r = doctor({ root, kind: "backend" });
    assert.equal(r.status, "gaps"); assert.ok(r.checks.some((c) => ["JAVA-AUDIT", "JAVA-UNIT", "POM-PROFILES"].includes(c.id) && c.status === "gap"));
  }
});

test("doctor 发布最低集合确实必须被release选中且为必需项", (t) => {
  const { root, write, policy } = fixture(t);
  policy.checks[0].profiles = ["standard"]; policy.checks.push({ id: "OTHER", tool: "cmd-json", command: "node forbidden.mjs", versionCommand: "node forbidden.mjs", profiles: ["release"] });
  write("quality/policy.json", policy); write("quality/rules.lock.json", { "wl-skills-gate": gateVersion, tools: { CHECK: "fixture@1", OTHER: "fixture@1" } });
  const r = doctor({ root, kind: "frontend" });
  assert.equal(r.status, "gaps"); assert.equal(r.checks.find((c) => c.id === "RELEASE").status, "gap");
});

test("doctor 项目声明不支持当前Node时必须显示gap", (t) => {
  const { root, write, pkg } = fixture(t); pkg.engines.node = ">=99.0.0"; write("package.json", pkg);
  const r = doctor({ root, kind: "frontend" });
  assert.equal(r.status, "gaps"); assert.ok(r.checks.some((c) => /NODE|ENGINES/.test(c.id) && c.status === "gap"));
});

test("doctor CLI 输出到项目外证据目录成功，项目仍只读", (t) => {
  const { root } = fixture(t);
  const evidence = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-gate-doctor-evidence-"))); t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const before = files(root), output = path.join(evidence, "doctor.json");
  const cli = fileURLToPath(new URL("../../bin/wl-skills-gate.js", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "doctor", "--root", root, "--kind", "frontend", "--out", output], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(files(root), before);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.status, "ready-for-local-validation"); assert.equal(receipt.commandsExecuted, false);
});

test("doctor CLI 拒绝项目内输出，非Git项目配置也不会被覆盖", (t) => {
  const { root } = fixture(t); rmSync(path.join(root, ".git"), { recursive: true });
  const before = files(root), cli = fileURLToPath(new URL("../../bin/wl-skills-gate.js", import.meta.url));
  for (const output of ["package.json", "quality/policy.json", "quality/new-doctor.json"]) {
    const r = spawnSync(process.execPath, [cli, "doctor", "--root", root, "--kind", "frontend", "--out", path.join(root, output)], { encoding: "utf8" });
    assert.equal(r.status, 2); assert.match(r.stderr, /--out 必须放在项目外/); assert.deepEqual(files(root), before);
  }
  const aliasDir = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-gate-root-alias-"))); t.after(() => rmSync(aliasDir, { recursive: true, force: true }));
  const alias = path.join(aliasDir, "parent"); symlinkSync(path.dirname(realpathSync(root)), alias);
  const aliasedRoot = path.join(alias, path.basename(root));
  const r = spawnSync(process.execPath, [cli, "doctor", "--root", aliasedRoot, "--kind", "frontend", "--out", path.join(realpathSync(root), "package.json")], { encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /--out 必须放在项目外/); assert.deepEqual(files(root), before);
});
