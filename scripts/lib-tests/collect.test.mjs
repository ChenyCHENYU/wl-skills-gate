import { test } from "node:test";
import assert from "node:assert/strict";
import { collect } from "../../lib/collect.js";
import { findingFingerprint } from "../../lib/fingerprint.js";

const now = new Date("2026-10-08T00:00:00Z");
const finding = (over = {}) => ({
  ruleId: "R1",
  severity: "error",
  file: "src/a.ts",
  line: 1,
  message: "m",
  ...over,
});
const waiver = (over = {}) => ({
  id: "W1",
  ruleId: "R1",
  path: "src/a.ts",
  reason: "r",
  owner: "1",
  approver: "2",
  expiresAt: "2099-01-01",
  ...over,
});

test("新发现计入 new/blockingNew", () => {
  const r = collect({ project: "p", findings: [finding()], now });
  assert.equal(r.findings[0].status, "new");
  assert.equal(r.counts.new, 1);
  assert.equal(r.counts.blockingNew, 1);
});

test("warning基线命中为existing；error/blocker历史问题仍硬阻断", () => {
  const f = finding({severity: "warning"});
  const fp = findingFingerprint("p", f);
  const r = collect({ project: "p", findings: [f], baselineItems: [{ fingerprint: fp }], now });
  assert.equal(r.counts.existing, 1);
  assert.equal(r.counts.blockingNew, 0);
  for (const severity of ["error", "blocker"]) {
    const f = finding({severity});
    const result = collect({project:"p", findings:[f], baselineItems:[{fingerprint:findingFingerprint("p",f),severity}], now});
    assert.equal(result.counts.blockingNew,1);
  }
});

test("有效豁免 waived；到期豁免 expired 并阻断", () => {
  const ok = collect({ project: "p", findings: [finding({severity:"warning"})], waivers: [waiver()], now });
  assert.equal(ok.counts.waived, 1);
  const expired = collect({ project: "p", findings: [finding()], waivers: [waiver({ expiresAt: "2020-01-01" })], now });
  assert.equal(expired.counts.expired, 1);
  assert.equal(expired.counts.blockingNew, 1);
});

test("blocker 豁免不得通过 allow 绕过", () => {
  const blocker = finding({ severity: "blocker" });
  const reject = collect({ project: "p", findings: [blocker], waivers: [waiver()], now });
  assert.equal(reject.findings[0].status, "new");
  assert.equal(reject.findings[0].waiverRejected, "W1");
  assert.equal(reject.counts.blockingNew, 1);
  const allow = collect({ project: "p", findings: [blocker], waivers: [waiver()], now, blockerWaivers: "allow" });
  assert.equal(allow.counts.waived, 0);
  assert.equal(allow.counts.blockingNew, 1);
});

test("同指纹多处命中合并并保留 occurrences", () => {
  const r = collect({ project: "p", findings: [finding({ line: 10 }), finding({ line: 20 })], now });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].duplicates, 1);
  assert.deepEqual(
    r.findings[0].occurrences.map((o) => o.line),
    [10, 20]
  );
});

test("enforceWarnings 将新增 warning 升级为阻断", () => {
  const r = collect({ project: "p", findings: [finding({ severity: "warning" })], now, enforceWarnings: true });
  assert.equal(r.counts.blockingNew, 1);
});

test("豁免 path 通配：** 覆盖子目录、* 单段、精确匹配", () => {
  const f = finding({ file: "src/mock/deep/a.ts", severity:"warning" });
  const w = (path) => [waiver({ path })];
  assert.equal(collect({ project: "p", findings: [f], waivers: w("src/mock/**"), now }).counts.waived, 1);
  assert.equal(collect({ project: "p", findings: [finding({ file: "src/x.ts",severity:"warning" })], waivers: w("src/*.ts"), now }).counts.waived, 1);
  assert.equal(collect({ project: "p", findings: [f], waivers: w("src/other/**"), now }).counts.waived, 0);
});
