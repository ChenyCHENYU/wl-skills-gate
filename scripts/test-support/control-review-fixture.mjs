import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createReviewCollectFixture } from './review-collect-fixture.mjs';
import { collectReviewEvidence } from '../../lib/review-collect.js';
import { registerControlReview, createControlHandler } from '../../lib/control-service.js';
import { signReviewRecord, verifyReview } from '../../lib/evidence.js';
const hash = (value) => createHash('sha256').update(value).digest('hex'), now = Date.parse('2026-10-15T00:00:00Z'), origin = 'https://quality.example.invalid';
const json = (file, value) => writeFileSync(file, JSON.stringify(value));
export async function createControlReviewFixture(t, extra) {
  const f = await createReviewCollectFixture(t, { ...extra, ...(extra?.supplement ? { canonicalTypes: true } : {}) }), keys = {};
  for (const name of ['receipt', 'authorization', 'identity', 'review']) {
    keys[name] = generateKeyPairSync('ed25519');
    writeFileSync(path.join(f.root, `${name}-private.pem`), keys[name].privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(path.join(f.root, `${name}-public.pem`), keys[name].publicKey.export({ type: 'spki', format: 'pem' }));
  }
  const governanceConfigFile = path.join(f.root, 'governance.json'), controlConfigFile = path.join(f.root, 'control.json');
  json(governanceConfigFile, { schemaVersion: 1, issuer: 'central', publicKeyFile: path.join(f.root, 'receipt-public.pem'), allowedLinkOrigins: [origin], operators: ['operator'],
    projects: { demo: { owner: 'owner', backup: 'backup', escalationOwner: 'manager', reviewers: ['reviewer', 'author'], channel: 'group', issueBaseUrl: origin + '/issues',
      scopes: { standard: { requiredChecks: ['CHECK'], policyHash: 'a'.repeat(64), rulesHash: 'a'.repeat(64), baselineHash: 'a'.repeat(64), waiversHash: 'a'.repeat(64) } } } }, channels: { group: { type: 'feishu', webhookEnv: 'GROUP_WEBHOOK', signingSecretEnv: 'GROUP_SECRET' } } });
  if (extra?.supplement) {
    f.collector.supplement = { governanceConfigFile, authorizationPublicKeyFile: path.join(f.root, 'authorization-public.pem'), authorizationIssuer: 'identity-authority' }; json(f.configFile, f.collector);
  }
  const draft = collectReviewEvidence(f.options);
  const c = { schemaVersion: 1, origin, governanceConfigFile, stateFile: path.join(f.root, 'ledger.json'), dataDir: path.join(f.root, 'control'), receiptPrivateKeyFile: path.join(f.root, 'receipt-private.pem'), authorizationPrivateKeyFile: path.join(f.root, 'authorization-private.pem'), authorizationIssuer: 'identity-authority',
    reviewPolicies: { demo: { policyHash: f.collector.reviewPolicyHash, evidenceRoot: f.root, collectorConfigFile: f.configFile } }, identity: { algorithm: 'EdDSA', keyId: 'identity-key', publicKeyFile: path.join(f.root, 'identity-public.pem'), issuer: 'https://identity.example.invalid', authorizationEndpoint: 'https://identity.example.invalid/authorize', tokenEndpoint: 'https://identity.example.invalid/token', clientId: 'quality', subjects: { 'user-author': 'author', 'user-reviewer': 'reviewer' } } };
  json(controlConfigFile, c);
  let nonce, challenge, subject;
  const handler = createControlHandler({ configFile: controlConfigFile, clock: () => now, env: { TOKEN: 'secret' }, fetchImpl: async (url, init) => {
    if (url !== c.identity.tokenEndpoint) return f.fetchImpl(url, init);
    assert.equal(url, c.identity.tokenEndpoint); const form = new URLSearchParams(init.body); assert.equal(form.get('code'), 'valid-code');
    assert.equal(hash(form.get('code_verifier')), Buffer.from(challenge, 'base64url').toString('hex'));
    const parts = [Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'identity-key' })).toString('base64url'), Buffer.from(JSON.stringify({ iss: c.identity.issuer, aud: 'quality', sub: subject, nonce, iat: now / 1000, exp: now / 1000 + 3600 })).toString('base64url')];
    const id_token = parts.join('.') + '.' + sign(null, Buffer.from(parts.join('.')), keys.identity.privateKey).toString('base64url'); return new Response(JSON.stringify({ id_token }));
  } });
  const http = ({ url = '/reviews/review-1', method = 'GET', cookie, body, chunks } = {}) => new Promise((resolve, reject) => {
    const req = Readable.from(chunks || (body ? [Buffer.from(body)] : [])); req.url = url; req.method = method;
    req.headers = { host: new URL(origin).host, ...(cookie ? { cookie } : {}), ...(body || chunks ? { origin, 'content-type': 'application/x-www-form-urlencoded' } : {}) };
    handler(req, { writeHead(status, headers) { this.status = status; this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), k.toLowerCase() === 'set-cookie' && !Array.isArray(v) ? [v] : v])); }, end(text) { resolve({ status: this.status, headers: this.headers, text }); } }).catch(reject);
  });
  const login = async (actor = 'reviewer') => {
    subject = `user-${actor}`; const start = await http({ url: '/auth/login?return=%2Freviews%2Freview-1' }), u = new URL(start.headers.location);
    nonce = u.searchParams.get('nonce'); challenge = u.searchParams.get('code_challenge');
    const accepted = await http({ url: `/auth/callback?code=valid-code&state=${u.searchParams.get('state')}`, cookie: start.headers['set-cookie'][0].split(';')[0] });
    assert.equal(accepted.status, 302, accepted.text); return accepted.headers['set-cookie'][0].split(';')[0];
  };
  const register = () => registerControlReview({ configFile: controlConfigFile, reviewId: 'review-1', recordFile: draft.recordFile, evidenceRoot: f.options.evidenceRoot, provenanceFile: draft.provenanceFile, now });
  const form = async (cookie) => {
    const page = await http({ cookie }); assert.equal(page.status, 200, page.text);
    const fields = { csrf: page.text.match(/name="csrf" value="([^"]+)"/)?.[1], reviewDigest: draft.reviewDigest, reason: '已逐维查看原始证据并明确确认' };
    for (const d of JSON.parse(readFileSync(draft.recordFile)).content.dimensions) { fields[`decision_${d.id}`] = d.applicable ? 'approved' : 'not-applicable'; fields[`reason_${d.id}`] = '本次变更已查看证据，风险和适用范围已核实'; }
    return { page, fields };
  };
  return { ...f, draft, c, controlConfigFile, http, login, register, form };
}
