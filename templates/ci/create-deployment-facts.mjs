import path from "node:path";
import { readFileSync } from "node:fs";
import { createDeploymentLifecycles } from "../../lib/deployment.js";
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (request.now !== undefined) throw new Error("事实时间由实际中央作业分配，不接受请求覆盖");
const result = createDeploymentLifecycles({ ...request, outDir: path.resolve(process.argv[3]), now: Date.now() });
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
