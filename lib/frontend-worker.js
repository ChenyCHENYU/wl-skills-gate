import { parentPort, workerData } from "node:worker_threads";
import { analyzeFrontendInline } from "./adapters/frontend.js";
import { redactLog } from "./exec.js";
if (!parentPort) throw new Error("frontend-worker must run inside Gate");
try {
  const result = await analyzeFrontendInline(workerData);
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024)
    throw new Error("前端原件超过32MiB预算；需拆分批准范围，不截断后宣称通过");
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: redactLog(error.message) });
}
