import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectCiSource } from '../../lib/ci-source.js';
import { autoReviewDraft } from '../../lib/review-auto.js';
import { REVIEW_DIMENSIONS } from '../../lib/review.js';
import { collectReviewEvidence, verifyCollectedReview } from '../../lib/review-collect.js';
import { stableStringify } from '../../lib/util.js';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = 'b'.repeat(40), digest = 'a'.repeat(64), now = Date.parse('2026-10-15T00:00:00Z'), origin = 'https://ci.example.invalid';
export async function createReviewCollectFixture(t, { missing = false, failed = false, candidateContext, otherJobFailed = false, includeOtherJob = false, optionalMissing = [], sequence = 3, canonicalTypes = false, branch = "dev", scope = "standard", parent, pipelineId = 45, jobId = 60 } = {}) {
  const root = mkdtempSync(path.join(parent || realpathSync(tmpdir()), 'wl-review-collect-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'quality')); mkdirSync(path.join(root, 'quality-reports'));
  const evidenceType = (id) => canonicalTypes ? ({ submission: 'commit-check', branch: 'branch-check', ui: 'ui-verification', review: 'impact-review', tests: 'test-verification', cicd: 'pipeline-verification', governance: 'ownership-verification' }[id]) : `${id}-evidence`;
  const policy = { schemaVersion: 1, project: 'demo', dimensions: REVIEW_DIMENSIONS.map((d) => ({ id: d.id, applicable: true, requiredEvidenceTypes: [ ['coding', 'scan'].includes(d.id) ? 'gate-summary' : evidenceType(d.id) ] })) };
  write(path.join(root, 'quality/review-policy.json'), policy);
  const summary = { schemaVersion: 1, run: { project: 'demo', profile: 'standard', commitSha: sha, eventId: 'gate-1', startedAt: new Date(now).toISOString(), durationMs: 1, tool: 'gate', sourceBound: true, sourceDigest: digest },
    policy: { policyHash: digest, ruleSetHash: digest, baselineHash: digest, waiversHash: digest, requiredCheckIds: ['CHECK'], lockedToolVersions: { CHECK: 'fixture@1' }, checksSelected: 1 },
    checks: [{ checkId: 'CHECK', status: 'ok', required: true, toolVersionVerified: true, toolVersion: 'fixture@1' }], findings: failed ? [{ fingerprint: digest, ruleId: 'R', file: 'src.js', severity: 'error', status: 'new' }] : [], counts: { blockingNew: failed ? 1 : 0 }, decision: { status: failed ? 'blocked' : 'passed', reasons: [] } };
  write(path.join(root, 'quality-reports/quality-summary.json'), summary);
  const automatic = autoReviewDraft({ root, outDir: path.join(root, 'quality-reports'), summary, context: { sourceBranch: 'dev-feature', targetBranch: 'dev', sourceSha: sha, targetBeforeSha: 'c'.repeat(40) } });
  const mappings = REVIEW_DIMENSIONS.filter((d) => !['coding', 'scan'].includes(d.id)).map((d) => ({ id: d.id, type: evidenceType(d.id), path: `review/${d.id}.json`, dimensionIds: [d.id] }));
  const ciConfig = { schemaVersion: 1, system: 'gitlab', project: 'demo', scope, baseUrl: origin, tokenEnv: 'TOKEN', ref: branch, requiredJobs: ['quality'], artifacts: { job: 'quality', paths: ['quality/summary.json', ...mappings.map((m) => m.path), ...(candidateContext ? ['review/candidate-context.json'] : [])] }, qualitySummary: 'quality/summary.json', projectId: 12, trustedRunnerIds: [77] };
  const ciConfigFile = path.join(root, 'ci-config.json'), configFile = path.join(root, 'review-collector.json'), requestFile = path.join(root, 'request.json');
  const collector = { schemaVersion: 1, project: 'demo', ciConfigFile, reviewPolicyHash: hash(stableStringify(policy)), allowedAuthorIds: ['author'], evidence: mappings };
  if (otherJobFailed || includeOtherJob) ciConfig.requiredJobs.push('tests');
  if (optionalMissing.length) ciConfig.artifacts.optionalPaths = optionalMissing;
  write(ciConfigFile, ciConfig); write(configFile, collector); write(requestFile, { sha, runId: pipelineId, sequence, authorId: 'author' });
  const pipeline = { id: pipelineId, project_id: 12, sha, ref: branch, web_url: `${origin}/p/${pipelineId}` }, job = { id: jobId, name: 'quality', pipeline: { id: pipelineId }, commit: { id: sha }, ref: branch, runner: { id: 77 }, allow_failure: false, status: failed ? 'failed' : 'success', web_url: `${origin}/j/${jobId}` };
  const contents = Object.fromEntries(mappings.map((m) => [m.path, JSON.stringify({ dimension: m.dimensionIds[0], note: '原始工作成果；仅证明来源/字节，仍需独立复核', candidateSha: sha })]));
  if (candidateContext) contents['review/candidate-context.json'] = JSON.stringify(candidateContext);
  contents['quality/summary.json'] = readFileSync(path.join(root, 'quality-reports/quality-summary.json'));
  const ciState = { otherJobFailed, testsJobId: 61, unavailable: false };
  const fetchImpl = async (url) => {
    if (ciState.unavailable) throw new Error('isolated CI temporarily unavailable');
    const route = new URL(url).pathname;
    for (const [file, value] of Object.entries(contents)) if (route.endsWith(`/artifacts/${file}`)) return new Response((missing && file === 'review/ui.json') || optionalMissing.includes(file) ? '' : value, { status: (missing && file === 'review/ui.json') || optionalMissing.includes(file) ? 404 : 200 });
    return new Response(JSON.stringify(route.endsWith(`/pipelines/${pipelineId}`) ? pipeline : route.endsWith('/jobs') ? [job, ...((otherJobFailed || includeOtherJob) ? [{ ...job, name: 'tests', id: ciState.testsJobId, status: ciState.otherJobFailed ? 'failed' : 'success' }] : [])] : job));
  };
  const recollect = (name) => collectCiSource({ configFile: ciConfigFile, requestFile, outDir: path.join(root, name), now, env: { TOKEN: 'secret' }, fetchImpl });
  const collection = await recollect('ci-observation');
  const options = { configFile, sourceFile: collection.sourceFile, inputFile: automatic.inputFile, recordFile: automatic.recordFile, evidenceRoot: automatic.evidenceRoot, outDir: path.join(automatic.evidenceRoot, 'collected'), now };
  return { root, pipelineId, jobId, branch, scope, automatic, ciConfigFile, configFile, collector, options, summary, collection, fetchImpl, ciState, ciContents: contents, recollect };
}
