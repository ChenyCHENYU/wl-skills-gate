# 06 GitLab 接线

包内候选、独立 Review、签发、条件更新和采集程序已交付；GitLab 权限与实际 Runner 另做现场验收。本包配置为公共 npm 发布；使用须先取得 AGILE TEAM 书面授权，见 [LICENSE](../LICENSE)。以下 registry 是可选内网镜像/托管接线示例，不代表本包已发布到该地址；使用内网地址时须另行核验实际镜像版本与访问权限。

## 发布到内网 registry

项目 .npmrc 使用环境变量引用认证，凭据不写入文件正文：

```ini
@agile-team:registry=https://<gitlab-host>/api/v4/projects/<package-project-id>/packages/npm/
//<gitlab-host>/api/v4/projects/<package-project-id>/packages/npm/:_authToken=${NPM_TOKEN}
```

受控发包作业注入 NPM_TOKEN 后 npm publish。消费可改为 CI_JOB_TOKEN，并由管理员核验跨项目 allowlist/实际权限。[GitLab 官方 npm 认证](https://docs.gitlab.com/user/packages/npm_registry/#with-the-npmrc-file)。

## 只读检查作业

从固定 Gate 包提取 [前端模板](../templates/ci/gitlab-frontend.yml) 或 [后端模板](../templates/ci/gitlab-backend.yml)，冻结到统一 CI 仓库；项目 include 固定 tag/commit，合并实际 stages/workflow/rules，保留所有业务必需作业。质量作业不得 allow_failure 或用 `|| true` 吞错。

| 受控项 | 用途 |
|---|---|
| `WL_APPROVED_QUALITY_IMAGE` / `WL_APPROVED_JAVA_QUALITY_IMAGE` | 固定前端 / Java 检查镜像，包含批准 Node ≥22.12、项目固定包管理器及 JDK/Maven |
| `WL_APPROVED_BOOTSTRAP_GATE_CLI` | 镜像预装的固定 Gate，先于项目依赖执行 `ci-prepare` |
| `WL_APPROVED_WORKSPACE_HASH`、`WL_APPROVED_DEPENDENCY_LOCK_HASH` | 已审阅提交的工作副本清单与对应依赖锁真实字节摘要 |
| `WL_APPROVED_POLICY_HASH`、`WL_APPROVED_RULES_HASH`、`WL_APPROVED_BASELINE_HASH`、`WL_APPROVED_WAIVERS_HASH` | 技术经理/运维批准登记的四类摘要，不能从候选现算后自封批准 |

模板按锁安装并关闭任意生命周期，只运行固定 Gate 内的必要准备适配。包管理器不符、未知 prepare/postinstall、锁或源码漂移均阻断；不使用 corepack 隐式下载另一版本。准备成功后，前端执行根工程 Gate，后端执行 quality-tools 内 Gate 与实际 Maven 检查。模板自动生成 Review 事实并 always 归档报告，不把准备阶段当质量通过。

检查 Runner 不持有签发、晋级、部署或通知凭据。Gate 与项目清单固定同一批准版本；升级时重新审阅清单、依赖锁和批准摘要。详细入口见 [17 统一接入](17-onboarding.md)。

上述采用全量 standard，不依赖 MR。若增加增量，分别处理 push/MR/候选/定时场景、首次 push 全零 SHA 与浅克隆缺历史，head 与 checkout 相同。MR 专属变量只在实际 MR pipeline 使用。[GitLab 变量说明](https://docs.gitlab.com/ci/variables/predefined_variables/#predefined-variables-for-merge-request-pipelines)。

普通 include 锁 tag 用于复用，项目仍能覆盖/删除，不能作为不可绕过证明。[include 合并规则](https://docs.gitlab.com/ci/yaml/includes/#override-included-configuration-values)。硬门来自服务端强制策略或独立受控晋级作业与受保护共享分支。

## 候选检查：无特权 Runner

```bash
wl-skills-gate promote --source "$SOURCE_BRANCH" --target "$TARGET_BRANCH" \
  --expect-policy-hash "$WL_APPROVED_POLICY_HASH" \
  --expect-rules-hash "$WL_APPROVED_RULES_HASH" \
  --prepare-command "$WL_APPROVED_CANDIDATE_PREPARE_COMMAND"
```

候选工作树使用中央固定的 `WL_APPROVED_CANDIDATE_PREPARE_COMMAND`，从候选根调用同一 `ci-prepare`，带入批准清单/锁摘要；不让作者提供任意安装命令或生命周期。Java 业务准备和实际检查由批准适配执行。输出在 quality-reports/promotion-<id>/：候选检查、unsigned 结果、promotion-record.json、candidate.bundle。失败也保留记录/报告。这个作业只能读源/目标，不更新共享分支；归档 bundle 供控制器导入。

## 独立 Review、签发和更新

1. 受控作业保存候选 SHA、源/目标 HEAD 与作业 ID；授权非作者 Reviewer 检查候选，逐项处理阻断问题。
2. 自动生成九维草稿，补齐适用证据，非作者逐维确认；独立身份服务签发绑定正文/证据/候选的授权receipt。Review作业用固定身份公钥/issuer校验后review-sign，使用与身份服务分离的Review密钥；见[19 九维Review](19-nine-dimension-review.md)。
3. 签发作业权威查询检查来源和成功状态，再 attest：standard 档、固定期望、源 job ID，使用 --promotion-record 绑定该候选记录。
4. 受控更新作业执行：

```bash
wl-skills-gate promote-apply signed-proof.json \
  --record promotion-record.json --bundle candidate.bundle \
  --remote-url "$WL_CONTROLLED_REMOTE_URL" --project "$WL_PROJECT" \
  --summary quality-summary.json --public-key "$WL_GATE_PUBLIC_KEY" \
  --expect-issuer "$WL_GATE_ISSUER" \
  --expect-pipeline-id "$WL_VERIFIED_PIPELINE_ID" --expect-job-id "$WL_VERIFIED_JOB_ID" \
  --expect-policy-hash "$WL_APPROVED_POLICY_HASH" --expect-rules-hash "$WL_APPROVED_RULES_HASH" \
  --review review-record.json --review-public-key "$WL_REVIEW_PUBLIC_KEY" \
  --review-evidence-root "$WL_REVIEW_EVIDENCE_ROOT" --expect-review-policy-hash "$WL_APPROVED_REVIEW_POLICY_HASH" \
  --authorization-public-key "$WL_IDENTITY_PUBLIC_KEY" --expect-authorization-issuer "$WL_IDENTITY_ISSUER" \
  --out controller-audit
```

若有基线/例外，补其批准摘要。控制器在新 bare 仓库核验签名、Review、候选父提交、最新远端源/目标 HEAD，核验父提交后以批准的旧 HEAD 条件更新；不运行候选代码/项目 Hook。运维对同一目标分支串行化（例如 resource_group），配合保护分支和禁止普通写入；晚到候选需重新生成和 Review。

更新前先落审计记录，审计目录不可写则拒绝更新；所有尝试保留控制器审计。若更新已成功但最终审计写入失败，返回 `promoted-audit-failed` 和非零退出码；运维必须核对远端实际 HEAD 并补齐记录，不能当作未更新而盲目重试。临时 bare 仓库在失败和成功后均清理。

B2/B3 分支保护与服务端接收控制仍由管理员配置，不能用本地 Hook 宣称“服务端拒绝接收”。

## 首期台账与通知

B6/D1～D4 与样板同步建设：失败按项目/指纹幂等建单，分派主备，消息包含问题/报告/流水线认证链接，认领和复验回写主台账，定时升级无人认领/逾期。通知任务使用独立凭据并重试；通知失败不覆盖原门禁退出码。对账发现未运行或配置/权限漂移，不仅监听失败事件。

## 摘要、并发与失败处理

有 baseline/waivers 文件时，检查、promote、attest、promote-apply、release/verify-artifact 各环节都传同一批准摘要；它们来自中央审批登记，而不是在候选里自行计算并批准。候选依赖准备结果保存 dependency-prepare.json（退出码、耗时、超时/截断、脱敏输出），promotion-record.preparation 引用日志；prepare 失败不丢失网络/仓库错误上下文。日志脱敏是辅助措施，仍须限制访问与保留期，禁止把凭据直接写进命令。

控制器使用 `--force-with-lease=refs/heads/<target>:<批准旧SHA>` 原子核对目标 HEAD，同时强制候选恰有批准的目标/源两个父提交，因此只允许批准旧 HEAD 的快进。此处不开放任意强推/回退功能。上线必须实测当前 GitLab 保护分支与受控账号接受这一条件更新，并保持禁止一般强推的保护策略；不能为了适配而放开任意强推。[Git push 显式 lease 语义](https://git-scm.com/docs/git-push)。

该条件更新保护目标分支；源分支最后核对与目标更新不是多引用原子事务。如果团队要求“更新瞬间源分支也必须最新”，由服务端接收校验、固定源引用或受控锁补充实现，不能将本地 HEAD 检查写成全局原子保证。

台账准入不得简单使用“项目只要有未关闭问题就禁止所有发布”。修复发布可凭绑定本次修复 SHA/范围的有效质量、Review 和回归证据，在授权范围内进入目标环境复验，再关闭；原事故的恢复与根因整改分开记录。具体准入参见 12 与落地执行附录 C。
