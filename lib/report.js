import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256, truncate } from "./util.js";

export function writeReports(outDir, summary) {
  mkdirSync(outDir, { recursive: true });
  const summaryFile = path.join(outDir, "quality-summary.json");
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  const reportDigest = sha256(JSON.stringify(summary));
  writeFileSync(path.join(outDir, "quality-report.md"), renderMarkdown(summary, outDir));
  writeFileSync(path.join(outDir, "quality-report.html"), renderHtml(summary));
  const codeQualityDir = path.join(outDir, "code-quality");
  mkdirSync(codeQualityDir, { recursive: true });
  const severity = { blocker: "critical", error: "major", warning: "minor", info: "info" };
  const codeQuality = summary.findings.map((f) => ({
    description: f.message || f.ruleId, check_name: f.ruleId, fingerprint: f.fingerprint,
    severity: severity[f.severity], categories: ["Bug Risk"],
    location: { path: f.file.startsWith("(") || path.isAbsolute(f.file) ? "quality/policy.yml" : f.file.replace(/^\.\//, ""),
      lines: { begin: Number.isInteger(f.line) && f.line > 0 ? f.line : 1 } },
  }));
  writeFileSync(path.join(codeQualityDir, "gl-code-quality-report.json"), JSON.stringify(codeQuality, null, 2));
  return { summaryFile, reportDigest };
}

export function writeAttestation(outDir, attestation) {
  const file = path.join(outDir, "gate-attestation.json");
  writeFileSync(file, JSON.stringify(attestation, null, 2));
  return file;
}

function cell(text) {
  return truncate(text, 160).replace(/[\n\r|]/g, " ");
}

function positionOf(f) {
  const lines = [...new Set((f.occurrences || []).map((o) => o.line).filter((l) => l != null))];
  if (lines.length > 1) return `${f.file}（行 ${lines.join("/")}，共 ${lines.length} 处）`;
  return `${f.file}${f.line ? `:${f.line}` : ""}`;
}

function esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(s) {
  const rows = (items, cells) => items.map((it) => `<tr>${cells(it).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("\n");
  const checkRows = rows(s.checks, (c) => [c.checkId, c.tool, c.status, c.findingsCount ?? "-", c.reason || c.note || ""]);
  const findingRows = s.findings.length
    ? rows(s.findings, (f) => [
        f.status,
        f.severity,
        f.ruleId,
        positionOf(f),
        f.suggestion ? `${f.message} ｜ 建议：${f.suggestion}` : f.message,
        f.waiverId || f.waiverRejected || "-",
      ])
    : '<tr><td colspan="6">（无）</td></tr>';
  const statusColor = s.decision.status === "passed" ? "#2bb268" : s.decision.status === "blocked" ? "#bb2d3f" : "#ea9a13";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>质量门禁报告 — ${esc(s.run.project)}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#303133}
h1{font-size:20px} .meta{color:#606266;font-size:13px;line-height:1.8}
.badge{display:inline-block;padding:2px 12px;border-radius:12px;color:#fff;font-weight:600}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
th,td{border:1px solid #d9d9d9;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f5f7fa} code{background:#f5f7fa;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>质量门禁报告 — ${esc(s.run.project)}</h1>
<p class="meta"><span class="badge" style="background:${statusColor}">${esc(s.decision.status)}</span>
profile=${esc(s.run.profile)}｜SHA=${esc(s.run.commitSha)}｜${esc(s.run.startedAt)}｜耗时 ${s.run.durationMs}ms｜${esc(s.run.tool)}</p>
<ul class="meta">
<li>policyHash：<code>${esc(s.policy.policyHash || "")}</code>｜ruleSetHash：<code>${esc(s.policy.ruleSetHash || "未配置")}</code>｜enforceWarnings=${s.policy.enforceWarnings}｜blockerWaivers=${esc(s.policy.blockerWaivers)}</li>
<li>计数：new=${s.counts.new} existing=${s.counts.existing} waived=${s.counts.waived} expired=${s.counts.expired} blockingNew=${s.counts.blockingNew}</li>
${s.decision.reasons.map((r) => `<li>${esc(r)}</li>`).join("\n")}
</ul>
<h2>检查执行</h2>
<table><tr><th>检查</th><th>工具</th><th>状态</th><th>问题数</th><th>说明</th></tr>
${checkRows}</table>
<h2>问题清单</h2>
<table><tr><th>状态</th><th>级别</th><th>规则</th><th>位置</th><th>说明</th><th>豁免</th></tr>
${findingRows}</table>
<p class="meta">修复入口：<code>wl-skills-gate fix --plan ${esc(s.run.outDir || "quality-reports")}/quality-summary.json</code></p>
</body></html>
`;
}

function renderMarkdown(s, outDir) {
  const lines = [];
  lines.push(`# 质量门禁报告 — ${s.run.project}`);
  lines.push("");
  lines.push(`- 结论：**${s.decision.status}**`);
  for (const r of s.decision.reasons) lines.push(`  - ${r}`);
  lines.push(
    `- Profile：${s.run.profile}｜SHA：${s.run.commitSha}｜开始：${s.run.startedAt}｜耗时：${s.run.durationMs}ms`
  );
  lines.push(
    `- policyHash：${s.policy.policyHash ? s.policy.policyHash.slice(0, 12) : "无"}｜ruleSetHash：${
      s.policy.ruleSetHash ? s.policy.ruleSetHash.slice(0, 12) : "未配置"
    }`
  );
  lines.push(
    `- 计数：new=${s.counts.new} existing=${s.counts.existing} waived=${s.counts.waived} expired=${s.counts.expired} blockingNew=${s.counts.blockingNew}`
  );
  lines.push("");
  lines.push("## 检查执行");
  lines.push("");
  lines.push("| 检查 | 工具 | 状态 | 问题数 | 说明 |");
  lines.push("|---|---|---|---|---|");
  for (const c of s.checks) {
    lines.push(`| ${c.checkId} | ${c.tool} | ${c.status} | ${c.findingsCount ?? "-"} | ${cell(c.reason || c.note || "")} |`);
  }
  lines.push("");
  lines.push("## 问题清单");
  lines.push("");
  if (!s.findings.length) {
    lines.push("（无）");
  } else {
    lines.push("| 状态 | 级别 | 规则 | 位置 | 说明 | 豁免 |");
    lines.push("|---|---|---|---|---|---|");
    for (const f of s.findings) {
      const desc = f.suggestion ? `${f.message} ｜ 建议：${f.suggestion}` : f.message;
      const waiver = f.waiverId || (f.waiverRejected ? `${f.waiverRejected}（blocker 豁免被拒）` : "-");
      lines.push(`| ${f.status} | ${f.severity} | ${f.ruleId} | ${positionOf(f)} | ${cell(desc)} | ${waiver} |`);
    }
  }
  lines.push("");
  lines.push("## 修复入口");
  lines.push("");
  lines.push("```bash");
  lines.push(`wl-skills-gate fix --plan ${path.join(outDir, "quality-summary.json")}`);
  lines.push("```");
  if (s.waivers && s.waivers.invalidRecords.length) {
    lines.push("");
    lines.push(
      `> 存在 ${s.waivers.invalidRecords.length} 条无效豁免（缺字段/日期非法，按无豁免处理）：${s.waivers.invalidRecords
        .map((i) => `${i.record}(${i.reason})`)
        .join("、")}`
    );
  }
  if (s.baseline && s.baseline.resolvedPending.length) {
    lines.push("");
    lines.push(
      `> 基线中 ${s.baseline.resolvedPending.length} 个指纹本次未出现，标记待复验移除：需核对扫描范围与规则未缩减、取得复验证据后方可关闭，禁止自动移除。`
    );
  }
  return `${lines.join("\n")}\n`;
}
