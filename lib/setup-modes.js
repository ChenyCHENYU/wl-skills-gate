import path from "node:path";
import { planCentralSetup, runCentralSetup } from "./setup-central.js";
import { buildReleaseInputPlan, applyReleaseInputPlan } from "./release-input.js";

const json = (value) => JSON.stringify(value, null, 2);
const failed = (status) => /blocked|attention|approval-required/.test(status || "");
export async function runAdditionalSetup(options, { interactive, ask, say, closePrompt = () => {} }) {
  const show = (result) => {
    if (options.json) { say(JSON.stringify(result)); return; }
    say(`\n结果：${result.status}`);
    for (const step of result.steps || []) say(`  ${step.status} · ${step.title || step.phase || step.id}：${step.detail || step.failure || ""}`);
    for (const blocker of result.blockers || []) say(`  阻断：${blocker.reason || blocker.message || json(blocker)}`);
    if (result.failure || result.complete?.failure) say(`原因：${result.failure || result.complete.failure}`);
    for (const action of result.nextActions || []) say(`  ${action.owner || "负责人"}：${action.action || action.nextAction}`);
    if (result.nextAction) say(result.nextAction);
    if (result.executionReceipt) say(`执行反馈：${result.executionReceipt}`);
    if (result.localValidated === true) say("本机安装与真实Hook验证通过；远端强制、Review、通知及业务现场仍独立验收。");
    if (result.summary) say(json(result.summary));
    if (result.inputFile) say(`输入文件：${result.inputFile}\nconfigHash：${result.configHash}\ninputHash：${result.inputHash}`);
    if (result.planHash) say(`计划摘要：${result.planHash}`);
  };
  const emit = (result) => { show(result); return failed(result.status) ? 2 : 0; };
  const approve = async (message) => (await ask(message + "\n输入 1 确认，Enter 取消：")).trim() === "1";
  if(options.mode === "branches") {
    const {planBranchSetup,applyBranchSetup}=await import("./branch-setup.js");
    const configFile=options.config || (interactive ? (await ask("已批准的六分支接线配置文件：")).trim() : undefined);
    if(!configFile)throw new Error("多分支接线需要 --config 指定配置文件");
    const plan=planBranchSetup({configFile});
    if(options.preview || !interactive && !options.confirm)return emit(plan);
    if(interactive){say(json(plan.summary));say(`完整变更（确认前请审阅）：\n${json(plan.files)}`);}
    if(interactive && !await approve("确认生成上述六分支配置并登记到同一中央项目？不启动、不发消息、不改GitLab/Jenkins权限。"))return emit({status:"canceled",written:false});
    return emit(applyBranchSetup({configFile,expectPlanHash:interactive?plan.planHash:options["plan-hash"],confirm:true}));
  }
  if (options.mode === "workspace") {
    const { planWorkspaceInitialization, applyWorkspaceInitialization } = await import("./workspace-init.js");
    const root = path.resolve(options.root || (interactive ? (await ask(`已接项目Git根目录 [${process.cwd()}]：`)).trim() || process.cwd() : process.cwd()));
    for (let stage = 0; stage < 5; stage++) {
      const plan = planWorkspaceInitialization({ root });
      if (options.preview || !interactive && !options.confirm || plan.blockers.length) return emit(plan);
      if (!options.json) {
        say(`\n工作副本初始化：${root}\n固定依赖：${plan.dependencies.map((v) => `${v.name}@${v.version}`).join("、")}`);
        say(`本机Hook：${plan.hooks.before || "未配置"} → ${plan.hooks.path}`);
        if (plan.installation) say(`安装：${plan.installation.executable} ${plan.installation.args.join(" ")}`);
        for (const patch of plan.lifecycle?.patches || []) say(`生命周期适配：${json(patch)}`);
        say(`计划摘要：${plan.planHash}；完整只读预览可使用 --preview --json。`);
      }
      const confirmed = interactive ? await approve("确认按已提交清单安装固定依赖、恢复本机Hook并运行验收？不改业务策略、不更新规则。") : options.confirm === true;
      if (!confirmed) return emit({ status: "canceled", localValidated: false, nextAction: "未执行本阶段；需要时重新启动初始化任务" });
      const result = await applyWorkspaceInitialization({ root, planHash: interactive ? plan.planHash : options["plan-hash"], confirm: true });
      if (result.status !== "workspace-approval-required" || !interactive) return emit(result);
      say("安装后的真实生命周期差异需要重新确认。");
    }
    return emit({ status: "workspace-initialization-blocked", localValidated: false, nextAction: "阶段没有收敛，请工程维护者查看初始化回执" });
  }
  if (options.mode === "release-input") {
    const configFile = options.config || (interactive ? (await ask("已批准的发布输入固定配置文件：")).trim() : undefined);
    if (!configFile) throw new Error("发布输入要求 --config 指定已批准固定配置");
    const plan = buildReleaseInputPlan({ configFile });
    if (options.preview || !interactive && !options.confirm) return emit(plan);
    if (interactive) { say(json(plan.summary)); say(`输出：${plan.inputFile}\n配置摘要：${plan.configHash}\n输入摘要：${plan.inputHash}`); }
    const confirmed = interactive ? await approve("确认只生成上述组合输入？本步骤不批准、不签名、不发布。") : options.confirm === true;
    if (!confirmed) return emit({ status: "canceled", written: false });
    return emit(applyReleaseInputPlan({ configFile, expectConfigHash: interactive ? plan.configHash : options["config-hash"], expectInputHash: interactive ? plan.inputHash : options["input-hash"] }));
  }
  if (options.mode === "central") {
    const configDir = options["config-dir"] || (interactive ? (await ask("运维已批准的中央配置目录：")).trim() : undefined);
    if (!configDir) throw new Error("中央接线要求 --config-dir 指定已批准配置目录");
    const separateSigner = options["separate-review-signer"] === true || interactive && (await ask("独立Review签发在其他受控环境运行？[Y/n]：")).trim().toLowerCase() !== "n";
    const config = { configDir, port: options.port === undefined ? 8787 : Number(options.port), watch: options.watch === true, send: options.send === true,
      ...(separateSigner ? { reviewPublishConfigFile: null } : {}) };
    const plan = planCentralSetup(config);
    if (options.preview || plan.status === "blocked" || !options.start) return emit(plan);
    if (!interactive && (!options.confirm || !options["plan-hash"])) throw new Error("非交互中央启动需要 --start --confirm --plan-hash 绑定已审阅计划");
    if (interactive) show(plan);
    if (interactive && !await approve(`确认启动${config.watch ? "持续" : "一次"}采集与本机操作入口？${config.send ? "已选择向批准群发送消息。" : "消息只预览。"} 独立Review签发仍由独立服务执行。`)) return emit({ status: "canceled", automaticallyStarted: false });
    closePrompt();
    const abort = new AbortController();
    const stop = () => abort.abort();
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
    const result = await runCentralSetup({ ...config, start: true, expectPlanHash: interactive ? plan.planHash : options["plan-hash"], signal: abort.signal,
      onResult: (tick) => options.json ? say(JSON.stringify({ kind: "central-tick", ...tick })) : say(`[采集] ${tick.status}；来源 ${tick.sources?.length || 0}，待处理 ${tick.errors?.length || 0}`) });
    const code = emit(result);
    if (result.status === "started") {
      // Keep one supervised foreground task alive; the caller/service manager
      // owns this process. Never detach an orphan process from a wizard.
      if (!abort.signal.aborted) await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
      await result.stop();
      say(json({ status: "stopped", nextAction: "本任务启动的服务已停止；原配置、台账和独立签发服务保留" }));
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop);
    return code;
  }
  throw new Error("未知接入入口");
}
