#!/usr/bin/env node
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchFeishuMembers } from "../lib/feishu-members.js";

// Maintainer entry: credentials are environment references, never CLI arguments or output.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") {
  console.error("用法：node scripts/feishu-sync-members.mjs --out <新建输出目录>；维护者预配WL_FEISHU_APP_ID / WL_FEISHU_APP_SECRET / WL_FEISHU_CHAT_ID");
  process.exit(2);
}
try {
  const result = await fetchFeishuMembers({ appId: process.env.WL_FEISHU_APP_ID, appSecret: process.env.WL_FEISHU_APP_SECRET, chatId: process.env.WL_FEISHU_CHAT_ID });
  const out = path.resolve(args[1]);
  mkdirSync(out, { recursive: false, mode: 0o700 });
  writeFileSync(path.join(out, "feishu-members.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ complete: true, memberCount: result.count, outputFile: path.join(out, "feishu-members.json"), messagesSent: 0, governanceConfigChanged: false }));
} catch (error) {
  // Do not print transport errors, tokens, arbitrary API response bodies or env values.
  const safe = /^(需要应用|飞书接口|飞书未返回|群成员|只允许)/.test(error.message) ? error.message : "读取失败；核对网络、输出目录和批准配置，未修改现有名单";
  console.error(safe); process.exit(1);
}
