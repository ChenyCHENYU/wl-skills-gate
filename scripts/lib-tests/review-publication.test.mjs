import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createControlReviewFixture } from "../test-support/control-review-fixture.mjs";
import { publishReviewAuthorizations } from "../../lib/review-publish.js";
import { ingestReviewPublications } from "../../lib/review-publication.js";
import { readGovernanceState } from "../../lib/governance.js";
const now = Date.parse("2026-10-15T00:00:00Z"), pin = "a".repeat(64);
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
async function fixture(t) {
  const f = await createControlReviewFixture(t, { sequence: 450001 });
  const g = JSON.parse(readFileSync(f.c.governanceConfigFile)); g.allowedLinkOrigins.push("https://ci.example.invalid"); write(f.c.governanceConfigFile, g);
  await f.register(); const cookie = await f.login(), { fields } = await f.form(cookie);
  const accepted = await f.http({ method: "POST", cookie, body: new URLSearchParams(fields).toString() }); assert.equal(accepted.status, 200, accepted.text);
  const configFile = path.join(f.root, "publisher.json"), manifestDir = path.join(f.root, "published");
  const config = { schemaVersion: 1, controlCatalogFile: path.join(f.c.dataDir, "reviews.json"), authorizationDir: path.join(f.c.dataDir, "authorizations"), stateFile: path.join(f.root, "publisher-state.json"), manifestDir, reviewPrivateKeyFile: path.join(f.root, "review-private.pem"), reviewPublicKeyFile: path.join(f.root, "review-public.pem"), authorizationPublicKeyFile: path.join(f.root, "authorization-public.pem"), authorizationIssuer: "identity-authority", projects: { demo: { evidenceRoots: [f.options.evidenceRoot], reviewers: ["reviewer"], collectorConfigFile: f.configFile, reviewPolicyFile: path.join(f.root, "quality/review-policy.json"), reviewPolicyHash: f.collector.reviewPolicyHash, policyHash: pin, rulesHash: pin, baselineHash: pin, waiversHash: pin, profile: "standard" } } };
  write(configFile, config); const published = await publishReviewAuthorizations({ configFile, env: { TOKEN: "secret" }, fetchImpl: f.fetchImpl, now }); assert.equal(published.published.length, 1, JSON.stringify(published.errors));
  const options = { configFile: f.c.governanceConfigFile, stateFile: f.c.stateFile, receiptPrivateKeyFile: f.c.receiptPrivateKeyFile, ciConfigFile: f.ciConfigFile, publication: { manifestDir, publicKeyFile: config.reviewPublicKeyFile, authorizationPublicKeyFile: config.authorizationPublicKeyFile, expectAuthorizationIssuer: config.authorizationIssuer, expectReviewPolicyHash: f.collector.reviewPolicyHash, evidenceRoot: f.options.evidenceRoot }, dataDir: path.join(f.root, "publication-reader"), now: now + 10000 };
  return { ...f, published, options, publish: () => publishReviewAuthorizations({ configFile, env: { TOKEN: "secret" }, fetchImpl: f.fetchImpl, now }), ingest: (overrides = {}) => ingestReviewPublications({ ...options, ...overrides }), state: () => readGovernanceState({ configFile: options.configFile, stateFile: options.stateFile }) };
}
test("OIDC授权→独立正式签发→公钥复验→正式Review事实入账/待发箱，重复不新增", async (t) => {
  const f = await fixture(t), first = await f.ingest(); assert.equal(first.status, "ok", JSON.stringify(first.errors)); assert.equal(first.ingested.length, 1);
  const fact = Object.values(f.state().lifecycles)[0]; assert.equal(fact.category, "review"); assert.equal(fact.status, "approved"); assert.equal(fact.actorId, "reviewer"); assert.equal(fact.sequence, 450002);
  assert.equal(Object.values(f.state().issues).length, 0); assert.equal(Object.values(f.state().outbox).length, 1);
  const again = await f.ingest(); assert.equal(again.reused.length, 1); assert.equal(Object.keys(f.state().events).length, 1);
});
test("正式事实入账后中断并暂停25小时仍通过原digest确认恢复，不重写旧事实时间", async (t) => {
  const f = await fixture(t), first = await f.ingest({ afterStage: () => { throw new Error("isolated crash after ingestion"); } }); assert.equal(first.errors.length, 1);
  const recovered = await f.ingest({ now: now + 25 * 3600000 }); assert.equal(recovered.status, "ok", JSON.stringify(recovered.errors)); assert.equal(recovered.reused.length, 1); assert.equal(Object.keys(f.state().events).length, 1);
});
test("清单提供的公钥不控制读取信任，正式记录/原件变化阻断且不覆盖", async (t) => {
  const f = await fixture(t), file = f.published.published[0].manifestFile, m = JSON.parse(readFileSync(file)); m.publicKeyFile = path.join(f.root, "identity-public.pem"); write(file, m);
  assert.equal((await f.ingest()).ingested.length, 1); // reader uses configured Review key
  writeFileSync(m.recordFile, "{}"); const changed = await f.ingest(); assert.equal(changed.status, "attention"); assert.match(changed.errors[0].reason, /正式Review文件被替换/); assert.equal(readFileSync(m.recordFile, "utf8"), "{}");
});
test("同一Review再次合法授权保留原始签名记录，正式事实幂等不发生阶段序号冲突", async (t) => {
  const f = await fixture(t); assert.equal((await f.ingest()).ingested.length, 1);
  const cookie = await f.login(), { fields } = await f.form(cookie); fields.reason = "再次独立确认同份正文和九维证据";
  assert.equal((await f.http({ method: "POST", cookie, body: new URLSearchParams(fields).toString() })).status, 200);
  assert.equal((await f.publish()).published.length, 1); const again = await f.ingest();
  assert.equal(again.status, "ok", JSON.stringify(again.errors)); assert.equal(Object.keys(f.state().events).length, 1); assert.equal(Object.keys(f.state().outbox).length, 1);
});
test("只恢复治理台账而丢失已入账事件时显式attention，不把独立缓存当成功事实", async (t) => {
  const f = await fixture(t); assert.equal((await f.ingest()).ingested.length, 1); rmSync(f.options.stateFile);
  const afterRestore = await f.ingest(); assert.equal(afterRestore.status, "attention"); assert.equal(afterRestore.reused.length, 0); assert.match(afterRestore.errors[0].reason, /台账事件缺失/); assert.equal(Object.keys(f.state().events).length, 0);
});
