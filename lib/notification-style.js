const levels = [
  ["blocker", "极高", "carmine"], ["error", "严重", "red"],
  ["warning", "警告", "orange"], ["info", "提示", "blue"],
];

// Use Card 2.0 native text_color, not inline HTML that may lose styling.
// Labels and values keep their semantic color even when the count is zero.
export function notificationText(content, color = "default", size = "normal") {
  return { tag: "div", text: { tag: "plain_text", content, text_color: color, text_size: size } };
}

export function riskCountsElement(counts) {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "6px", columns: levels.map(([level, label, color]) => {
    const count = counts[level];
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("风险数量必须为非负整数");
    const value = notificationText(`${label} ${count}`, color);
    value.text.text_align = "center";
    return { tag: "column", width: "weighted", weight: 1, background_style: `${color}-50`, padding: "6px 0px 6px 0px", elements: [value] };
  }) };
}

export function repairAdviceElement(suggestions) {
  return { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, background_style: "blue-50", padding: "8px 10px 8px 10px", vertical_spacing: "4px", elements: [
    notificationText("修复建议 · 确认后执行，修复后自动复扫", "blue"),
    notificationText(suggestions, "blue"),
  ] }] };
}

export function riskStyle(severity) {
  const match = levels.find(([level]) => level === severity);
  return match ? { label: match[1], color: match[2] } : { label: "待分类", color: "orange" };
}

// Show at most three findings, highest risk first, without changing the report.
export function findingPreview(findings) {
  const rank = (finding) => { const index = levels.findIndex(([level]) => level === finding.severity); return index < 0 ? levels.length : index; };
  const visible = [...findings].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  return { visible, total: findings.length, remaining: findings.length - visible.length };
}
