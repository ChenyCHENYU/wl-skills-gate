const text = (value) => typeof value === "string" && !!value.trim() && value.length <= 300;
export function validateReportCatalog(catalog) {
  if (catalog === undefined) return;
  if (!catalog || Array.isArray(catalog) || typeof catalog !== "object") throw new Error("reportCatalog须为对象");
  const modules = catalog.modules || [],
    standards = catalog.standards || [];
  if (!Array.isArray(modules) || !Array.isArray(standards)) throw new Error("reportCatalog模块/标准须为数组");
  const seen = new Set();
  for (const module of modules) {
    if (!text(module.name) || !Array.isArray(module.paths) || !module.paths.length)
      throw new Error("业务模块缺name/paths");
    for (const file of module.paths) {
      if (
        typeof file !== "string" ||
        !file ||
        file.startsWith("/") ||
        file.includes("\\") ||
        file.split("/").some((part) => !part || part === "." || part === "..") ||
        seen.has(file)
      )
        throw new Error("业务模块路径越界、别名或重复登记");
      seen.add(file);
    }
  }
  const rules = new Set();
  for (const standard of standards) {
    if (
      !text(standard.title) ||
      !text(standard.version) ||
      !text(standard.clause) ||
      !Array.isArray(standard.ruleIds) ||
      !standard.ruleIds.length
    )
      throw new Error("内部标准需title/version/clause/ruleIds");
    for (const rule of standard.ruleIds) {
      if (!text(rule) || rules.has(rule)) throw new Error("内部标准规则为空/重复，不能歧义映射");
      rules.add(rule);
    }
  }
}
export function findingCatalog(finding, catalog = {}) {
  const matches = (catalog.modules || []).flatMap((module) =>
    module.paths
      .filter((file) => finding.file === file || finding.file.startsWith(file + "/"))
      .map((file) => ({ name: module.name, length: file.length }))
  );
  const standard = (catalog.standards || []).find((standard) => standard.ruleIds.includes(finding.ruleId));
  return {
    module: matches.sort((a, b) => b.length - a.length)[0]?.name || "未登记业务模块",
    standard: standard ? `${standard.title} · ${standard.version} · ${standard.clause}` : null,
  };
}
