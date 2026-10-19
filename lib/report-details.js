import path from "node:path";
import { findingCatalog } from "./report-catalog.js";
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const levels = { blocker: "极高", error: "严重", warning: "警告", info: "提示" };

export function reportDetails(summary) {
  const findings = summary.findings || [],
    files = new Map(),
    process = [];
  findings.forEach((finding, index) => {
    const mapped = findingCatalog(finding, summary.policy?.reportCatalog || {});
    const item = { ...finding, index, moduleName: mapped.module, standardRef: mapped.standard };
    if (!item.file || item.file.startsWith("(") || !item.line) {
      process.push(item);
      return;
    }
    const existing = files.get(item.file) || [];
    existing.push(item);
    files.set(item.file, existing);
  });
  const options = (values) =>
    [...new Set(values.filter(Boolean))]
      .sort()
      .map((x) => `<option value="${esc(x)}">${esc(x)}</option>`)
      .join("");
  const detail = (
    f
  ) => `<article class="finding" id="finding-${f.index}" data-risk="${esc(f.severity)}" data-dimension="${esc(f.dimension || "未分类")}" data-state="${esc(f.status)}">
    <p><strong>${esc(levels[f.severity] || f.severity)}</strong> · ${esc(f.dimension || "未分类")} · ${esc(f.status)} · <code>${esc(f.ruleId)}</code></p>
    <p>${esc(f.file)}${f.line ? `:${f.line}${f.endLine && f.endLine !== f.line ? "–" + f.endLine : ""}` : " · 无源码行定位"}</p>
    ${(f.occurrences?.length || 0) > 1 ? `<p>本文件全部发生位置（${f.occurrences.length}处）：${f.occurrences.map((location) => esc(`${location.line || "未定位"}${location.endLine && location.endLine !== location.line ? "–" + location.endLine : ""}`)).join("、")}</p>` : ""}
    ${f.relatedLocations?.length ? `<p>关联位置：${f.relatedLocations.map((location) => esc(`${location.file}:${location.line}${location.endLine && location.endLine !== location.line ? "–" + location.endLine : ""}`)).join("；")}</p>` : ""}
    <p>${esc(f.message)}</p><p><b>建议：</b>${esc(f.suggestion || "核对原始规则与实际业务，修复后复扫")}</p>
    <p><b>修复方式：</b>${f.autoFixable ? "可生成机械修复计划，确认后执行并自动复扫" : "需人工判断；不自动改写业务语义"}</p>
    <p><b>对照：</b>${esc(f.dimension || "编码规范")} / ${esc(f.ruleId)}；固定配置与版本见下方覆盖证据。${f.standardRef ? esc(f.standardRef) : "项目专属标准条款未登记时不伪造条款编号。"}</p>
    ${f.context ? `<details><summary>原生规则、风险依据与关联位置</summary><pre>${esc(typeof f.context === "string" ? f.context : JSON.stringify(f.context, null, 2))}</pre></details>` : ""}</article>`;
  const tree = [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([file, items]) =>
        `<details class="file-group" open><summary>${esc(items[0].moduleName)} → ${esc(path.posix.dirname(file))} / <b>${esc(path.posix.basename(file))}</b> · ${items.length}项</summary>${items
          .sort((a, b) => a.line - b.line)
          .map(detail)
          .join("")}</details>`
    )
    .join("");
  const risks = Object.entries(levels)
    .map(([key, name]) => `${name} ${findings.filter((f) => f.severity === key).length}`)
    .join(" · ");
  const evidence = (summary.checks || [])
    .map(
      (check) =>
        `<details><summary>${esc(check.checkId)} · ${esc(check.status)} · ${check.findingsCount ?? "未执行"}项</summary><pre>${esc(JSON.stringify({ toolVersion: check.toolVersion, coverage: check.coverage, metrics: check.metrics, production: check.production }, null, 2))}</pre></details>`
    )
    .join("");
  return `<section id="detail-browser"><h2>按目录 / 文件定位</h2><p>${esc(risks)}（归并问题项）；共${findings.reduce((n, f) => n + (f.occurrences?.length || 1), 0)}处发生。筛选仅影响显示，不改变门禁结论。</p>
    <label>风险 <select id="risk-filter"><option value="">全部</option>${Object.entries(levels)
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join("")}</select></label>
    <label>维度 <select id="dimension-filter"><option value="">全部</option>${options(findings.map((f) => f.dimension || "未分类"))}</select></label>
    <label>状态 <select id="state-filter"><option value="">全部</option>${options(findings.map((f) => f.status))}</select></label>
    <p id="filtered-count"></p>${tree || "<p>本轮没有带源码行定位的问题。</p>"}
    ${process.length ? `<details open><summary>流程 / 无源码行定位的问题 · ${process.length}项</summary>${process.map(detail).join("")}</details>` : ""}
    <h2>检查覆盖与原始证据</h2>${evidence}
    <p>未运行、缺报告、部分成功不计为零问题；业务菜单与内部标准来自批准policy.reportCatalog，未登记时明确显示，不从目录名推断业务含义。</p></section>
    <style>.finding{padding:12px;margin:8px 0;border-left:4px solid #8295ad;background:#f7f9fc}.finding[data-risk="error"],.finding[data-risk="blocker"]{border-color:#b52d3d}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;padding:8px}label{display:inline-block;margin:8px 12px 8px 0}select{padding:6px}[hidden]{display:none!important}</style>
    <script>(()=>{const controls=[['risk','risk-filter'],['dimension','dimension-filter'],['state','state-filter']];const update=()=>{let visible=0;document.querySelectorAll('.finding').forEach(item=>{item.hidden=controls.some(([key,id])=>document.getElementById(id).value&&document.getElementById(id).value!==item.dataset[key]);if(!item.hidden)visible++;});document.querySelectorAll('.file-group').forEach(group=>{group.hidden=![...group.querySelectorAll('.finding')].some(item=>!item.hidden);});document.getElementById('filtered-count').textContent='当前显示 '+visible+' / '+document.querySelectorAll('.finding').length+' 项';};controls.forEach(([,id])=>document.getElementById(id).addEventListener('change',update));update();})();</script>`;
}
