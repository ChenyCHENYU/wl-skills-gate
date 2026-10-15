import { readFileSync } from "node:fs";
import { signCollectedReleaseProof } from "../../lib/lifecycle-source.js";
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (request.now !== undefined) throw new Error("签发时间由中央作业提供");
if (!process.env.WL_COMPONENT_KEY) throw new Error("缺少独立作业固定的证明签发凭据");
const result = signCollectedReleaseProof({ ...request, privateKeyFile: process.env.WL_COMPONENT_KEY, now: Date.now() });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
