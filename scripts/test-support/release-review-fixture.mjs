// Real nine-dimension signatures for isolated release/deployment contract tests.
// The reviewer identity below is explicitly simulated; it is not a business approval.
import path from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { REVIEW_DIMENSIONS, createReviewDraft } from "../../lib/review.js";
import { signRecord, signReviewRecord } from "../../lib/evidence.js";
import { stableStringify } from "../../lib/util.js";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
export function createReleaseReviewFixture({ root, project, sha, summary, now = new Date(), authorId = `author-${project}`, reviewerId = "independent-reviewer", trustFile = path.join(root, "release-review-trust.json") }) {
  const evidenceRoot = path.join(root, "reviews", `${project}-${sha.slice(0, 8)}`); mkdirSync(evidenceRoot, { recursive: true });
  const keys = {};
  for (const name of ["review", "identity"]) {
    const privateKeyFile = path.join(root, "review-keys", `${name}-private.pem`), publicKeyFile = path.join(root, "review-keys", `${name}-public.pem`); mkdirSync(path.dirname(privateKeyFile), { recursive: true });
    if (!existsSync(privateKeyFile)) { const key = generateKeyPairSync("ed25519"); writeFileSync(privateKeyFile, key.privateKey.export({ type: "pkcs8", format: "pem" })); writeFileSync(publicKeyFile, key.publicKey.export({ type: "spki", format: "pem" })); }
    keys[name] = { privateKeyFile, publicKeyFile };
  }
  const policy = { schemaVersion: 1, project, dimensions: REVIEW_DIMENSIONS.map((d) => ({ id: d.id, applicable: true, requiredEvidenceTypes: [["coding", "scan"].includes(d.id) ? "gate-summary" : `${d.id}-evidence`] })) };
  write(path.join(evidenceRoot, "policy.json"), policy); write(path.join(evidenceRoot, "summary.json"), summary);
  const evidence = [{ id: "gate", type: "gate-summary", source: "isolated/actual-same-candidate-release-summary", project, candidateSha: sha, file: "summary.json", dimensionIds: ["coding", "scan"] }];
  for (const d of REVIEW_DIMENSIONS.filter((v) => !["coding", "scan"].includes(v.id))) { writeFileSync(path.join(evidenceRoot, `${d.id}.txt`), `Explicitly simulated independent ${d.id} evidence for isolated candidate ${sha}; no business coverage claimed.`); evidence.push({ id: d.id, type: `${d.id}-evidence`, source: "isolated/explicit-simulated-reviewer", project, candidateSha: sha, file: `${d.id}.txt`, dimensionIds: [d.id] }); }
  const draft = createReviewDraft({ input: { schemaVersion: 1, kind: "review-input", project, authorId, candidateSha: sha, policyFile: "policy.json", evidence }, evidenceRoot, outDir: path.join(evidenceRoot, "draft"), now });
  const trust = existsSync(trustFile) ? JSON.parse(readFileSync(trustFile)) : { schemaVersion: 1, kind: "release-review-trust", projects: {} };
  const p = { publicKeyFile: keys.review.publicKeyFile, authorizationPublicKeyFile: keys.identity.publicKeyFile, authorizationIssuer: "isolated-identity", reviewers: [reviewerId], reviewPolicyHash: hash(stableStringify(policy)), policyHash: summary.policy.policyHash, rulesHash: summary.policy.ruleSetHash, baselineHash: summary.policy.baselineHash, waiversHash: summary.policy.waiversHash, profile: summary.run.profile, ...(summary.run.targetEnv ? { env: summary.run.targetEnv } : {}), maxAgeMinutes: 1440 };
  trust.projects[project] = p; write(trustFile, trust);
  const authorizationFile = path.join(evidenceRoot, "authorization.json"), authorization = signRecord({ schemaVersion: 1, kind: "review-authorization", authorizationId: `${project}-${sha.slice(0, 8)}`, identitySource: "isolated explicit simulated identity", issuer: p.authorizationIssuer, scope: "review-publish", decision: "approved", actorId: reviewerId, authorId, project, candidateSha: sha, reviewDigest: draft.reviewDigest, bodyDigest: draft.bodyDigest, evidenceDigest: draft.evidenceDigest, reason: "Explicit fixture-only nine-dimension approval", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), dimensionDecisions: REVIEW_DIMENSIONS.map((d) => ({ id: d.id, decision: "approved", reason: "Isolated simulated independent evidence checked" })) }, keys.identity.privateKeyFile);
  write(authorizationFile, authorization);
  const recordFile = path.join(evidenceRoot, "formal.json"), record = signReviewRecord({ project, sha, recordFile: draft.recordFile, evidenceRoot, now, profile: p.profile, env: p.env, reviewerId, authorId, privateKeyFile: keys.review.privateKeyFile, authorizationFile, publicKeyFile: keys.review.publicKeyFile, authorizationPublicKeyFile: keys.identity.publicKeyFile, expectAuthorizationIssuer: p.authorizationIssuer, expectReviewPolicyHash: p.reviewPolicyHash, expectPolicyHash: p.policyHash, expectRulesHash: p.rulesHash, expectBaselineHash: p.baselineHash, expectWaiversHash: p.waiversHash });
  write(recordFile, record);
  return { recordFile, evidenceRoot, trustFile, record, keys, draft };
}
