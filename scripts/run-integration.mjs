import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { promote, applyPromotion } from "../lib/promote.js";
import { signGateProof, signReviewRecord, signRecord } from "../lib/evidence.js";
import { supplementReviewDraft, REVIEW_DIMENSIONS } from "../lib/review.js";
import { git } from "../lib/source-state.js";
import { loadConfig } from "../lib/config.js";
import { readJson } from "../lib/util.js";
import { quote } from "../lib/exec.js";

const gateVersion = readJson(new URL("../package.json", import.meta.url)).version;
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/wl-skills-gate.js");

function keyFiles(base, name) {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(base, `${name}.key`); const publicKeyFile = path.join(base, `${name}.pub`);
  writeFileSync(privateKeyFile, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(publicKeyFile, pair.publicKey.export({ format: "pem", type: "spki" }));
  return { privateKeyFile, publicKeyFile };
}

export async function runIntegration() {
  const base = mkdtempSync(path.join(tmpdir(), "wl-gate-int-"));
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok, detail });
  try {
    const bare = path.join(base, "origin.git"); const repo = path.join(base, "repo");
    git(["init", "--bare", "-q", "-b", "main", bare], base);
    git(["clone", "-q", bare, repo], base);
    git(["config", "user.email", "integration@example.invalid"], repo);
    git(["config", "user.name", "Integration"], repo);
    mkdirSync(path.join(repo, "quality"));
    writeFileSync(path.join(repo, ".gitignore"), "quality-reports/\ndist/\n");
    writeFileSync(path.join(repo, "source.txt"), "good");
    writeFileSync(path.join(repo, "scan.mjs"), `import fs from 'node:fs';console.log(JSON.stringify({toolVersion:'demo@1',findings:fs.readFileSync('source.txt','utf8')==='bad'?[{ruleId:'DEMO/E',severity:'error',file:'source.txt',message:'bad'}]:[]}));`);
    writeFileSync(path.join(repo, "quality/policy.json"), JSON.stringify({ schemaVersion: 1, project: "integration",
      releaseRequires: ["SCAN"], checks: [{ id: "SCAN", tool: "cmd-json", command: "node scan.mjs", versionCommand: "node --version", profiles: ["standard", "release"] }] }));
    writeFileSync(path.join(repo, "quality/rules.lock.json"), JSON.stringify({ lockVersion: 1, "wl-skills-gate": gateVersion, tools: { SCAN: process.version } }));
    const reviewEvidenceTypes = { submission: "git-commits", branch: "promotion-record", coding: "gate-summary", ui: "ui-scope-review",
      review: "review-checklist", tests: "test-results", scan: "gate-summary", cicd: "candidate-check", governance: "locked-rules" };
    const reviewPolicy = { schemaVersion: 1, project: "integration", dimensions: REVIEW_DIMENSIONS.map((d) => ({
      id: d.id, applicable: true, requiredEvidenceTypes: [reviewEvidenceTypes[d.id]] })) };
    writeFileSync(path.join(repo, "quality/review-policy.json"), JSON.stringify(reviewPolicy));
    writeFileSync(path.join(repo, "test.mjs"), "import {test} from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';test('candidate scanner returns validated finding schema',()=>{const result=JSON.parse(execFileSync(process.execPath,['scan.mjs'],{encoding:'utf8'}));assert(Array.isArray(result.findings));for(const f of result.findings){assert.equal(f.ruleId,'DEMO/E');assert.equal(f.severity,'error');assert.equal(f.file,'source.txt');}});");
    git(["add", "-A"], repo); git(["commit", "-qm", "initial"], repo); git(["push", "-q", "-u", "origin", "main"], repo);
    git(["push", "-q", "origin", "main:dev", "main:sit"], repo);
    const gateKeys = keyFiles(base, "gate"); const reviewKeys = keyFiles(base, "review"); const identityKeys = keyFiles(base, "identity");
    const config = loadConfig(repo);
    const pins = { project: "integration", expectPolicyHash: config.policyHash, expectRulesHash: config.ruleSetHash,
      expectPipelineId: "1", expectJobId: "2",
      expectIssuer: "quality-signer", publicKeyFile: gateKeys.publicKeyFile };
    const branch = (name, file, value) => {
      git(["fetch", "origin", "dev"], repo);
      git(["checkout", "-q", "-b", name, "origin/dev"], repo);
      writeFileSync(path.join(repo, file), value);
      git(["add", file], repo); git(["commit", "-qm", `feat(test): ${name}`], repo);
      git(["push", "-q", "-u", "origin", name], repo);
    };
    const candidate = async (source, extra = {}) => {
      const candidatePins = { ...pins, ...extra };
      const r = await promote({ root: repo, source, target: "dev", prepareCommand: "node --test test.mjs", ...candidatePins });
      if (r.exitCode !== 0) return { result: r };
      const record = readJson(r.recordFile);
      const summaryFile = path.join(r.outDir, "quality-summary.json");
      const attestationFile = path.join(r.outDir, "signed-proof.json");
      writeFileSync(attestationFile, JSON.stringify(signGateProof({ ...candidatePins, privateKeyFile: gateKeys.privateKeyFile,
        summaryFile, sha: record.candidateSha, profile: "standard", issuer: "quality-signer", pipelineId: "1", jobId: "2", promotionRecordFile: r.recordFile })));
      // Continue the exact automatic draft produced by this candidate, after
      // its worktree has been deleted. Supplement real local Git/test/lock facts;
      // reviewer/UI applicability and identity remain explicitly isolated facts.
      const auto = record.review, evidenceRoot = path.join(r.outDir, auto.evidenceRoot);
      const automaticRecordFile = path.join(r.outDir, auto.recordFile), inputFile = path.join(r.outDir, auto.inputFile);
      const automaticRecord = readJson(automaticRecordFile);
      check("automatic-candidate-review-context-and-archive-resolve", automaticRecord.source === record.source && automaticRecord.target === record.target &&
        automaticRecord.sourceSha === record.sourceSha && automaticRecord.targetBeforeSha === record.targetBeforeSha && existsSync(path.join(r.outDir, auto.bodyFile)));
      const candidateFile = path.join(evidenceRoot, "candidate-facts.json");
      const testRun = readJson(record.preparation.logFile);
      if (testRun.exitCode !== 0 || testRun.timedOut || testRun.truncated) throw new Error("候选工作树实际测试未通过");
      writeFileSync(path.join(evidenceRoot, "test-results.tap"), testRun.stdout);
      writeFileSync(path.join(evidenceRoot, "git-commits.json"), JSON.stringify({ candidateSha: record.candidateSha,
        log: git(["log", "--format=%H %ae %s", `${record.targetBeforeSha}..${record.candidateSha}`], repo) }));
      writeFileSync(candidateFile, JSON.stringify(record));
      writeFileSync(path.join(evidenceRoot, "locked-rules.json"), git(["show", `${record.candidateSha}:quality/rules.lock.json`], repo));
      writeFileSync(path.join(evidenceRoot, "review-checklist.json"), JSON.stringify({ candidateSha: record.candidateSha,
        facts: "Independent identity and reviewer decisions below are isolated contract fixtures, not production approvals", requiredDimensions: REVIEW_DIMENSIONS.map((d) => d.id) }));
      writeFileSync(path.join(evidenceRoot, "ui-scope-review.json"), JSON.stringify({ candidateSha: record.candidateSha,
        changedFiles: git(["diff", "--name-only", record.targetBeforeSha, record.candidateSha], repo), conclusion: "Isolated non-UI fixture; no browser/UI coverage claimed; independent review still required" }));
      const files = { submission: "git-commits.json", branch: "candidate-facts.json", ui: "ui-scope-review.json", review: "review-checklist.json",
        tests: "test-results.tap", cicd: "candidate-facts.json", governance: "locked-rules.json" };
      const draft = supplementReviewDraft({ inputFile, recordFile: automaticRecordFile, evidenceRoot, authorId: "author",
        evidence: Object.entries(files).map(([id, file]) => ({ id: `candidate-${id}`, type: reviewEvidenceTypes[id],
          source: ["ui", "review"].includes(id) ? "isolated/explicit-reviewer-facts" : "isolated/actual-local-git-tests-and-lock",
          project: "integration", candidateSha: record.candidateSha, file, dimensionIds: [id] })), outDir: path.join(evidenceRoot, "supplemented-draft") });
      const supplemented = readJson(draft.recordFile);
      check("supplement-preserves-auto-review-and-machine-evidence", supplemented.content.reviewId === automaticRecord.content.reviewId &&
        supplemented.content.derivedFrom.reviewDigest === automaticRecord.reviewDigest && automaticRecord.content.evidence.every((e) => supplemented.content.evidence.some((n) => n.id === e.id && n.sha256 === e.sha256)));
      const reviewAuthorizationFile = path.join(r.outDir, "review-authorization.json"), at = new Date();
      writeFileSync(reviewAuthorizationFile, JSON.stringify(signRecord({ schemaVersion: 1, kind: "review-authorization", authorizationId: "isolated-approval", issuer: "isolated-identity-authority",
        identitySource: "explicitly simulated independent reviewer", scope: "review-publish", decision: "approved", actorId: "reviewer", authorId: "author",
        project: "integration", candidateSha: record.candidateSha, reviewDigest: draft.reviewDigest, bodyDigest: draft.bodyDigest, evidenceDigest: draft.evidenceDigest,
        createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + 3600000).toISOString(), reason: "Isolated contract acceptance, not production approval",
        dimensionDecisions: REVIEW_DIMENSIONS.map((d) => ({ id: d.id, decision: "approved", reason: "Simulated independent review for this fixture" })) }, identityKeys.privateKeyFile)));
      const reviewFile = path.join(r.outDir, "review.json");
      writeFileSync(reviewFile, JSON.stringify(signReviewRecord({ ...candidatePins, recordFile: draft.recordFile, privateKeyFile: reviewKeys.privateKeyFile,
        authorizationFile: reviewAuthorizationFile, authorizationPublicKeyFile: identityKeys.publicKeyFile, expectAuthorizationIssuer: "isolated-identity-authority",
        evidenceRoot, expectReviewPolicyHash: draft.policyHash,
        project: "integration", sha: record.candidateSha, reviewerId: "reviewer", authorId: "author" })));
      return { result: r, record, apply: { ...candidatePins, recordFile: r.recordFile, remoteUrl: bare, attestationFile, summaryFile,
        reviewFile, reviewEvidenceRoot: evidenceRoot, authorizationPublicKeyFile: identityKeys.publicKeyFile,
        expectAuthorizationIssuer: "isolated-identity-authority", expectReviewPolicyHash: draft.policyHash, reviewPublicKeyFile: reviewKeys.publicKeyFile } };
    };

    branch("dev-409322-good", "feature.txt", "feature");
    const before = git(["rev-parse", "dev"], bare);
    const good = await candidate("dev-409322-good");
    check("candidate-check-does-not-update-target", good.result.exitCode === 0 && git(["rev-parse", "dev"], bare) === before, good.result.reasons.join("; "));
    check("missing-review-rejected", applyPromotion({ ...good.apply, reviewFile: path.join(base, "missing.json") }).exitCode === 2 && git(["rev-parse", "dev"], bare) === before);
    const unsignedReview = path.join(base, "unsigned-review.json");
    const review = readJson(good.apply.reviewFile); delete review.signature; writeFileSync(unsignedReview, JSON.stringify(review));
    check("unsigned-review-rejected", applyPromotion({ ...good.apply, reviewFile: unsignedReview }).exitCode === 2);
    writeFileSync(unsignedReview, JSON.stringify(signRecord({ ...review, reviewerId: "author" }, reviewKeys.privateKeyFile)));
    check("self-review-rejected", applyPromotion({ ...good.apply, reviewFile: unsignedReview }).exitCode === 2);

    const marker = path.join(base, "project-hook-executed");
    const hook = path.join(repo, ".git/hooks/pre-push");
    writeFileSync(hook, `#!/bin/sh\nprintf executed > ${quote(marker)}\n`);
    chmodSync(hook, 0o755);
    const control = spawnSync(hook, [], { cwd: repo, encoding: "utf8" });
    check("project-hook-positive-control", control.status === 0 && existsSync(marker));
    rmSync(marker, { force: true });
    const applied = applyPromotion(good.apply);
    check("signed-review-and-proof-promote", applied.exitCode === 0 && git(["rev-parse", "dev"], bare) === good.record.candidateSha, applied.reasons.join("; "));
    check("privileged-controller-never-runs-project-hook", !existsSync(marker));

    branch("dev-409322-bad", "source.txt", "bad");
    const bad = await candidate("dev-409322-bad");
    check("bad-candidate-blocked-and-failure-archived", bad.result.exitCode === 1 && existsSync(path.join(bad.result.outDir, "quality-summary.json")) && git(["rev-parse", "dev"], bare) === good.record.candidateSha);
    try { await promote({ root: repo, source: "dev", target: "main", ...pins }); check("invalid-flow-rejected", false); }
    catch { check("invalid-flow-rejected", true); }
    try { await promote({ root: repo, source: "dev-409322-good", target: "dev", push: true, ...pins }); check("legacy-push-disabled", false); }
    catch { check("legacy-push-disabled", true); }

    branch("dev-409322-a", "a.txt", "A"); const a = await candidate("dev-409322-a");
    branch("dev-409322-b", "b.txt", "B"); const b = await candidate("dev-409322-b");
    const first = applyPromotion(a.apply); const second = applyPromotion(b.apply);
    check("competing-candidates-reject-stale-target", first.exitCode === 0 && second.exitCode === 2 && git(["rev-parse", "dev"], bare) === a.record.candidateSha, second.reasons.join("; "));

    branch("dev-409322-race", "race.txt", "race"); const race = await candidate("dev-409322-race");
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const wrapperDir = path.join(base, "git-wrapper"); mkdirSync(wrapperDir);
    const raceMarker = path.join(base, "race-injected");
    writeFileSync(path.join(wrapperDir, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('push')&&!fs.existsSync(${JSON.stringify(raceMarker)})){const p=spawnSync(${JSON.stringify(realGit)},['--git-dir',${JSON.stringify(bare)},'update-ref','refs/heads/dev',${JSON.stringify(race.record.sourceSha)},${JSON.stringify(race.record.targetBeforeSha)}],{encoding:'utf8'});if(p.status!==0){process.stderr.write(p.stderr);process.exit(2);}fs.writeFileSync(${JSON.stringify(raceMarker)},'injected');}const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??2);\n`, { mode: 0o755 });
    const previousPath = process.env.PATH; let raced;
    try { process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath}`; raced = applyPromotion(race.apply); }
    finally { process.env.PATH = previousPath; }
    check("atomic-lease-rejects-target-ancestor-race-at-push", raced.exitCode === 2 && existsSync(raceMarker) && git(["rev-parse", "dev"], bare) === race.record.sourceSha, raced.reasons.join("; "));

    const preparation = await promote({ root: repo, source: "dev-409322-b", target: "dev", ...pins,
      prepareCommand: `node -e 'console.error("private mirror unavailable token=private123");process.exit(7)'` });
    const prepRecord = readJson(preparation.recordFile), prepLog = readJson(prepRecord.preparation.logFile);
    check("failed-prepare-preserves-redacted-diagnostic", preparation.exitCode === 2 && prepLog.exitCode === 7 && /private mirror unavailable/.test(prepLog.stderr) && !prepLog.stderr.includes("private123"));

    branch("dev-409322-baseline", "quality/baseline.json", JSON.stringify({ items: [] }));
    writeFileSync(path.join(repo, "quality/waivers.json"), "[]"); commitExtra();
    function commitExtra() { git(["add", "quality/waivers.json"], repo); git(["commit", "-qm", "approved-waivers"], repo); git(["push", "-q", "origin", "dev-409322-baseline"], repo); }
    const unapproved = await candidate("dev-409322-baseline");
    check("candidate-rejects-unapproved-baseline", unapproved.result.exitCode === 2);
    const approvedConfig = loadConfig(repo);
    const approved = await candidate("dev-409322-baseline", { expectBaselineHash: approvedConfig.baselineHash, expectWaiversHash: approvedConfig.waiversHash });
    check("candidate-and-controller-carry-approved-baseline-waivers", approved.result.exitCode === 0 && applyPromotion(approved.apply).exitCode === 0);

    const cli = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: "utf8" });
    git(["checkout", "-q", "main"], repo);
    const sha = git(["rev-parse", "HEAD"], repo);
    const run = cli(["run", "--profile", "release", "--sha", sha, "--env", "prd"]);
    mkdirSync(path.join(repo, "dist")); writeFileSync(path.join(repo, "dist/app.js"), "release-build");
    const manifest = path.join(repo, "quality-reports/artifact-manifest.json");
    const m = cli(["manifest", "--project", "integration", "--env", "prd", "--artifacts", "dist", "--out", manifest]);
    const proof = path.join(repo, "quality-reports/release-proof.json");
    const args = ["--project", "integration", "--sha", sha, "--env", "prd", "--expect-policy-hash", pins.expectPolicyHash, "--expect-rules-hash", pins.expectRulesHash,
      "--summary", path.join(repo, "quality-reports/quality-summary.json"), "--manifest", manifest];
    const signed = cli(["attest", ...args, "--profile", "release", "--private-key", gateKeys.privateKeyFile, "--issuer", "quality-signer", "--pipeline-id", "3", "--job-id", "4", "--out", proof]);
    const verifyArgs = ["verify-artifact", proof, ...args, "--public-key", gateKeys.publicKeyFile, "--expect-issuer", "quality-signer", "--expect-pipeline-id", "3", "--expect-job-id", "4", "--artifact-root", repo];
    const verified = cli(verifyArgs);
    check("release-cli-manifest-sign-verify", [run, m, signed, verified].every((r) => r.status === 0), [run, m, signed, verified].map((r) => `${r.status}:${r.stderr}`).join("; "));
    writeFileSync(path.join(repo, "dist/app.js"), "replaced-build");
    check("release-cli-rejects-replaced-artifact", cli(verifyArgs).status === 2);
  } catch (e) { check("integration-setup", false, e.stack); }
  finally { rmSync(base, { recursive: true, force: true }); }
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runIntegration();
