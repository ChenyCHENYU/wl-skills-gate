#!/usr/bin/env node
import path from "node:path";
import { mkdirSync, writeFileSync, lstatSync, statSync, realpathSync } from "node:fs";
import { git } from "../lib/source-state.js";
import { runGate } from "../lib/run.js";
import { buildFixPlan, applyFixPlan } from "../lib/fix.js";
import { verifyArtifact } from "../lib/verify-artifact.js";
import { promote, applyPromotion } from "../lib/promote.js";
import { signGateProof, createArtifactManifest, signReviewRecord } from "../lib/evidence.js";
import { validateCommitMessage } from "../lib/commit-message.js";

const [command, ...rest] = process.argv.slice(2);
const FLAGS = new Set(["--confirm", "--push", "--allow-any", "--include-digest", "--send", "--watch"]);

function options(allowed) {
  const out = { positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!name.startsWith("--")) { out.positional.push(name); continue; }
    if (!allowed.includes(name) || Object.hasOwn(out, name)) throw new Error(`未知或重复参数: ${name}`);
    if (FLAGS.has(name) || command === "ci-prepare" && name === "--apply") { out[name] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${name} 缺少值`);
    out[name] = value;
  }
  if (out.positional.length > 1) throw new Error("位置参数过多");
  return out;
}

function writeJson(file, value) {
  if (!file) throw new Error("缺少 --out");
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
  console.log(`[${command}] 已写入 ${file}`);
}

function protectOutput(file, inputs = [], projectRoot) {
  if (!file) return;
  const destination = path.resolve(file); let current = path.parse(destination).root;
  for (const part of destination.slice(current.length).split(path.sep)) {
    current = path.join(current, part); let info;
    try { info = lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (info?.isSymbolicLink()) throw new Error("输出路径不能包含符号链接或断链");
  }
  let outputStat; try { outputStat = statSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const input of inputs.filter(Boolean)) {
    if (path.resolve(input) === destination) throw new Error("输出不能覆盖台账/配置/原输入或密钥");
    if (outputStat) { let inputStat; try { inputStat = statSync(input); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (inputStat && inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) throw new Error("输出不能覆盖原输入的硬链接别名"); }
  }
  if (projectRoot) {
    const root = path.resolve(projectRoot), relative = path.relative(root, destination);
    let tracked = []; try { tracked = git(["ls-files", "-z"], root).split("\0"); } catch {}
    if (tracked.includes(relative)) throw new Error("只读预检输出不能覆盖已跟踪项目文件");
  }
}

const PROOF_FLAGS = ["--summary", "--sha", "--project", "--env", "--expect-policy-hash", "--expect-rules-hash",
  "--expect-baseline-hash", "--expect-waivers-hash",
  "--expect-pipeline-id", "--expect-job-id",
  "--public-key", "--expect-issuer", "--max-age-minutes", "--manifest", "--artifact-root"];

function proofOptions(o) {
  return { attestationFile: o.positional[0], summaryFile: o["--summary"], sha: o["--sha"], project: o["--project"],
    env: o["--env"], expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"],
    expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"],
    expectPipelineId: o["--expect-pipeline-id"], expectJobId: o["--expect-job-id"],
    publicKeyFile: o["--public-key"], expectIssuer: o["--expect-issuer"],
    maxAgeMinutes: o["--max-age-minutes"] === undefined ? 1440 : Number(o["--max-age-minutes"]),
    manifestFile: o["--manifest"], artifactRoot: o["--artifact-root"] };
}

try {
  if (command === "run") {
    process.exitCode = (await runGate({ argv: rest })).exitCode;
  } else if (command === "report-publication") {
    const action = rest.shift(), o = options(["--input", "--summary", "--review-index", "--out-dir", "--jenkins-build-url", "--manifest", "--jenkins-origin", "--user-env", "--token-env", "--out"]);
    const r = await import("../lib/report-publication.js");
    let result;
    if (action === "archive") {
      if (!!o["--input"] === !!o["--summary"] || !o["--out-dir"]) throw new Error("归档需要--input或--summary二选一，以及--out-dir");
      const { readFileSync } = await import("node:fs");
      const input = o["--input"] ? JSON.parse(readFileSync(o["--input"], "utf8")) : r.publicationInput({ summaryFile: o["--summary"], reviewIndexFile: o["--review-index"] });
      result = r.archiveQualityReport({ input, outDir: path.resolve(o["--out-dir"]), jenkinsBuildUrl: o["--jenkins-build-url"] || process.env.BUILD_URL });
    } else if (action === "verify") {
      if (!o["--manifest"] || !(o["--jenkins-origin"] || process.env.JENKINS_URL)) throw new Error("验收需要--manifest和批准的Jenkins入口");
      const userEnv = o["--user-env"] || "WL_JENKINS_REPORT_USER", tokenEnv = o["--token-env"] || "WL_JENKINS_REPORT_TOKEN";
      if (![userEnv, tokenEnv].every((name) => /^[A-Z][A-Z0-9_]+$/.test(name))) throw new Error("凭据必须使用环境变量引用");
      result = await r.verifyPublishedQualityReport({ manifestFile: o["--manifest"], expectedOrigin: o["--jenkins-origin"] || process.env.JENKINS_URL, user: process.env[userEnv], token: process.env[tokenEnv] });
    } else throw new Error("report-publication仅支持archive或verify");
    if (o["--out"]) {
      const archiveDir = action === "archive" ? result.archiveDir : path.dirname(path.resolve(o["--manifest"]));
      const relative = path.relative(archiveDir, path.resolve(o["--out"]));
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("操作结果不能写入或覆盖固定报告归档");
      protectOutput(o["--out"], [o["--input"], o["--summary"], o["--review-index"], o["--manifest"]]); writeJson(o["--out"], result);
    }
    else console.log(JSON.stringify(result));
  } else if (command === "onboard") {
    const { runOnboardCli } = await import("../lib/onboard.js");
    process.exitCode = await runOnboardCli(rest);
  } else if (command === "setup") {
    const { runSetupCli } = await import("../lib/setup.js");
    process.exitCode = await runSetupCli(rest);
  } else if (command === "jenkins") {
    const { runJenkinsCli } = await import("../lib/jenkins-runtime.js");
    process.exitCode = await runJenkinsCli(rest);
  } else if (command === "java-tools") {
    const o=options(["--source","--archive","--python"]);
    const {javaDistribution,javaReferenceLock}=await import("../lib/java-distribution.js");
    javaReferenceLock();
    if(o.positional[0]==="pack") {
      if(!o["--source"] || !o["--archive"]) throw new Error("java-tools pack 需要 --source 固定参考目录和 --archive 新ZIP路径");
      protectOutput(o["--archive"]);
      const {runCommand,quote}=await import("../lib/exec.js"),{fileURLToPath}=await import("node:url");
      const r=await runCommand([o["--python"] || "python3","-B",fileURLToPath(new URL("../scripts/java-distribution.py",import.meta.url)),"pack","--directory",path.resolve(o["--source"]),"--archive",path.resolve(o["--archive"])].map(quote).join(" "),{timeoutMs:180000});
      if(r.code!==0) throw new Error("固定Java工具交付打包失败；检查分发摘要、Python及目标是否已存在");
      process.stdout.write(r.stdout);
    } else if(o.positional[0]==="prepare" && !o["--source"] && !o["--archive"]) {
      process.stdout.write(JSON.stringify(await javaDistribution({python:o["--python"] || "python3"}),null,2)+"\n");
    } else throw new Error("java-tools 仅支持 pack / prepare；普通项目由Gate自动准备，不需开发者执行");
  } else if (command === "ci-prepare") {
    const o = options(["--root", "--apply", "--confirm", "--expect-workspace-hash", "--expect-lock-hash"]);
    if (o.positional.length || !o["--apply"] && o["--confirm"]) throw new Error("ci-prepare 默认只读；执行需 --apply --confirm 及中央批准清单/锁摘要");
    const { planCiPreparation, prepareCiDependencies } = await import("../lib/ci-prepare.js");
    const result = o["--apply"] ? prepareCiDependencies({ root: o["--root"], confirm: !!o["--confirm"], expectWorkspaceHash: o["--expect-workspace-hash"], expectLockHash: o["--expect-lock-hash"] }) : planCiPreparation({ root: o["--root"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "blocked" ? 2 : 0;
  } else if (command === "verify-release-review") {
    const o = options(["--config", "--project", "--sha", "--record", "--evidence-root", "--publication-dir", "--out-dir"]);
    if (o.positional.length) throw new Error("verify-release-review 不接受位置参数");
    for (const key of ["--config", "--project", "--sha"]) if (!o[key]) throw new Error(`verify-release-review 缺少 ${key}`);
    if (o["--publication-dir"] && (o["--record"] || o["--evidence-root"]) || !o["--publication-dir"] && (!o["--record"] || !o["--evidence-root"])) throw new Error("选择中央 --publication-dir 自动匹配本次SHA；或维护者明确提供 --record 与 --evidence-root，两种方式不能混用");
    const review = await import("../lib/release-review.js");
    if (o["--out-dir"] && !o["--publication-dir"]) throw new Error("--out-dir 仅用于自动选择后的本次CI重查证据");
    const result = o["--publication-dir"] ? await review.selectReleaseReview({ configFile: o["--config"], project: o["--project"], sha: o["--sha"], publicationDir: o["--publication-dir"], outDir: o["--out-dir"] }) : review.verifyReleaseReview({ configFile: o["--config"], project: o["--project"], sha: o["--sha"], recordFile: o["--record"], evidenceRoot: o["--evidence-root"] });
    process.stdout.write(JSON.stringify(Object.fromEntries(["status", "project", "sha", "reviewId", "reviewerId", "authorId", "recordHash", "reviewDigest", "bodyDigest", "evidenceDigest", "sourceDigest", "trustHash", "preBuildFindingsResolved", "liveVerified", "liveCheckDirectory"].filter((key) => result[key] !== undefined).map((key) => [key, result[key]])), null, 2) + "\n");
  } else if (command === "doctor") {
    const o = options(["--root", "--kind", "--out"]);
    if (o.positional.length) throw new Error("doctor 不接受位置参数");
    const { doctor } = await import("../lib/doctor.js");
    if (o["--out"]) { const root = path.resolve(o["--root"] || "."), canonicalRoot = realpathSync(root), out = path.resolve(o["--out"]); if ([root, canonicalRoot].some((r) => out === r || out.startsWith(r + path.sep))) throw new Error("doctor 只读项目，--out 必须放在项目外证据目录"); }
    const result = doctor({ root: o["--root"], kind: o["--kind"] });
    protectOutput(o["--out"], [], o["--root"] || ".");
    if (o["--out"]) writeJson(o["--out"], result); else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.status === "gaps" ? 2 : 0;
  } else if (command === "automation") {
    const o = options(["--config", "--send", "--watch"]);
    if (o.positional.length || !o["--config"]) throw new Error("automation 要求中央 --config；--watch 定时运行；--send 实际投递");
    const { automationTick, startAutomation } = await import("../lib/automation.js");
    if (o["--watch"]) { const loop = startAutomation({ configFile: o["--config"], send: !!o["--send"] }); for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => loop.stop()); }
    else { const result = await automationTick({ configFile: o["--config"], send: !!o["--send"] }); process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exitCode = result.status === "ok" ? 0 : 2; }
  } else if (command === "control") {
    const operation = rest.shift();
    const o = options(["--config", "--port", "--review-id", "--record", "--evidence-root", "--provenance", "--plan-id", "--config-id", "--plan", "--release-set"]);
    if (o.positional.length || !o["--config"]) throw new Error("control 要求 --config；子命令 serve/register-review/register-deployment");
    const control = await import("../lib/control-service.js"); let result;
    if (operation === "serve") {
      const server = await control.serveControl({ configFile: o["--config"], port: o["--port"] === undefined ? 8787 : Number(o["--port"]) });
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
      result = { status: "listening", host: "127.0.0.1", port: server.address().port };
    } else if (operation === "register-review") result = await control.registerControlReview({ configFile: o["--config"], reviewId: o["--review-id"], recordFile: o["--record"], evidenceRoot: o["--evidence-root"], provenanceFile: o["--provenance"] });
    else if (operation === "register-deployment") { const { registerControlDeployment } = await import("../lib/control-deployment.js"); result = await registerControlDeployment({ config: control.loadControlConfig(o["--config"]), planId: o["--plan-id"], configId: o["--config-id"], planFile: o["--plan"], releaseSetFile: o["--release-set"] }); }
    else throw new Error("control 子命令 serve/register-review/register-deployment");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (command === "review-facts") {
    const o = options(["--root", "--summary", "--plan", "--out-dir", "--base-sha"]);
    if (o.positional.length) throw new Error("review-facts 不接受位置参数");
    const { produceReviewFacts } = await import("../lib/review-facts.js");
    process.stdout.write(JSON.stringify(produceReviewFacts({ root: o["--root"] || process.cwd(), summaryFile: o["--summary"] || "quality-reports/quality-summary.json", planFile: o["--plan"], outDir: o["--out-dir"] || "quality-reports/review", baseSha: o["--base-sha"] }), null, 2) + "\n");
  } else if (command === "review-publish") {
    const o = options(["--config"]); if (o.positional.length || !o["--config"]) throw new Error("review-publish 要求独立签发作业 --config");
    const { publishReviewAuthorizations } = await import("../lib/review-publish.js"); const result = await publishReviewAuthorizations({ configFile: o["--config"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exitCode = result.status === "ok" ? 0 : 2;
  } else if (command === "review-ci") {
    const o = options(["--config", "--source", "--out"]);
    if (o.positional.length || !o["--config"] || !o["--source"] || !o["--out"]) throw new Error("review-ci 要求 --config --source --out 新证据目录");
    const { createCiReview } = await import("../lib/review-ci.js");
    process.stdout.write(JSON.stringify(await createCiReview({ configFile: o["--config"], sourceFile: o["--source"], outDir: o["--out"] }), null, 2) + "\n");
  } else if (command === "review-collect") {
    const o = options(["--config", "--source", "--input", "--record", "--evidence-root", "--out"]);
    if (o.positional.length) throw new Error("review-collect 不接受位置参数");
    for (const flag of ["--config", "--source", "--input", "--record", "--evidence-root", "--out"]) if (!o[flag]) throw new Error(`review-collect 缺少 ${flag}`);
    const { collectReviewEvidence } = await import("../lib/review-collect.js");
    const result = collectReviewEvidence({ configFile: o["--config"], sourceFile: o["--source"], inputFile: o["--input"], recordFile: o["--record"], evidenceRoot: o["--evidence-root"], outDir: o["--out"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (command === "release-set") {
    const operation = rest.shift(), o = options(["--input", "--evidence-root", "--expect-input-hash", "--private-key", "--issuer", "--out", "--release-set", "--public-key", "--expect-issuer", "--expect-release-set-hash", "--env", "--review-config"]);
    if (o.positional.length) throw new Error("release-set 不接受位置参数");
    const { createReleaseSet, verifyReleaseSet } = await import("../lib/release-set.js"); let result;
    if (operation === "create") { protectOutput(o["--out"], [o["--input"], o["--private-key"], o["--review-config"]]); result = createReleaseSet({ inputFile: o["--input"], evidenceRoot: o["--evidence-root"], expectInputHash: o["--expect-input-hash"], privateKeyFile: o["--private-key"], issuer: o["--issuer"], outFile: o["--out"], reviewConfigFile: o["--review-config"] }); }
    else if (operation === "verify") result = verifyReleaseSet({ releaseSetFile: o["--release-set"], publicKeyFile: o["--public-key"], expectIssuer: o["--expect-issuer"], expectReleaseSetHash: o["--expect-release-set-hash"], env: o["--env"], reviewConfigFile: o["--review-config"] });
    else throw new Error("release-set 子命令 create/verify");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (command === "deployment") {
    const operation = rest.shift(), o = options(["--config", "--release-set", "--expect-release-set-hash", "--state", "--action", "--out", "--out-dir", "--plan", "--authorization", "--private-key", "--send", "--execution", "--executor-public-key", "--project", "--sequence", "--pipeline-id", "--job-id", "--pipeline-url", "--report-url", "--requests-dir", "--plan-id", "--config-id", "--authorization-dir", "--timeout-ms", "--delivery-dir"]);
    if (o.positional.length) throw new Error("deployment 不接受位置参数");
    const d = await import("../lib/deployment.js"), base = { configFile: o["--config"], releaseSetFile: o["--release-set"], expectReleaseSetHash: o["--expect-release-set-hash"], stateFile: o["--state"] }; let result;
    if (operation === "plan") { protectOutput(o["--out"], [o["--config"], o["--release-set"], o["--state"]]); result = d.planDeployment({ ...base, action: o["--action"], outFile: o["--out"] }); }
    else if (operation === "queue") { const { queueDeploymentPlan } = await import("../lib/deployment-queue.js"); result = queueDeploymentPlan({ requestsDir: o["--requests-dir"], planId: o["--plan-id"], configId: o["--config-id"], planFile: o["--plan"], releaseSetFile: o["--release-set"] }); }
    else if (operation === "run-authorized") {
      const { waitForDeploymentAuthorization } = await import("../lib/deployment-queue.js");
      if (!o["--authorization-dir"]) throw new Error("run-authorized 要求中央固定 --authorization-dir");
      // A preview never waits for or consumes a human authorization.
      if (!o["--send"]) result = d.runDeployment({ ...base, planFile: o["--plan"], privateKeyFile: o["--private-key"], outDir: o["--out-dir"], send: false });
      else {
        const selected = await waitForDeploymentAuthorization({ configFile: o["--config"], planFile: o["--plan"], authorizationDir: o["--authorization-dir"], timeoutMs: o["--timeout-ms"] === undefined ? 900000 : Number(o["--timeout-ms"]) });
        result = selected.status === "authorized" ? d.runDeployment({ ...base, planFile: o["--plan"], authorizationFile: selected.authorizationFile, privateKeyFile: o["--private-key"], outDir: o["--out-dir"], send: true }) : selected;
      }
    }
    else if (operation === "deliver") { const { queueDeploymentDelivery } = await import("../lib/deployment-queue.js"); result = queueDeploymentDelivery({ deliveryDir: o["--delivery-dir"], configId: o["--config-id"], executionFile: o["--execution"], releaseSetFile: o["--release-set"], expectReleaseSetHash: o["--expect-release-set-hash"] }); }
    else if (operation === "run") result = d.runDeployment({ ...base, planFile: o["--plan"], authorizationFile: o["--authorization"], privateKeyFile: o["--private-key"], outDir: o["--out-dir"], send: !!o["--send"] });
    else if (operation === "lifecycle") result = d.createDeploymentLifecycle({ ...base, executionFile: o["--execution"], executorPublicKeyFile: o["--executor-public-key"], project: o["--project"], sequence: Number(o["--sequence"]), pipelineId: o["--pipeline-id"], jobId: o["--job-id"], pipelineUrl: o["--pipeline-url"], reportUrl: o["--report-url"], outDir: o["--out-dir"] });
    else throw new Error("deployment 子命令 plan/queue/run-authorized/run/deliver/lifecycle");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n"); if (result.exitCode) process.exitCode = result.exitCode;
  } else if (command === "attest-collected") {
    const o = options(["--config", "--source", "--sha", "--env", "--manifest", "--private-key", "--issuer", "--out", "--expect-policy-hash", "--expect-rules-hash", "--expect-baseline-hash", "--expect-waivers-hash"]);
    if (o.positional.length) throw new Error("attest-collected 不接受位置参数");
    const { signCollectedReleaseProof } = await import("../lib/lifecycle-source.js");
    protectOutput(o["--out"], [o["--config"], o["--source"], o["--private-key"]]);
    const result = signCollectedReleaseProof({ configFile: o["--config"], sourceFile: o["--source"], sha: o["--sha"], env: o["--env"], manifestPath: o["--manifest"], privateKeyFile: o["--private-key"], issuer: o["--issuer"], outFile: o["--out"], expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"], expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (command === "collect-ci") {
    const o = options(["--config", "--request", "--out"]);
    if (o.positional.length || !o["--config"] || !o["--request"] || !o["--out"]) throw new Error("collect-ci 要求 --config --request --out 新证据目录");
    const { collectCiSource } = await import("../lib/ci-source.js");
    const result = await collectCiSource({ configFile: o["--config"], requestFile: o["--request"], outDir: o["--out"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = result.passed ? 0 : 2;
  } else if (command === "lifecycle-build" || command === "lifecycle-review") {
    const allowed = ["--config", "--source", "--sha", "--env", "--out", "--manifest", "--record", "--evidence-root", "--public-key", "--authorization-public-key", "--expect-authorization-issuer", "--report-url", "--sequence", "--profile", "--expect-review-policy-hash", "--expect-policy-hash", "--expect-rules-hash", "--expect-baseline-hash", "--expect-waivers-hash"];
    const o = options(allowed);
    if (o.positional.length || !o["--config"] || !o["--source"] || !o["--sha"] || !o["--out"]) throw new Error("生命周期构造要求 --config --source --sha --out 新目录");
    const { createBuildLifecycle, createReviewLifecycle } = await import("../lib/lifecycle-source.js");
    const base = { configFile: o["--config"], sourceFile: o["--source"], sha: o["--sha"], env: o["--env"], outDir: o["--out"] };
    const result = command === "lifecycle-build" ? createBuildLifecycle({ ...base, manifestPath: o["--manifest"] }) : createReviewLifecycle({ ...base,
      recordFile: o["--record"], evidenceRoot: o["--evidence-root"], publicKeyFile: o["--public-key"], authorizationPublicKeyFile: o["--authorization-public-key"], expectAuthorizationIssuer: o["--expect-authorization-issuer"],
      reportUrl: o["--report-url"], sequence: Number(o["--sequence"]), profile: o["--profile"], expectReviewPolicyHash: o["--expect-review-policy-hash"], expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"], expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (command === "governance") {
    const operation = rest.shift();
    const allowed = {
      receipt: ["--input", "--private-key", "--issuer", "--out"],
      ingest: ["--config", "--state", "--event", "--summary", "--out"],
      lifecycle: ["--config", "--state", "--event", "--source", "--out"],
      action: ["--config", "--state", "--action", "--out"],
      reconcile: ["--config", "--state", "--expectations", "--out"],
      outbox: ["--config", "--state", "--include-digest", "--out"],
      dispatch: ["--config", "--state", "--include-digest", "--send", "--out"],
      migrate: ["--config", "--new-config", "--state", "--authorization", "--out"],
    };
    if (!Object.hasOwn(allowed, operation)) throw new Error("governance 子命令: receipt/ingest/lifecycle/action/reconcile/outbox/dispatch");
    const o = options(allowed[operation]); if (o.positional.length) throw new Error("governance 不接受多余位置参数");
    const g = await import("../lib/governance.js");
    const required = operation === "receipt" ? ["--input", "--private-key", "--issuer", "--out"] : ["--config", "--state", ...(operation === "ingest" ? ["--event", "--summary"] : operation === "lifecycle" ? ["--event", "--source"] : operation === "action" ? ["--action"] : operation === "reconcile" ? ["--expectations"] : operation === "migrate" ? ["--new-config", "--authorization"] : [])];
    for (const key of required) if (!o[key]) throw new Error(`缺少 ${key}`);
    protectOutput(o["--out"], [o["--state"], o["--config"], o["--input"], o["--event"], o["--summary"], o["--source"], o["--action"], o["--expectations"], o["--private-key"]]);
    if (operation !== "receipt") protectOutput(o["--out"], [g.loadGovernanceConfig(o["--config"]).publicKeyFile]);
    let result;
    const base = { configFile: o["--config"], stateFile: o["--state"], includeDigest: !!o["--include-digest"] };
    if (operation === "receipt") { const { readFileSync } = await import("node:fs"); result = g.signPlatformReceipt(JSON.parse(readFileSync(o["--input"], "utf8")), { privateKeyFile: o["--private-key"], issuer: o["--issuer"] }); }
    else if (operation === "ingest") result = g.ingestGovernance({ ...base, eventFile: o["--event"], summaryFile: o["--summary"] });
    else if (operation === "lifecycle") result = g.ingestLifecycleGovernance({ ...base, eventFile: o["--event"], sourceFile: o["--source"] });
    else if (operation === "action") result = g.actionGovernance({ ...base, actionFile: o["--action"] });
    else if (operation === "reconcile") result = g.reconcileGovernance({ ...base, expectationsFile: o["--expectations"] });
    else if (operation === "outbox") result = g.outboxGovernance(base);
    else if (operation === "migrate") result = g.migrateGovernanceConfig({ ...base, newConfigFile: o["--new-config"], authorizationFile: o["--authorization"] });
    else result = await g.dispatchGovernance({ ...base, send: !!o["--send"] });
    if (o["--out"]) writeJson(o["--out"], result); else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.results?.some((x) => x.status !== "delivered") || result.unknownDeliveries?.length || result.deadLetters?.length) process.exitCode = 2;
  } else if (command === "cost") {
    const o = options(["--usage", "--out"]);
    if (!o.positional[0] || !o["--out"]) throw new Error("cost 必须提供工件目录和 --out；不默认将完整统计塞入控制台");
    if (path.basename(o["--out"]) === "quality-summary.json" || (o["--usage"] && path.resolve(o["--out"]) === path.resolve(o["--usage"]))) throw new Error("成本输出不能覆盖 quality-summary 或 usage 输入");
    const { collectCost } = await import("../lib/cost.js");
    writeJson(o["--out"], collectCost(o.positional[0], { usageFile: o["--usage"] }));
  } else if (command === "inspect") {
    const o = options(["--view", "--status", "--severity", "--rule", "--limit", "--max-bytes", "--cursor"]);
    const { inspectReport } = await import("../lib/inspect.js");
    const r = inspectReport(o.positional[0], { view: o["--view"], status: o["--status"], severity: o["--severity"],
      rule: o["--rule"], limit: o["--limit"], maxBytes: o["--max-bytes"], cursor: o["--cursor"] });
    process.stdout.write(r.text);
    process.exitCode = r.exitCode;
  } else if (command === "fix") {
    const o = options(["--plan", "--apply", "--root", "--profile", "--confirm"]);
    if (!!o["--plan"] === !!o["--apply"]) throw new Error("fix 必须且只能选择 --plan 或 --apply");
    if (o["--plan"]) console.log(`[fix] 计划: ${buildFixPlan(o["--plan"], { root: o["--root"] }).planFile}`);
    else {
      const r = await applyFixPlan(o["--apply"], { root: o["--root"], profile: o["--profile"], confirm: !!o["--confirm"] });
      console.log(`[fix] scanResolved=${r.fixReport.scanResolved} rolledBack=${r.fixReport.rolledBack} nextState=${r.fixReport.nextState} 报告=${r.reportFile}`);
      process.exitCode = r.exitCode;
    }
  } else if (command === "validate-report") {
    const o = options([]);
    const { validateReportFile } = await import("../lib/validate-report.js");
    const r = validateReportFile(o.positional[0]);
    if (!r.ok) throw new Error(r.errors.join("; "));
    console.log("[validate-report] 通过");
  } else if (command === "commit-message") {
    const o = options(["--root"]);
    const r = validateCommitMessage(o.positional[0], path.resolve(o["--root"] || "."));
    if (!r.ok) { console.error(`[commit-message] ${r.reason}`); process.exitCode = 1; }
  } else if (command === "manifest") {
    const o = options(["--root", "--project", "--env", "--artifacts", "--configs", "--out"]);
    createArtifactManifest({ root: path.resolve(o["--root"] || "."), project: o["--project"], env: o["--env"],
      artifacts: o["--artifacts"]?.split(","), configFiles: o["--configs"]?.split(",") || [], outFile: o["--out"] });
    console.log(`[manifest] ${o["--out"]}`);
  } else if (command === "attest") {
    const o = options([...PROOF_FLAGS, "--profile", "--private-key", "--issuer", "--pipeline-id", "--job-id", "--promotion-record", "--out"]);
    writeJson(o["--out"], signGateProof({ ...proofOptions(o), summaryFile: o["--summary"] || o.positional[0],
      profile: o["--profile"], privateKeyFile: o["--private-key"], issuer: o["--issuer"],
      pipelineId: o["--pipeline-id"], jobId: o["--job-id"], promotionRecordFile: o["--promotion-record"] }));
  } else if (command === "review-draft") {
    const o = options(["--input", "--evidence-root", "--out"]);
    if (o.positional.length || !o["--input"] || !o["--out"]) throw new Error("review-draft 要求 --input --out，证据须放在 --evidence-root 内");
    const { createReviewDraft } = await import("../lib/review.js");
    const result = createReviewDraft({ inputFile: o["--input"], evidenceRoot: o["--evidence-root"], outDir: o["--out"] });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (command === "review-sign") {
    const o = options(["--private-key", "--reviewer-id", "--author-id", "--project", "--sha", "--out", "--authorization", "--authorization-public-key", "--expect-authorization-issuer", "--evidence-root", "--expect-review-policy-hash", "--profile", "--env", "--expect-policy-hash", "--expect-rules-hash", "--expect-baseline-hash", "--expect-waivers-hash"]);
    const recordFile = o.positional[0];
    protectOutput(o["--out"], [recordFile, o["--private-key"], o["--authorization"]]);
    const { validateReviewOutputLocation } = await import("../lib/review.js");
    const destination = validateReviewOutputLocation({ outFile: o["--out"], recordFile, evidenceRoot: o["--evidence-root"] });
    const signedReview = signReviewRecord({ recordFile, privateKeyFile: o["--private-key"],
      reviewerId: o["--reviewer-id"], authorId: o["--author-id"], project: o["--project"], sha: o["--sha"],
      authorizationFile: o["--authorization"], authorizationPublicKeyFile: o["--authorization-public-key"], expectAuthorizationIssuer: o["--expect-authorization-issuer"], evidenceRoot: o["--evidence-root"], expectReviewPolicyHash: o["--expect-review-policy-hash"],
      profile: o["--profile"], env: o["--env"], expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"], expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"] });
    writeFileSync(destination, JSON.stringify(signedReview, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`[review-sign] 已写入 ${destination}`);
  } else if (command === "verify-artifact") {
    const r = verifyArtifact(proofOptions(options(PROOF_FLAGS)));
    if (!r.ok) throw new Error(r.errors.join("; "));
    console.log("[verify-artifact] 签名、质量证据及实际制品通过");
  } else if (command === "promote") {
    const o = options(["--root", "--source", "--target", "--remote", "--profile", "--push", "--allow-any", "--expect-policy-hash", "--expect-rules-hash", "--expect-baseline-hash", "--expect-waivers-hash", "--prepare-command"]);
    const r = await promote({ root: o["--root"] || ".", source: o["--source"], target: o["--target"], remote: o["--remote"],
      profile: o["--profile"], push: !!o["--push"], allowAny: !!o["--allow-any"],
      expectPolicyHash: o["--expect-policy-hash"], expectRulesHash: o["--expect-rules-hash"],
      expectBaselineHash: o["--expect-baseline-hash"], expectWaiversHash: o["--expect-waivers-hash"], prepareCommand: o["--prepare-command"] });
    console.log(`[promote] ${r.status} record=${r.recordFile}`);
    for (const reason of r.reasons) console.error(reason);
    process.exitCode = r.exitCode;
  } else if (command === "promote-apply") {
    const o = options([...PROOF_FLAGS, "--record", "--remote-url", "--bundle", "--review", "--review-public-key", "--review-evidence-root", "--expect-review-policy-hash", "--authorization-public-key", "--expect-authorization-issuer", "--out"]);
    const r = applyPromotion({ ...proofOptions(o), recordFile: o["--record"], remoteUrl: o["--remote-url"],
      bundleFile: o["--bundle"], reviewFile: o["--review"], reviewPublicKeyFile: o["--review-public-key"], reviewEvidenceRoot: o["--review-evidence-root"], expectReviewPolicyHash: o["--expect-review-policy-hash"], authorizationPublicKeyFile: o["--authorization-public-key"], expectAuthorizationIssuer: o["--expect-authorization-issuer"], outDir: o["--out"] });
    console.log(`[promote-apply] ${r.status}`);
    for (const reason of r.reasons) console.error(reason);
    process.exitCode = r.exitCode;
  } else if (command === "self-test") {
    if (rest.length) throw new Error("self-test 不接受额外参数");
    const { runAllFixtures } = await import("../scripts/run-fixtures.mjs");
    process.exitCode = await runAllFixtures();
  } else throw new Error("用法: wl-skills-gate <setup|onboard|jenkins|ci-prepare|verify-release-review|run|doctor|automation|control|collect-ci|review-facts|review-ci|review-collect|review-publish|lifecycle-build|lifecycle-review|governance|inspect|cost|fix|validate-report|commit-message|manifest|attest|attest-collected|release-set|deployment|review-draft|review-sign|verify-artifact|promote|promote-apply|self-test>，详见 docs/README.md");
} catch (e) { console.error(`[${command || "wl-skills-gate"}] ${e.message}`); process.exitCode = 2; }
