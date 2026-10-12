# 06 GitLab 接线

对应 B1～B6；当前为接线说明/模板，平台权限和实际 Runner 尚待验收。以下 registry 是可选的内网接线示例，不代表本包已发布到该地址；固定 0.6.0 版本须先核验目标 registry 的发布回执。

## 发布到内网 registry

项目 .npmrc 使用环境变量引用认证，凭据不写入文件正文：

```ini
@agile-team:registry=https://<gitlab-host>/api/v4/projects/<package-project-id>/packages/npm/
//<gitlab-host>/api/v4/projects/<package-project-id>/packages/npm/:_authToken=${NPM_TOKEN}
```

受控发包作业注入 NPM_TOKEN 后 npm publish。消费可改为 CI_JOB_TOKEN，并由管理员核验跨项目 allowlist/实际权限。[GitLab 官方 npm 认证](https://docs.gitlab.com/user/packages/npm_registry/#with-the-npmrc-file)。

## 只读检查作业

前端中央模板示意；hash 由批准登记表下发，不能从候选文件现算后当批准：

```yaml
wl-quality-check:
  stage: test
  image: node:20
  script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - >-
      npx -y @agile-team/wl-skills-gate@0.6.0 run
      --profile standard --sha "$CI_COMMIT_SHA"
      --expect-policy-hash "$WL_APPROVED_POLICY_HASH"
      --expect-rules-hash "$WL_APPROVED_RULES_HASH"
  artifacts:
    when: always
    paths: [quality-reports/]
    reports:
      codequality: quality-reports/code-quality/gl-code-quality-report.json
      # junit: quality-reports/junit/*.xml  # 真实测试生产者已接入后启用
```

这个 job 不持有签发/晋级/部署/通知凭据。后端使用受控 Node+JDK+Maven 镜像，先真实接线 wl-quality profile/检查器；npx 只免除业务仓库安装 Gate 依赖，不能免除扫描环境。

上述采用全量 standard，不依赖 MR。若增加增量，分别处理 push/MR/候选/定时场景、首次 push 全零 SHA 与浅克隆缺历史，head 与 checkout 相同。MR 专属变量只在实际 MR pipeline 使用。[GitLab 变量说明](https://docs.gitlab.com/ci/variables/predefined_variables/#predefined-variables-for-merge-request-pipelines)。

普通 include 锁 tag 用于复用，项目仍能覆盖/删除，不能作为不可绕过证明。[include 合并规则](https://docs.gitlab.com/ci/yaml/includes/#override-included-configuration-values)。硬门来自平台强制策略或独立受控晋级作业与受保护共享分支。

## 候选检查：无特权 Runner

```bash
wl-skills-gate promote --source "$SOURCE_BRANCH" --target "$TARGET_BRANCH" \
  --expect-policy-hash "$WL_APPROVED_POLICY_HASH" \
  --expect-rules-hash "$WL_APPROVED_RULES_HASH" \
  --prepare-command 'pnpm install --frozen-lockfile'
```

后端改为其真实依赖准备命令。输出在 quality-reports/promotion-<id>/：候选检查、unsigned 结果、promotion-record.json、candidate.bundle。失败也保留记录/报告。这个作业只能读源/目标，不更新共享分支；归档 bundle 供控制器导入。

## 独立 Review、签发和更新

1. 平台保存候选 SHA、源/目标 HEAD 与作业 ID；授权非作者 Reviewer 检查候选，逐项处理阻断问题。
2. Reviewer 受控作业生成 review-record（包含 source/target/sourceSha/targetBeforeSha/candidateSha/reviewerId/authorId/unresolvedBlocking），review-sign 使用独立 Reviewer 私钥签发，身份来自平台认证而非提交者参数。
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
  --out controller-audit
```

若有基线/例外，补其批准摘要。控制器在新 bare 仓库核验签名、Review、候选父提交、最新远端源/目标 HEAD，核验父提交后以批准的旧 HEAD 条件更新；不运行候选代码/项目 Hook。平台对同一目标分支串行化（例如 resource_group），配合保护分支和禁止普通写入；晚到候选需重新生成和 Review。

更新前先落审计记录，审计目录不可写则拒绝更新；所有尝试保留控制器审计。若更新已成功但最终审计写入失败，返回 `promoted-audit-failed` 和非零退出码；平台必须核对远端实际 HEAD 并补齐记录，不能当作未更新而盲目重试。临时 bare 仓库在失败和成功后均清理。

B2/B3 分支保护与服务端接收控制仍由管理员配置，不能用本地 Hook 宣称“服务端拒绝接收”。

## 首期台账与通知

B6/D1～D4 与样板同步建设：失败按项目/指纹幂等建单，分派主备，消息包含问题/报告/流水线认证链接，认领和复验回写主台账，定时升级无人认领/逾期。通知任务使用独立凭据并重试；通知失败不覆盖原门禁退出码。对账发现未运行或配置/权限漂移，不仅监听失败事件。

## 0.5.1 接线补充

有 baseline/waivers 文件时，检查、promote、attest、promote-apply、release/verify-artifact 各环节都传同一批准摘要；它们来自平台审批登记，而不是在候选里自行计算并批准。候选依赖准备结果保存 dependency-prepare.json（退出码、耗时、超时/截断、脱敏输出），promotion-record.preparation 引用日志；prepare 失败不丢失网络/仓库错误上下文。日志脱敏是辅助措施，仍须限制访问与保留期，禁止把凭据直接写进命令。

控制器使用 `--force-with-lease=refs/heads/<target>:<批准旧SHA>` 原子核对目标 HEAD，同时强制候选恰有批准的目标/源两个父提交，因此只允许批准旧 HEAD 的快进。此处不开放任意强推/回退功能。上线必须实测当前 GitLab 保护分支与受控账号接受这一条件更新，并保持禁止一般强推的保护策略；不能为了适配而放开任意强推。[Git push 显式 lease 语义](https://git-scm.com/docs/git-push)。

该条件更新保护目标分支；源分支最后核对与目标更新不是多引用原子事务。如果团队要求“更新瞬间源分支也必须最新”，由服务端接收校验、固定源引用或平台锁补充实现，不能将本地 HEAD 检查写成全局原子保证。

台账准入不得简单使用“项目只要有未关闭问题就禁止所有发布”。修复发布可凭绑定本次修复 SHA/范围的有效质量、Review 和回归证据，在授权范围内进入目标环境复验，再关闭；原事故的恢复与根因整改分开记录。具体准入参见 12 与落地执行附录 C。
