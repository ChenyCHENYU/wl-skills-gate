export function decide({ checkResults, counts }) {
  const invalid = checkResults.filter((r) => r.status === "invalid");
  if (invalid.length) {
    return { status: "invalid", reasons: invalid.map((r) => `检查失效: ${r.checkId} — ${r.reason}`) };
  }
  if (counts.blockingNew > 0) {
    return {
      status: "blocked",
      reasons: [`${counts.blockingNew} 条强制问题未处置（极高/严重不接受历史基线或豁免），禁止晋级/部署`],
    };
  }
  return { status: "passed", reasons: [] };
}
