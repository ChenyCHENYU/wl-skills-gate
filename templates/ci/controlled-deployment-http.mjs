// Fixed, approved adapter for an existing deployment API. Projects never supply
// shell text. Use an already approved site adapter in deployment-config.json
// when the actual deployment system has a different API protocol.
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export async function executeHttpDeployment({ contextFile, configFile, env = process.env, fetchImpl = globalThis.fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), clock = Date.now }) {
  const context = JSON.parse(readFileSync(contextFile)), c = JSON.parse(readFileSync(configFile));
  assert(c.schemaVersion === 1 && context.kind === "deployment-context" && ["deploy", "smoke", "recover"].includes(context.action), "invalid approved deployment context");
  const base = new URL(c.apiBaseUrl), recordBase = new URL(c.recordBaseUrl);
  assert(base.protocol === "https:" && base.origin === c.apiBaseUrl && !base.username && !base.password && recordBase.protocol === "https:" && !recordBase.username && !recordBase.password && !recordBase.search && !recordBase.hash, "invalid fixed deployment API/record origin");
  assert(/^[A-Z][A-Z0-9_]+$/.test(c.tokenEnv || "") && typeof env[c.tokenEnv] === "string" && env[c.tokenEnv], "missing controlled deployment credential");
  assert(Number.isSafeInteger(c.requestTimeoutMs) && c.requestTimeoutMs > 0 && c.requestTimeoutMs <= 60000 && Number.isSafeInteger(c.pollTimeoutMs) && c.pollTimeoutMs > 0 && c.pollTimeoutMs <= 900000 && Number.isSafeInteger(c.pollIntervalMs) && c.pollIntervalMs >= 250 && c.pollIntervalMs <= 10000, "invalid deployment timeout budgets");
  const responses = [], root = path.dirname(context.resultFile);
  async function request(url, method = "GET", payload, credential = true) {
    const target = new URL(url); assert(target.protocol === "https:" && !target.username && !target.password && !target.hash && (!credential || target.origin === base.origin), "deployment request escaped approved origin");
    const response = await fetchImpl(target.href, { method, headers: { ...(credential ? { Authorization: `Bearer ${env[c.tokenEnv]}` } : {}), ...(payload ? { "Content-Type": "application/json" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: "error", signal: AbortSignal.timeout(c.requestTimeoutMs) });
    const text = await response.text(); assert(Buffer.byteLength(text) <= 1024 * 1024, "deployment response too large");
    const record = { url: target.href, status: response.status, body: text }; responses.push(record); return record;
  }
  function parsed(record) { assert(record.status >= 200 && record.status < 300, "deployment API rejected operation"); try { return JSON.parse(record.body); } catch { throw new Error("deployment API response is not JSON"); } }
  function bound(value, expectedId) { assert(id(value.deploymentId) && (!expectedId || value.deploymentId === expectedId) && value.environment === context.environment && value.releaseSetHash === context.releaseSetHash, "actual deployment identity/version mismatch"); return value; }
  function compatible(value) {
    assert(value.compatibilityHash === context.compatibilityHash && value.apiContractHash === context.apiContractHash && value.databaseSchemaVersion === context.expectedSchemaVersion && JSON.stringify(value.appliedDeploymentOrder) === JSON.stringify(context.deploymentOrder), "actual API contract/schema/deployment order was not applied by target");
  }
  let deployment;
  if (context.action !== "smoke") {
    let expectedCurrentDeploymentId = context.currentDeploymentId;
    if (context.reconciliationRequired) {
      const observed = parsed(await request(`${base.origin}/environments/${encodeURIComponent(context.environment)}/current`));
      assert(id(observed.deploymentId) && observed.environment === context.environment && Array.isArray(context.allowedCurrentReleaseSetHashes) && context.allowedCurrentReleaseSetHashes.includes(observed.releaseSetHash), "uncertain prior target escaped authorized known/attempted release set");
      expectedCurrentDeploymentId = observed.deploymentId;
    }
    deployment = bound(parsed(await request(`${base.origin}/deployments`, "POST", { requestId: context.executionId, action: context.action, environment: context.environment, expectedCurrentDeploymentId, releaseSet: context.releaseSet, releaseSetHash: context.releaseSetHash, compatibilityHash: context.compatibilityHash, apiContractHash: context.apiContractHash, deploymentOrder: context.deploymentOrder, expectedSchemaVersion: context.expectedSchemaVersion, databaseExecution: context.databaseExecution, recoveryCompatibility: context.recoveryCompatibility })));
    const started = clock();
    while (["accepted", "running"].includes(deployment.status)) {
      assert(clock() - started <= c.pollTimeoutMs, "deployment polling timed out; actual outcome needs reconciliation"); await wait(c.pollIntervalMs);
      deployment = bound(parsed(await request(`${base.origin}/deployments/${encodeURIComponent(deployment.deploymentId)}`)), deployment.deploymentId);
    }
    assert(deployment.status === "succeeded", "deployment API reported failed/canceled outcome");
    compatible(deployment);
  }
  const current = bound(parsed(await request(`${base.origin}/environments/${encodeURIComponent(context.environment)}/current`)), deployment?.deploymentId || context.currentDeploymentId);
  assert(current.status === "succeeded", "current target does not contain successful selected release");
  compatible(current);
  const checks = [];
  if (context.action === "smoke") {
    assert(Array.isArray(c.checks) && c.checks.length === context.requiredSmokeChecks.length && new Set(c.checks.map((v) => v.id)).size === c.checks.length && context.requiredSmokeChecks.every((name) => c.checks.some((v) => v.id === name)), "approved smoke check set is incomplete");
    for (const check of c.checks) {
      assert(id(check.id) && Number.isSafeInteger(check.expectedStatus) && check.expectedStatus >= 200 && check.expectedStatus < 300 && (typeof check.expectedText === "string" && check.expectedText || typeof check.releaseSetField === "string" && check.releaseSetField), "smoke assertion is missing");
      const response = await request(check.url, "GET", undefined, false); assert(response.status === check.expectedStatus, "actual smoke HTTP status failed");
      if (check.expectedText) assert(response.body.includes(check.expectedText), "actual smoke business assertion failed");
      if (check.releaseSetField) assert(JSON.parse(response.body)[check.releaseSetField] === context.releaseSetHash, "runtime release fingerprint mismatch");
      const evidence = JSON.stringify(response), evidenceFile = `smoke-${check.id}.json`; writeFileSync(path.join(root, evidenceFile), evidence, { flag: "wx", mode: 0o600 });
      checks.push({ id: check.id, status: "passed", evidenceFile, evidenceHash: hash(evidence) });
    }
  }
  const observed = JSON.stringify({ operation: context.action, current, responses }), observationFile = "target-observation.json";
  writeFileSync(path.join(root, observationFile), observed, { flag: "wx", mode: 0o600 });
  const result = { schemaVersion: 1, kind: "deployment-command-result", action: context.action, executionId: context.executionId, environment: context.environment, releaseSetHash: context.releaseSetHash, actualReleaseSetHash: current.releaseSetHash, compatibilityHash: current.compatibilityHash, apiContractHash: current.apiContractHash, databaseSchemaVersion: current.databaseSchemaVersion, appliedDeploymentOrder: current.appliedDeploymentOrder, deploymentId: current.deploymentId, result: "passed", recordUrl: `${c.recordBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(current.deploymentId)}`, observationFile, observationHash: hash(observed), checks };
  writeFileSync(context.resultFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 }); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf("--wl-context"); assert(at >= 0 && process.argv[at + 1], "missing --wl-context");
    await executeHttpDeployment({ contextFile: process.argv[at + 1], configFile: path.join(path.dirname(fileURLToPath(import.meta.url)), "deployment-http.json") });
  } catch (error) { process.stderr.write(`controlled deployment failed: ${error.message}\n`); process.exitCode = 2; }
}
