import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { controlledPath, readControlledJson } from './control-store.js';
import { collectCiSource } from './ci-source.js';
import { loadReviewCollectorConfig, verifyCollectedReview } from './review-collect.js';
import { stableStringify } from './util.js';

const facts = (v) => Object.fromEntries(['project', 'scope', 'system', 'sha', 'ref', 'configHash', 'runId', 'jobId', 'jobStatus', 'status', 'authorId', 'requiredJobs', 'artifacts', 'missingArtifacts'].map((key) => [key, v[key] ?? null]));

// Authorization checks current CI facts, not merely the historical downloaded
// bytes. Keep every refresh attempt for audit, including mismatches/failures.
export async function verifyLiveCiReview({ configFile, recordFile, evidenceRoot, provenanceFile, outDir, env = process.env, fetchImpl = fetch, now = Date.now() }) {
  const checked = verifyCollectedReview({ configFile, recordFile, evidenceRoot, provenanceFile, now }), config = loadReviewCollectorConfig(configFile);
  const output = controlledPath(outDir); mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  const requestFile = path.join(output, 'request.json'), previous = checked.observation;
  writeFileSync(requestFile, JSON.stringify({ sha: previous.sha, runId: previous.runId, sequence: previous.sequence, authorId: previous.authorId }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    const current = await collectCiSource({ configFile: config.ciConfigFile, requestFile, outDir: path.join(output, 'current'), env, fetchImpl, now });
    const observation = readControlledJson(current.sourceFile), unchanged = stableStringify(facts(previous)) === stableStringify(facts(observation));
    writeFileSync(path.join(output, 'comparison.json'), JSON.stringify({ schemaVersion: 1, kind: 'review-live-ci-check', project: checked.project,
      candidateSha: checked.candidateSha, unchanged, originalSourceHash: checked.provenance.sourceFileHash,
      sourceFile: current.sourceFile, observedAt: new Date(now).toISOString(), approved: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (!unchanged) throw new Error('CI当前必需作业/工件事实已变化，旧Review表单不能批准；等待中央自动生成最新证据版本');
    return { ok: true, sourceFile: current.sourceFile, outDir: output, candidateSha: checked.candidateSha };
  } catch (error) {
    writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ schemaVersion: 1, kind: 'review-live-ci-check', status: 'rejected',
      reason: error.message, candidateSha: checked.candidateSha, at: new Date(now).toISOString(), authorized: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    throw error;
  }
}
