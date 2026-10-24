#!/usr/bin/env node
import {recordJenkinsFailure} from '../lib/notification-diagnostics.js';
import { createInterface } from "node:readline/promises";
import { runSetupCli } from "../lib/setup.js";

try {
  let args = process.argv.slice(2);
  if (!args.length) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("启动菜单需要交互终端；自动任务请明确指定 project/workspace/central/branches/release-input 及其预览/确认参数");
    console.log("\nWL · WORLD LEADING | 质量工程接入\n\n1 首次接入项目\n2 初始化已接项目的本机环境\n3 运维接线预检\n4 启动中央采集与操作入口（消息预览）\n5 生成组合发布输入\n6 生成同项目六分支中央接线\n7 生成Jenkins薄接入登记\n8 核验远端Jenkins接线\nEnter 退出\n");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const choice = (await prompt.question("请选择：")).trim(); prompt.close();
    const modes = { "1": ["project"], "2": ["workspace"], "3": ["central"], "4": ["central", "--start", "--watch"], "5": ["release-input"], "6":["branches"], "7":['jenkins'], "8":['jenkins','--verify'] };
    if (!choice) process.exit(0);
    if (!modes[choice]) throw new Error("请选择1到8");
    args = modes[choice];
  }
  process.exitCode = await runSetupCli(args);
} catch (error) { recordJenkinsFailure(error,{command:process.argv.slice(2,4).join(' ')}); console.error(`[quality-setup] ${error.message}`); process.exitCode = 2; }
