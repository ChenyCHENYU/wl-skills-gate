export function decide({ checkResults, counts }) {
  const invalid = checkResults.filter((r) => r.status === "invalid");
  if (invalid.length) {
    return { status: "invalid", reasons: invalid.map((r) => `检查失效: ${r.checkId} — ${r.reason}`) };
  }
  if (counts.blockingNew > 0) {
    return {
      status: "blocked",
      reasons: [`${counts.blockingNew} 条新增强制问题（含到期豁免回退）未处置，禁止晋级/部署`],
    };
  }
  return { status: "passed", reasons: [] };
}
