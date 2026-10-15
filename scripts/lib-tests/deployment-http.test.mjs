import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { executeHttpDeployment } from "../../templates/ci/controlled-deployment-http.mjs";
const hash = "a".repeat(64);
function fixture(t, action = "deploy") {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "wl-deployment-http-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contextFile = path.join(dir, "context.json"), configFile = path.join(dir, "config.json"), resultFile = path.join(dir, "result.json");
  const context = { schemaVersion: 1, kind: "deployment-context", executionId: "execution-1", action, environment: "uat", releaseSetHash: hash, compatibilityHash: hash, apiContractHash: hash, expectedSchemaVersion: "schema-1", deploymentOrder:["api","ui"], databaseExecution:{mode:"none",fromSchema:"schema-1",toSchema:"schema-1"}, releaseSet: { fixed: true }, currentDeploymentId: "deployment-1", requiredSmokeChecks: ["version", "health"], resultFile };
  const config = { schemaVersion: 1, apiBaseUrl: "https://deployment.example.invalid", tokenEnv: "TOKEN", recordBaseUrl: "https://quality.example.invalid/records", requestTimeoutMs: 1000, pollTimeoutMs: 5000, pollIntervalMs: 250, checks: [{ id: "version", url: "https://runtime.example.invalid/version", expectedStatus: 200, releaseSetField: "releaseSetHash" }, { id: "health", url: "https://runtime.example.invalid/health", expectedStatus: 200, expectedText: "UP" }] };
  writeFileSync(contextFile, JSON.stringify(context)); writeFileSync(configFile, JSON.stringify(config));
  const actual = { deploymentId: "deployment-1", environment: "uat", releaseSetHash: hash, compatibilityHash: hash, apiContractHash: hash, databaseSchemaVersion:"schema-1", appliedDeploymentOrder:["api","ui"], status: "succeeded" };
  return { dir, context, contextFile, config, configFile, resultFile, actual, env: { TOKEN: "private-read-deploy-token" } };
}
test("HTTP部署适配器以固定组合发起操作、轮询真实结果并再取当前环境版本", async (t) => {
  const f = fixture(t); let posts = 0, polls = 0, current = 0;
  const result = await executeHttpDeployment({ ...f, wait: async () => {}, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, `Bearer ${f.env.TOKEN}`);
    if (options.method === "POST") { posts++; const input = JSON.parse(options.body); assert.equal(input.releaseSetHash, hash); assert.equal(input.expectedCurrentDeploymentId, "deployment-1"); return new Response(JSON.stringify({ ...f.actual, status: "accepted" })); }
    if (url.includes("/deployments/")) polls++; else current++;
    return new Response(JSON.stringify(f.actual));
  } });
  assert.equal(result.result, "passed"); assert.equal(posts, 1); assert.equal(polls, 1); assert.equal(current, 1); assert.ok(!readFileSync(path.join(f.dir, result.observationFile), "utf8").includes(f.env.TOKEN));
});
test("HTTP冒烟不向运行服务泄露部署凭据，逐项持有真实原始响应", async (t) => {
  const f = fixture(t, "smoke");
  const result = await executeHttpDeployment({ ...f, fetchImpl: async (url, options) => {
    if (url.includes("deployment.example.invalid")) { assert.ok(options.headers.Authorization); return new Response(JSON.stringify(f.actual)); }
    assert.equal(options.headers.Authorization, undefined);
    return new Response(url.endsWith("/version") ? JSON.stringify({ releaseSetHash: hash }) : "UP");
  } });
  assert.equal(result.checks.length, 2); assert.ok(result.checks.every((c) => existsSync(path.join(f.dir, c.evidenceFile))));
});
test("真实当前版本不一致或业务冒烟失败，禁止产生通过回执", async (t) => {
  for (const mode of ["current", "business"]) {
    const f = fixture(t, "smoke");
    await assert.rejects(executeHttpDeployment({ ...f, fetchImpl: async (url) => {
      if (url.includes("deployment.example.invalid")) return new Response(JSON.stringify({ ...f.actual, ...(mode === "current" ? { releaseSetHash: "b".repeat(64) } : {}) }));
      return new Response(url.endsWith("/version") ? JSON.stringify({ releaseSetHash: hash }) : "DOWN");
    } }));
    assert.equal(existsSync(f.resultFile), false);
  }
});
test("恢复使用同一受控接口显式recover，无法把API失败或取消写成成功", async (t) => {
  const f = fixture(t, "recover");
  await assert.rejects(executeHttpDeployment({ ...f, fetchImpl: async (_url, options) => { assert.equal(JSON.parse(options.body).action, "recover"); return new Response(JSON.stringify({ ...f.actual, status: "canceled" })); } }), /failed\/canceled/);
  assert.equal(existsSync(f.resultFile), false);
});

test("未知部署结果先查询实际目标，只在授权的旧/尝试组合内恢复并绑定实际记录", async (t) => {
  const f = fixture(t, "recover"), attemptedHash = "b".repeat(64); f.context.reconciliationRequired = true; f.context.allowedCurrentReleaseSetHashes = [hash, attemptedHash]; writeFileSync(f.contextFile, JSON.stringify(f.context)); let posts = 0;
  await executeHttpDeployment({ ...f, fetchImpl: async (_url, options) => {
    if (options.method === "POST") { posts++; assert.equal(JSON.parse(options.body).expectedCurrentDeploymentId, "uncertain-new-record"); return new Response(JSON.stringify(f.actual)); }
    return new Response(JSON.stringify(posts ? f.actual : { ...f.actual, deploymentId: "uncertain-new-record", releaseSetHash: attemptedHash }));
  } }); assert.equal(posts, 1);
});

test("目标未实现API/数据库/顺序契约或实际顺序错误，不能把整包接收当发布成功", async (t) => {
  for (const change of [(v) => delete v.compatibilityHash, (v) => v.databaseSchemaVersion = "schema-wrong", (v) => v.appliedDeploymentOrder = ["ui", "api"], (v) => v.apiContractHash = "b".repeat(64)]) {
    const f = fixture(t); const actual = { ...f.actual }; change(actual);
    await assert.rejects(executeHttpDeployment({ ...f, fetchImpl: async (_url, options) => { const request = JSON.parse(options.body); assert.deepEqual(request.deploymentOrder, ["api", "ui"]); assert.equal(request.compatibilityHash, hash); assert.equal(request.databaseExecution.toSchema, "schema-1"); return new Response(JSON.stringify(actual)); } }), /contract\/schema\/deployment order/);
    assert.equal(existsSync(f.resultFile), false);
  }
});
