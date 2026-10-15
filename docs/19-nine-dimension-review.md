# 九维 Review 技术契约

当前自动入口：`automation`负责真实发现、采集、对账与通知；`review-ci`自动汇总同候选九维原件并登记；`control serve`提供OIDC认证确认页面。具体中央参数与部署模板见[中央执行接线](../templates/platform/README.md)。以下CLI是维护/诊断接口，日常开发无需手工执行。

本文供工程工具与 GitLab/Jenkins 接线维护者使用。已接项目的七步操作以接入手册为准；开发人员由 Hook、IDE 和流水线自动得到草稿与反馈，无需填写下列 JSON 或输入命令。

## 输入、输出与权限

| 环节 | 输入与接口 | 产物 / 放行条件 |
|---|---|---|
| 汇总草稿 | `buildReviewInput` 自动取本轮原始 Gate 报告；其他采集器补提交、分支、diff、交互、测试、CI 和责任证据 | 固定九维 `review.md`、`review-draft.json`；永远 `pending-confirmation` |
| 人工确认 | 受控身份服务核对实际登录身份、非作者、候选和九维结论，再签发 `review-authorization` receipt | 仅 `review-publish`，绑定当前正文/证据/候选；不是修复或发布权限 |
| 正式签发 | `signReviewRecord` / `review-sign`：独立身份公钥、固定 issuer、受控规则摘要与 Review 私钥 | 严格 v2 `review-record`，签名覆盖正文和证据摘要、逐维确认及授权 receipt |
| 使用前重验 | `verifyReview`；`promote-apply` 已实际调用此验证 | 重验原始文件、正文、九维完整性、当前 Gate 报告、授权签名/时效与候选，任一不符即拒绝 |

草稿不能放行。只上传扫描报告只能覆盖部分编码/扫描事实，其余维度明确显示 `pending-evidence`。正式签发必须九维齐全；不适用项须已批准的策略写明事实，再由非作者逐项确认。Code Review 和扫描门禁不能标成 N/A。

## 文件契约

采集作业把本轮所需文件下载到独立的 `evidenceRoot`，从真实来源 API 核对项目、候选、作业终态和访问权限。每项证据写明 `id/type/source/project/candidateSha/file/dimensionIds`；文件仅接受根目录内的明确相对路径，不接受链接或越界路径。

- [review-policy.json](../templates/quality/review-policy.json)：九维适用项和必需证据类型。维护者替换项目 ID，经技术经理确认后固定其规范化 SHA256；签发与晋级作业使用受控 `expectReviewPolicyHash`，不能直接信任候选分支传入的值。
- [review-input.example.json](../templates/quality/review-input.example.json)：汇总输入结构示例，SHA、账号和作业值都是占位，不能作为真实证据。正常接线由采集器自动生成。
- 输出目录必须是证据根目录内尚不存在的新目录，父目录已存在；在同父临时目录完整生成两文件后持有独占锁原子交付。已有目录、符号链接、输入/证据位置均在写前拒绝，失败清理临时产物。
- 正式记录与草稿、原始证据分开保存。CLI 写前调用 `validateReviewOutputLocation`，禁止覆盖任何已有文件。

Gate 验证文件完整性和已批准契约，不把 `source` 字符串当作远端真实性证明。真实性由受控采集器查询来源和独立 Reviewer 判断；身份由受控签名 receipt 验证。缺少这些真实接线时，只能登记本地能力已验收，不能登记实际项目九维闭环已完成。

## 自动生成草稿的 SDK 示例

下面可由项目或受控汇总任务直接调用。路径均指向本轮已存在的真实文件；输出是新的报告目录，不会执行修复、签名或通知。

```javascript
import { buildReviewInput, createReviewDraft } from "@agile-team/wl-skills-gate/lib/review.js";

const input = buildReviewInput({
  evidenceRoot: "/job/evidence",
  summaryFile: "/job/evidence/quality-summary.json",
  policyFile: "/job/evidence/review-policy.json",
  // beforeSummaryFile: "/job/evidence/before/quality-summary.json",
  authorId: authenticatedAuthorId,
  context: {
    source: verifiedJobReference,
    sourceBranch, targetBranch, sourceSha, targetBeforeSha
  }
});
// 采集器按已批准的 policy 自动补全 input.evidence；不把未执行项目填成通过。
const result = createReviewDraft({
  input, evidenceRoot: "/job/evidence", outDir: "/job/evidence/review-本轮唯一编号"
});
// result.approved === false；result.dimensions 给出每维度待补证据。
```

