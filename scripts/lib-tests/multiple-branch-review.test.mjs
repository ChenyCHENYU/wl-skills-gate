import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createControlReviewFixture } from "../test-support/control-review-fixture.mjs";
import { createReviewCollectFixture } from "../test-support/review-collect-fixture.mjs";
import { createCiReview } from "../../lib/review-ci.js";
import { publishReviewAuthorizations } from "../../lib/review-publish.js";
import { loadControlConfig } from "../../lib/control-service.js";
import { collectorFiles, collectorFromProvenance } from "../../lib/review-collectors.js";
import { signRecord } from "../../lib/evidence.js";
import { findReleaseReviewPublication } from "../../lib/release-review.js";
const now = Date.parse("2026-10-15T00:00:00Z"),
  sha = "b".repeat(40);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
test("一个中央项目独立登记六分支，分别采集/注册/授权/签发，UAT不能拿其他分支同SHA报告放行", async (t) => {
  const f = await createControlReviewFixture(t, { branch: "dev", scope: "dev" });
  const branches = [f];
  for (const [i, branch] of ["sit", "uat", "pre", "prd", "main"].entries())
    branches.push(
      await createReviewCollectFixture(t, { branch, scope: branch, parent: f.root, pipelineId: 46 + i, jobId: 601 + i })
    );
  const additional = branches.slice(1).map((b) => b.configFile);
  const governance = read(f.c.governanceConfigFile),
    base = governance.projects.demo.scopes.dev;
  for (const b of branches) governance.projects.demo.scopes[b.scope] = structuredClone(base);
  write(f.c.governanceConfigFile, governance);
  f.c.reviewPolicies.demo.additionalCollectorConfigFiles = additional;
  write(f.controlConfigFile, f.c);
  assert.equal(collectorFiles(loadControlConfig(f.controlConfigFile).reviewPolicies.demo).length, 6);
  const registered = [];
  for (const b of branches) {
    const configFile = path.join(b.root, "multi-review-ci.json");
    write(configFile, {
      schemaVersion: 1,
      collectorConfigFile: b.configFile,
      reviewPolicyFile: path.join(f.root, "quality/review-policy.json"),
      controlConfigFile: f.controlConfigFile,
    });
    const result = await createCiReview({
      configFile,
      sourceFile: b.collection.sourceFile,
      outDir: path.join(f.root, "six-review-output", b.scope),
      now,
    });
    assert.equal(result.registered, true);
    registered.push(result);
    assert.equal(
      collectorFromProvenance(loadControlConfig(f.controlConfigFile).reviewPolicies.demo, result.provenanceFile),
      b.configFile
    );
    const record = read(result.recordFile);
    // Explicit isolated identity fixture, never a real employee authorization.
    const auth = signRecord(
      {
        schemaVersion: 1,
        kind: "review-authorization",
        scope: "review-publish",
        decision: "approved",
        issuer: f.c.authorizationIssuer,
        authorizationId: "isolated-" + b.scope,
        identitySource: "isolated explicit test identity",
        actorId: "reviewer",
        authorId: "author",
        project: "demo",
        candidateSha: sha,
        reviewDigest: record.reviewDigest,
        bodyDigest: record.bodyDigest,
        evidenceDigest: record.evidenceDigest,
        reason: "independent isolated fixture review",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 900000).toISOString(),
        dimensionDecisions: record.content.dimensions.map((d) => ({
          id: d.id,
          decision: "approved",
          reason: "isolated actual evidence reviewed",
        })),
      },
      f.c.authorizationPrivateKeyFile
    );
    mkdirSync(path.join(f.c.dataDir, "authorizations"), { recursive: true });
    write(path.join(f.c.dataDir, "authorizations", b.scope + ".json"), auth);
  }
  const catalog = read(path.join(f.c.dataDir, "reviews.json"));
  assert.equal(new Set(registered.map((r) => r.registrationId)).size, 6);
  for (const b of branches) assert.ok(catalog.latest[`demo:${b.scope}:${sha}`]);
  const project = {
    evidenceRoots: [f.root],
    reviewers: ["reviewer"],
    collectorConfigFile: f.configFile,
    additionalCollectorConfigFiles: additional,
    reviewPolicyFile: path.join(f.root, "quality/review-policy.json"),
    reviewPolicyHash: f.collector.reviewPolicyHash,
    policyHash: "a".repeat(64),
    rulesHash: "a".repeat(64),
    baselineHash: "a".repeat(64),
    waiversHash: "a".repeat(64),
    profile: "standard",
  };
  const publishFile = path.join(f.root, "six-publish.json"),
    publication = path.join(f.root, "six-publication");
  write(publishFile, {
    schemaVersion: 1,
    controlCatalogFile: path.join(f.c.dataDir, "reviews.json"),
    authorizationDir: path.join(f.c.dataDir, "authorizations"),
    stateFile: path.join(f.root, "six-publish-state.json"),
    manifestDir: publication,
    reviewPrivateKeyFile: path.join(f.root, "review-private.pem"),
    reviewPublicKeyFile: path.join(f.root, "review-public.pem"),
    authorizationPublicKeyFile: path.join(f.root, "authorization-public.pem"),
    authorizationIssuer: f.c.authorizationIssuer,
    projects: { demo: project },
  });
  const fetchImpl = (url, init) => {
    const p = new URL(url).pathname;
    const id = p.match(/\/pipelines\/(\d+)/)?.[1],
      jobId = p.match(/\/jobs\/(\d+)/)?.[1];
    const b = branches.find((b) => (id ? b.pipelineId === Number(id) : b.jobId === Number(jobId)));
    assert.ok(b, `unmapped ${p}`);
    return b.fetchImpl(url, init);
  };
  const published = await publishReviewAuthorizations({
    configFile: publishFile,
    env: { TOKEN: "secret" },
    fetchImpl,
    now,
  });
  assert.equal(published.errors.length, 0, JSON.stringify(published.errors));
  assert.equal(published.published.length, 6);
  const trustFile = path.join(f.root, "six-trust.json");
  const trust = {
    ...project,
    publicKeyFile: path.join(f.root, "review-public.pem"),
    authorizationPublicKeyFile: path.join(f.root, "authorization-public.pem"),
    authorizationIssuer: f.c.authorizationIssuer,
    controlCatalogFile: path.join(f.c.dataDir, "reviews.json"),
    scope: "uat",
  };
  write(trustFile, { schemaVersion: 1, kind: "release-review-trust", projects: { demo: trust } });
  const selected = findReleaseReviewPublication({
    configFile: trustFile,
    project: "demo",
    sha,
    publicationDir: publication,
    now: new Date(now + 10000),
  });
  assert.equal(selected.manifest.scope, "uat");
  assert.equal(selected.manifest.collectorConfigFile, branches.find((b) => b.scope === "uat").configFile);
  delete trust.scope;
  write(trustFile, { schemaVersion: 1, kind: "release-review-trust", projects: { demo: trust } });
  assert.throws(
    () =>
      findReleaseReviewPublication({
        configFile: trustFile,
        project: "demo",
        sha,
        publicationDir: publication,
        now: new Date(now + 10000),
      }),
    /必须固定scope/
  );
});
test("多分支采集器重复scope或不在批准清单内必须拒绝，不能跨分支串线", async (t) => {
  const f = await createControlReviewFixture(t),
    alias = path.join(f.root, "duplicate-collector.json");
  write(alias, f.collector);
  f.c.reviewPolicies.demo.additionalCollectorConfigFiles = [alias];
  write(f.controlConfigFile, f.c);
  assert.throws(() => loadControlConfig(f.controlConfigFile), /独立scope/);
  const unknown = path.join(f.root, "unknown-provenance.json");
  write(unknown, { configFile: "/private/tmp/unapproved-collector.json" });
  assert.throws(() => collectorFromProvenance({ collectorConfigFile: f.configFile }, unknown), /批准清单/);
});
