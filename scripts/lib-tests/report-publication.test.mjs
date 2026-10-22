import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveQualityReport, verifyPublishedQualityReport } from "../../lib/report-publication.js";

function fixture(t, stage = "local-hook") {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-report-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = { summary: { schemaVersion: 1, run: { project: "produce", stage, profile: "standard", eventId: "check-1", startedAt: "2026-10-20T02:00:00Z", durationMs: 1, tool: "gate", commitSha: "a".repeat(40) }, checks: [], findings: [{ fingerprint: "f".repeat(64), status: "new", severity: "error", dimension: "coding", ruleId: "R", file: "src/Example.java", line: 12, message: "需要修复", suggestion: "修复后回归" }], decision: { status: "blocked", reasons: [] } }, dimensions: [] };
  const run = () => archiveQualityReport({ input, outDir: path.join(root, "reports"), jenkinsBuildUrl: "https://jenkins.example.invalid/job/quality/12/" });
  return { root, input, run };
}
for (const stage of ["local-hook", "ci"]) test(`${stage}独立归档与固定链接，复扫不会覆盖旧HTML，重启可直接读原件`, (t) => {
  const f = fixture(t, stage), first = f.run(), bytes = readFileSync(first.entryFile, "utf8");
  assert.equal(f.run().archiveId, first.archiveId);
  assert(first.reportUrl.includes(`/12/wl-quality/produce/${stage}/`));
  assert.equal(first.approved, false); assert.equal(first.status, "archived-awaiting-publication");
  assert.equal((bytes.match(/class="dimension-section" id="dimension-/g) || []).length, 9);
  f.input.summary.run.eventId = "check-2"; f.input.summary.findings = [];
  const next = f.run(); assert.notEqual(next.reportUrl, first.reportUrl);
  assert.equal(readFileSync(first.entryFile, "utf8"), bytes);
  assert(!readFileSync(next.entryFile, "utf8").includes('data-risk="error"'));
  writeFileSync(first.entryFile, "tampered"); f.input.summary.run.eventId = "check-1";
  f.input.summary.findings = [{ fingerprint: "f".repeat(64), status: "new", severity: "error", dimension: "coding", ruleId: "R", file: "src/Example.java", line: 12, message: "需要修复", suggestion: "修复后回归" }];
  assert.throws(f.run, /禁止.*覆盖/);
});
test("持久目录拒绝symlink，正式报告拒绝缺源码身份和浮动Jenkins链接", (t) => {
  const f = fixture(t); symlinkSync(f.root, path.join(f.root, "reports")); assert.throws(f.run, /符号链接/);
  for (const url of ["http://jenkins.example.invalid/job/q/1/", "https://jenkins.example.invalid/job/q/lastBuild/", "https://user:secret@jenkins.example.invalid/job/q/1/"]) {
    assert.throws(() => archiveQualityReport({ input: f.input, outDir: f.root, jenkinsBuildUrl: url }), /具体Jenkins构建/);
  }
  f.input.summary.run.commitSha = "unknown"; assert.throws(f.run, /源码SHA/);
});
test("发布校验核对HTML原文，凭据只发批准origin、不进入返回值", async (t) => {
  const f = fixture(t), p = f.run(), html = readFileSync(p.entryFile);
  const result = await verifyPublishedQualityReport({ manifestFile: p.manifestFile, expectedOrigin: "https://jenkins.example.invalid", user: "reader", token: "PRIVATE_TOKEN", fetchImpl: async (url, init) => {
    assert.equal(url, p.reportUrl); assert.equal(init.redirect, "error"); assert(init.headers.Authorization.startsWith("Basic "));
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } });
  assert.equal(result.status, "accessible"); assert.equal(result.audiencePermissionsVerified, false); assert.equal(result.approved, false);
  assert(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  await assert.rejects(() => verifyPublishedQualityReport({ manifestFile: p.manifestFile, expectedOrigin: "https://wrong.example.invalid", fetchImpl: () => assert.fail("不能向其他域发送凭据") }), /入口不一致/);
});
for (const mode of ["login", "json", "403", "old-report"]) test(`发布校验拒绝${mode}，不把HTTP200等同报告就绪`, async (t) => {
  const f = fixture(t), p = f.run();
  await assert.rejects(() => verifyPublishedQualityReport({ manifestFile: p.manifestFile, expectedOrigin: "https://jenkins.example.invalid", fetchImpl: async () =>
    new Response(mode === "login" ? "<html>Sign in</html>" : mode === "old-report" ? "<html>Old report</html>" : "{}", { status: mode === "403" ? 403 : 200, headers: { "Content-Type": mode === "json" ? "application/json" : "text/html" } }) }), /尚不可访问|不一致/);
});
