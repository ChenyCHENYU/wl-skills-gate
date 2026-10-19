import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { run as frontend } from "../../lib/adapters/frontend.js";
import { parseJavaMetrics } from "../../lib/adapters/java-scan.js";
import { javaDistribution, javaReferenceLock } from "../../lib/java-distribution.js";
import { collect } from "../../lib/collect.js";
import { findingFingerprint } from "../../lib/fingerprint.js";
const roots = [];
function fixture(files) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wl-native-coverage-")));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}
function scan(root, analyzer, extra = {}) {
  return frontend(
    { id: analyzer, analyzer, ...extra },
    { root, eventId: `native-${analyzer}`, project: "native-fixture", commitSha: "unknown" }
  );
}
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
  include: ["src"],
});

test("真实类型感知检查命中漏await，正确处理后复扫清零；缺tsconfig不能假通过", async () => {
  const root = fixture({
    "src/save.ts": "async function save(): Promise<number>{ return 1; }\nsave();\nexport {};",
    "tsconfig.json": tsconfig,
  });
  const before = await scan(root, "typed");
  assert.equal(before.status, "ok", before.reason);
  assert.ok(before.findings.some((f) => f.ruleId.endsWith("no-floating-promises")));
  writeFileSync(
    path.join(root, "src/save.ts"),
    "async function save(): Promise<number>{ return 1; }\nasync function execute(){ return await save(); }\nexport {execute};"
  );
  const after = await scan(root, "typed");
  assert.equal(after.status, "ok", after.reason);
  assert.equal(after.findings.length, 0);
  rmSync(path.join(root, "tsconfig.json"));
  const missing = await scan(root, "typed");
  assert.equal(missing.status, "invalid");
});
test("真实DOM危险写入与Vue可访问性检查；安全textContent反例通过", async () => {
  const root = fixture({
    "src/html.ts": "export function show(value:string){ document.body.innerHTML=value; }",
    "src/example.vue": '<template><img src="/a.png" /></template>',
  });
  const before = await scan(root, "security");
  assert.equal(before.status, "ok", before.reason);
  assert.ok(before.findings.some((f) => f.ruleId.includes("no-unsanitized")));
  assert.ok(before.findings.some((f) => f.ruleId.includes("alt-text")));
  writeFileSync(
    path.join(root, "src/html.ts"),
    "export function show(value:string){ document.body.textContent=value; }"
  );
  writeFileSync(path.join(root, "src/example.vue"), '<template><img src="/a.png" alt="生产示意图" /></template>');
  const fixed = await scan(root, "security");
  assert.equal(fixed.status, "ok", fixed.reason);
  assert.equal(fixed.findings.length, 0);
});
test("真实依赖图检出循环，解除循环后通过；未解析依赖有明确发现", async () => {
  const root = fixture({
    "src/a.ts": "import {b} from './b'; export const a=()=>b;",
    "src/b.ts": "import {a} from './a';export const b=()=>a;",
  });
  const before = await scan(root, "architecture");
  assert.equal(before.status, "ok", before.reason);
  assert.ok(before.findings.some((f) => f.ruleId.endsWith("no-circular")));
  writeFileSync(path.join(root, "src/b.ts"), "export const b=1;");
  const fixed = await scan(root, "architecture");
  assert.equal(fixed.status, "ok", fixed.reason);
  assert.equal(fixed.findings.length, 0);
  writeFileSync(path.join(root, "src/b.ts"), "export {missing} from './not-present';");
  const unresolved = await scan(root, "architecture");
  assert.equal(unresolved.status, "ok", unresolved.reason);
  assert.ok(unresolved.findings.some((f) => f.ruleId.endsWith("no-unresolved")));
});
test("真实重复代码检测保留两处行区间，小文件低于阈值口径明确", async () => {
  const text = Array.from({ length: 25 }, (_, i) => `export const a${i} = ${i} * 55 + 88;`).join("\n");
  const root = fixture({ "src/a.ts": text, "src/b.ts": text });
  const before = await scan(root, "duplicates");
  assert.equal(before.status, "ok", before.reason);
  assert.equal(before.findings.length, 2);
  assert.equal(before.findings[0].endLine, 25);
  writeFileSync(path.join(root,"src/a.ts"),"\n"+text);writeFileSync(path.join(root,"src/b.ts"),"\n"+text);
  const shifted=await scan(root,"duplicates");assert.equal(shifted.status,"ok",shifted.reason);
  assert.deepEqual(shifted.findings.map(f=>f.fingerprint).sort(),before.findings.map(f=>f.fingerprint).sort());
  assert.ok(shifted.findings.every(f=>f.relatedLocations.length===2));
  writeFileSync(path.join(root, "src/b.ts"), "export const unique=1;");
  const fixed = await scan(root, "duplicates");
  assert.equal(fixed.status, "ok", fixed.reason);
  assert.equal(fixed.findings.length, 0);
});
test("真实密钥检测不向统一报告或原件复制密钥；根目录配置也检查", async () => {
  const dummy = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  const secretFragment = dummy.split("\n")[1];
  const root = fixture({ "src/a.ts": "export const x=1;", "test-key.pem": dummy });
  const before = await scan(root, "secrets", { targets: ["."] });
  assert.equal(before.status, "ok", before.reason);
  assert.ok(before.findings.length > 0);
  assert.ok(!JSON.stringify(before).includes(secretFragment));
  for (const report of before.production.reports)
    assert.ok(!readFileSync(path.join(root, report.file), "utf8").includes(secretFragment));
  rmSync(path.join(root, "test-key.pem"));
  const fixed = await scan(root, "secrets", { targets: ["."] });
  assert.equal(fixed.status, "ok", fixed.reason);
  assert.equal(fixed.findings.length, 0);
});
test("空输入、语法错误、符号链接明确失败；不接受裁剪成增量的完整检查", async () => {
  const root = fixture({ "src/a.ts": "export const x=1;" });
  symlinkSync(path.join(root, "src/a.ts"), path.join(root, "src/link.ts"));
  assert.equal((await scan(root, "security")).status, "invalid");
  rmSync(path.join(root, "src/link.ts"));
  writeFileSync(path.join(root, "src/a.ts"), "export const = ;");
  assert.equal((await scan(root, "security")).status, "invalid");
  rmSync(path.join(root, "src/a.ts"));
  assert.equal((await scan(root, "security")).status, "invalid");
});
test("规则抑制不能绕过；隔离分析超时失效；飞书钩子凭据按组织规则屏蔽", async () => {
  const root = fixture({
    "src/html.ts":
      "/* eslint-disable no-unsanitized/property */\nexport function show(value:string){document.body.innerHTML=value;}",
  });
  const suppressed = await scan(root, "security");
  assert.ok(suppressed.status === "invalid" || suppressed.findings.some((f) => f.ruleId.includes("no-unsanitized")));
  const timeout = await scan(root, "security", { timeoutMs: 1 });
  assert.equal(timeout.status, "invalid");
  assert.match(timeout.reason, /超时/);
  const fakeHook = ["https://open.feishu.cn/open-apis/bot/v2/hook/", "00000000-1111-4222-8333-444444444444"].join("");
  writeFileSync(path.join(root, "config.txt"), fakeHook);
  const secret = await scan(root, "secrets");
  assert.equal(secret.status, "ok", secret.reason);
  assert.ok(secret.findings.some((f) => f.ruleId.includes("feishu-webhook")));
  assert.ok(!JSON.stringify(secret).includes(fakeHook));
});
test("Java CPD按每文件区间并集计数，复杂度函数/位置保留；越界与不完整统计拒绝", () => {
  const root = "/sample",
    manifest = {
      scope: {
        source: {
          files: [
            { path: "A.java", lines: 30 },
            { path: "B.java", lines: 30 },
          ],
          lineCount: 60,
        },
      },
    };
  const raw = {
    cpd: '<pmd-cpd><file path="/sample/A.java"/><file path="/sample/B.java"/><duplication lines="10" tokens="100"><file path="/sample/A.java" line="1"/><file path="/sample/B.java" line="1"/><codefragment>first duplicate</codefragment></duplication><duplication lines="10" tokens="100"><file path="/sample/A.java" line="5"/><file path="/sample/B.java" line="5"/><codefragment>second duplicate</codefragment></duplication></pmd-cpd>',
    ccn: JSON.stringify({
      total_functions: 2,
      avg_ccn: 9,
      risky_count: 1,
      risky: [{ file: "/sample/A.java", func: "complex", start: 1, end: 25, ccn: 16 }],
      analyzedFiles: 2,
      analysisErrors: 0,
    }),
  };
  const result = parseJavaMetrics(manifest, raw, root);
  assert.equal(result.metrics.duplicateLines, 28);
  assert.equal(result.findings.length, 5);
  assert.equal(result.metrics.riskyFunctions, 1);
  const shifted=parseJavaMetrics(manifest,{...raw,cpd:raw.cpd.replaceAll('line="1"','line="2"').replaceAll('line="5"','line="6"')},root);
  assert.deepEqual(shifted.findings.map(f=>findingFingerprint("p",f)),result.findings.map(f=>findingFingerprint("p",f)));
  assert.throws(
    () => parseJavaMetrics(manifest, { ...raw, cpd: raw.cpd.replace('line="1"', 'line="25"') }, root),
    /范围/
  );
  assert.throws(
    () =>
      parseJavaMetrics(manifest, { ...raw, ccn: raw.ccn.replace('"analysisErrors":0', '"analysisErrors":1') }, root),
    /失效/
  );
});
test("固定Java分发包含完整配置/分析器；缺分发不降级；极高/严重不能基线或豁免", async () => {
  const lock = javaReferenceLock();
  assert.equal(lock.engines.pmd, "6.55.0");
  assert.ok(lock.files.some((x) => x.path.includes("p3c-pmd.jar")));
  assert.ok(lock.files.some((x) => x.path.includes("spotbugs-4.10.4")));
  const absent = fixture({ placeholder: "x" });
  await assert.rejects(
    javaDistribution({ env: { PATH: process.env.PATH, WL_JAVA_SCAN_HOME: path.join(absent, "missing") } }),
    /未准备/
  );
  for (const severity of ["error", "blocker"]) {
    const f = { ruleId: "R1", severity, file: "A.java", message: "m", line: 1 };
    const result = collect({
      project: "p",
      findings: [f],
      baselineItems: [{ fingerprint: findingFingerprint("p", f), severity, occurrenceCount: 1 }],
      waivers: [{ id: "W1", ruleId: "R1", owner: "a", approver: "b", reason: "test", expiresAt: "2099-01-01" }],
    });
    assert.equal(result.counts.blockingNew, 1);
    assert.equal(result.counts.waived, 0);
    assert.equal(result.findings[0].waiverRejected, "W1");
  }
});