已有输入文件时，受控任务调用 `review-draft --input <本轮输入.json> --evidence-root <根目录> --out <新报告目录>`。这属于运维接线接口，不是交给开发人员每日手动执行的步骤。

## 独立身份授权 receipt

身份服务必须在实际人工确认后签发下面的有效载荷，使用自己的 Ed25519 私钥；Gate 正式签发作业只持有其公钥。身份私钥与 Review 签发私钥不能共用，也不能进入候选源码执行作业。使用 `signRecord(payload, identityPrivateKeyFile)` 生成兼容签名结构；该底层 API 不替代登录认证、Reviewer 权限查询或人工确认。

```json
{
  "schemaVersion": 1,
  "kind": "review-authorization",
  "issuer": "固定身份授权方",
  "authorizationId": "实际审批记录编号",
  "identitySource": "实际登录身份及权限查询来源",
  "scope": "review-publish",
  "decision": "approved",
  "actorId": "实际非作者Reviewer",
  "authorId": "实际作者",
  "project": "实际项目",
  "candidateSha": "本轮真实候选SHA",
  "reviewDigest": "草稿返回的reviewDigest",
  "bodyDigest": "草稿返回的bodyDigest",
  "evidenceDigest": "草稿返回的evidenceDigest",
  "createdAt": "实际确认时间ISO8601",
  "expiresAt": "批准有效期ISO8601",
  "reason": "本轮复核结论",
  "dimensionDecisions": [
    { "id": "submission", "decision": "approved", "reason": "实际结论" },
    { "id": "branch", "decision": "approved", "reason": "实际结论" },
    { "id": "coding", "decision": "approved", "reason": "实际结论" },
    { "id": "ui", "decision": "approved", "reason": "实际结论；N/A时用not-applicable并写事实" },
    { "id": "review", "decision": "approved", "reason": "实际结论" },
    { "id": "tests", "decision": "approved", "reason": "实际结论" },
    { "id": "scan", "decision": "approved", "reason": "实际结论" },
    { "id": "cicd", "decision": "approved", "reason": "实际结论" },
    { "id": "governance", "decision": "approved", "reason": "实际结论" }
  ]
}
```

示例未签名，故不能放行。实际 receipt 须带 `signature: {algorithm:"Ed25519", value:"实际base64签名"}`；默认授权最大 24 小时，过期、未来、错误 issuer、同一密钥、自审、非逐维确认或摘要变动均拒绝。

`signReviewRecord` 的受控参数：`recordFile/privateKeyFile/authorizationFile/authorizationPublicKeyFile/expectAuthorizationIssuer/evidenceRoot/reviewerId/authorId/project/sha/expectReviewPolicyHash/expectPolicyHash/expectRulesHash/expectBaselineHash/expectWaiversHash`，检查档位默认 `standard`。`verifyReview` 改用 `publicKeyFile` 与正式 `recordFile`，保留独立身份公钥、issuer、证据根和受控摘要。

正式 Review 只确认这份报告。代码修复用独立具体方案授权；晋级/部署仍验证 Gate 证明、制品、目标和发布权限；问题关闭仍走独立复验。

## 修前修后与验收

对比自动校验项目、档位、范围/基点、环境、policy/rules/baseline/waivers、必需检查、工具锁定版本和实际执行证据。口径变化只显示观测值及变化项，不能声明质量改善；同口径时给出风险计数与指纹消失/保留/新增。机器问题减少不等于业务正确、Review 批准或问题关闭。

`node --test scripts/lib-tests/review.test.mjs` 覆盖扫描不能替代九维、缺证据、N/A、自审、旧正文/错误候选/过期、身份签名与密钥分离、原始文件篡改、Gate 未完整执行、修前修后口径、输出覆盖/越界/链接/半成品。`node scripts/run-integration.mjs` 在隔离 Git 仓库验证真实候选、签名、晋级及拒绝路径；外部身份/非扫描维度使用明确标记的隔离模拟事实，不作远端实接证明。

已接项目配置quality/review-policy.json后，standard/release会自动生成九维草稿、逐轮原始报告和review-latest.json；无需开发者另调SDK。未认证本地作者明确标记，正式候选必须由中央采集真实作者与九维其他证据，独立确认后再签发。修前后口径不完整或变化时只展示观测值，不标质量改善；草稿生成异常使自动流程非零退出。
