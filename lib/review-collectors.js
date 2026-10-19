import path from "node:path";
import { controlledPath, readControlledJson } from "./control-store.js";
import { loadReviewCollectorConfig } from "./review-collect.js";
import { loadCiSourceConfig } from "./ci-source.js";
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
export function collectorFiles(spec) {
  return [spec.collectorConfigFile, ...(spec.additionalCollectorConfigFiles || [])];
}
export function resolveAdditionalCollectors(spec, base) {
  if (spec.additionalCollectorConfigFiles === undefined) return;
  assert(
    Array.isArray(spec.additionalCollectorConfigFiles) &&
      spec.additionalCollectorConfigFiles.every((file) => typeof file === "string" && !!file),
    "附加Review采集器须为固定路径数组"
  );
  spec.additionalCollectorConfigFiles = spec.additionalCollectorConfigFiles.map((file) =>
    controlledPath(path.resolve(base, file))
  );
  assert(new Set(collectorFiles(spec)).size === collectorFiles(spec).length, "Review采集器重复登记");
}
export function assertCollectorApproved(spec, file) {
  file = controlledPath(file);
  assert(collectorFiles(spec).includes(file), "Review采集器不在本项目批准清单内");
  return file;
}
export function collectorFromProvenance(spec, file) {
  return assertCollectorApproved(spec, readControlledJson(controlledPath(file)).configFile);
}
export function assertCollectorScopes(spec, project, governance) {
  if (!spec.additionalCollectorConfigFiles?.length) return;
  const scopes = new Set();
  for (const file of collectorFiles(spec)) {
    const collector = loadReviewCollectorConfig(file),
      ci = loadCiSourceConfig(collector.ciConfigFile);
    assert(
      collector.project === project && ci.project === project && !scopes.has(ci.scope),
      "一个项目的每个Review采集器必须绑定独立scope，不能跨分支串用状态"
    );
    if (governance) assert(governance.projects[project]?.scopes[ci.scope], "Review采集范围未登记治理策略");
    scopes.add(ci.scope);
  }
}
