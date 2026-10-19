import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { safePath } from "../source-state.js";
import { quote, runCommand, redactLog } from "../exec.js";
import { sha256 } from "../util.js";
import { run as junit } from "./junit.js";
import { bindProducedReports, assertReportOutput } from "../report-selection.js";
import { parseXml } from "../xml.js";

export const PROJECT_SCRIPT_VERSION = "gate-project-script-v1";
export const NODE_TEST_VERSION = "gate-node-test-junit-v1";
export async function run(check, ctx) {
  try {
    if (ctx.scope || ctx.base) throw new Error("项目必需作业必须完整执行批准范围");
    if (check.tool === "node-tests") {
      const bytes = readFileSync(safePath(ctx.root, check.plan));
      if (check.planHash && sha256(bytes) !== check.planHash) throw new Error("必测计划与批准planHash不符");
      const plan = JSON.parse(bytes);
      if (
        plan.schemaVersion !== 1 ||
        !Array.isArray(plan.testFiles) ||
        !plan.testFiles.length ||
        new Set(plan.testFiles).size !== plan.testFiles.length
      )
        throw new Error("必测计划缺少明确testFiles；不允许零用例接入");
      for (const file of plan.testFiles) {
        if (typeof file !== "string" || !/\.(?:mjs|cjs|js)$/.test(file)) throw new Error("Node必测文件非法");
        readFileSync(safePath(ctx.root, file));
      }
      const file = `quality-reports/project-tests/${check.id}.xml`;
      const command =
        [process.execPath, "--test", "--test-reporter=junit", ...plan.testFiles].map(quote).join(" ") +
        ` > ${quote(safePath(ctx.root, file))}`;
      const result = await junit(
        {
          id: check.id,
          tool: "junit",
          dimension: "测试规范",
          file,
          command,
          requiredTests: plan.requiredTests || [],
          requiredSuites: plan.requiredSuites || [],
          timeoutMs: check.timeoutMs || 600000,
        },
        ctx
      );
      if (result.status === "ok") {
        const fileOnly = [];
        const visit = (node) => {
          if (
            node.name === "testcase" &&
            node.attrs.classname === "test" &&
            plan.testFiles.some((file) => node.attrs.name === file || node.attrs.name === path.join(ctx.root, file))
          )
            fileOnly.push(node.attrs.name);
          node.children.forEach(visit);
        };
        visit(parseXml(readFileSync(safePath(ctx.root, file), "utf8")));
        result.testEvidence.nodeHarness = { fileOnlyTests: fileOnly };
        for (const name of fileOnly)
          result.findings.push({
            ruleId: "JUNIT/ZERO-TESTS",
            severity: "error",
            file: name,
            line: null,
            message: "Node仅执行文件本身，未运行任何已命名测试用例",
            baselineAllowed: false,
          });
      }
      return {
        ...result,
        toolVersion: NODE_TEST_VERSION,
        toolVersionVerified: true,
        coverage: {
          mode: "full",
          complete: result.status === "ok",
          requestedFiles: plan.testFiles,
          scannedFiles: plan.testFiles,
          scannedFileCount: plan.testFiles.length,
        },
        note: `真实Node测试/JUnit；${result.note || result.reason || ""}`,
      };
    }
    if (typeof check.script !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(check.script))
      throw new Error("项目脚本必须是已登记package.json脚本名");
    const pkg = JSON.parse(readFileSync(safePath(ctx.root, "package.json"), "utf8"));
    if (typeof pkg.scripts?.[check.script] !== "string" || !pkg.scripts[check.script].trim())
      throw new Error(`项目缺少必需脚本: ${check.script}`);
    if (check.scriptHash && sha256(pkg.scripts[check.script]) !== check.scriptHash)
      throw new Error("项目脚本与批准scriptHash不符");
    let command = ["npm", "run", check.script, "--ignore-scripts"].map(quote).join(" ");
    if (check.omitNodeTests === true) {
      const source = pkg.scripts[check.script];
      if (/["'`$;|<>\n\r]/.test(source)) throw new Error("复合脚本包含未适配语法，不能自动拆分测试阶段");
      const segments = source.split("&&").map((x) => x.trim()),
        testSegments = segments.filter((x) =>
          /^node --test (?:[A-Za-z0-9_./-]+\.test\.(?:mjs|cjs|js)(?:\s+|$))+$/.test(x)
        );
      const files = testSegments.flatMap((segment) => segment.split(/\s+/).slice(2));
      const plan = JSON.parse(readFileSync(safePath(ctx.root, check.nodeTestPlan), "utf8"));
      if (
        !files.length ||
        !Array.isArray(plan.testFiles) ||
        JSON.stringify([...files].sort()) !== JSON.stringify([...plan.testFiles].sort())
      )
        throw new Error("复合脚本真实Node用例与批准必测计划不同，拒绝裁剪");
      command = segments.filter((x) => !testSegments.includes(x)).join(" && ");
      if (!command) throw new Error("项目契约阶段为空，不能用空命令冒充验证");
    }
    const result = await runCommand(command, { cwd: ctx.root, timeoutMs: check.timeoutMs || 600000 });
    if (result.code === null || result.timedOut || result.truncated)
      throw new Error("项目脚本执行失效/超时/输出不完整");
    const findings =
      result.code === 0
        ? []
        : [
            {
              ruleId: `BUILD/PROJECT-SCRIPT/${check.script}`,
              severity: "error",
              file: "package.json",
              line: null,
              message: `项目必需作业失败: ${check.script} (exit=${result.code})`,
              suggestion: "查看本轮原始日志，修复实际断言/契约/依赖问题后重跑；不能删除必需作业",
              baselineAllowed: false,
            },
          ];
    const log = safePath(ctx.root, `quality-reports/project-scripts/${ctx.eventId}/${check.id}.log`);
    assertReportOutput(log, ctx);
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, redactLog(`[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`));
    const reports = bindProducedReports([log], ctx);
    // This is command evidence, deliberately not a fabricated JUnit test count.
    return {
      status: "ok",
      findings,
      toolVersion: PROJECT_SCRIPT_VERSION,
      toolVersionVerified: true,
      production: {
        eventId: ctx.eventId,
        commitSha: ctx.commitSha,
        sourceDigest: ctx.sourceDigest,
        reports,
        script: check.script,
        scriptHash: sha256(pkg.scripts[check.script]),
        exitCode: result.code,
        diagnostic: redactLog(result.stderr || result.stdout).slice(-4000),
      },
      note: "真实项目必需脚本；不将脚本成功冒充已执行测试用例",
    };
  } catch (error) {
    return { status: "invalid", reason: `项目必需作业失效: ${error.message}` };
  }
}
