# 07 Jenkins 构建、签发与部署

对应 C1～C5；命令代码已测，真实作业/权限/制品和双仓组合待验收。

## 作业拆分

- 检查/构建作业可执行项目源码，不能挂签发/部署凭据。
- 签发作业仅下载权威查询核验的报告和 manifest，在无项目代码的受控工作区执行固定版本 Gate；持有签发私钥。
- 部署作业固定公钥、目标环境、来源作业和批准策略，验证真实制品后部署；不重新构建。

先盘点 Jenkins 实际触发、脚本维护位置、作业修改/启动权限和凭据；受控共享库/配置版本化。不把作者可改 Jenkinsfile 当最终权限边界。

## 检查与构建

在确定 checkout HEAD、安装真实依赖之后：

```bash
wl-skills-gate run --profile release --sha "$CHECKED_SHA" --env "$TARGET_ENV" \
  --expect-policy-hash "$WL_APPROVED_POLICY_HASH" --expect-rules-hash "$WL_APPROVED_RULES_HASH"
# 在同一不可变源码/受控环境中执行真实构建，成功后：
wl-skills-gate manifest --project "$WL_PROJECT" --env "$TARGET_ENV" \
  --artifacts dist --out quality-reports/artifact-manifest.json
```

后端 artifacts 指向实际 JAR/制品；配置、迁移脚本按实际分发路径用 --configs 纳入清单。post always 归档报告和对应工件。多个环境重新构建时重新出清单/证明，旧证明不跨环境使用。

## 受控签发

平台先查询批准的具体质量/构建作业，核验模板/Runner/身份、真实 SHA、成功状态、工具/覆盖、工件完整性，再在独立签发工作区：

```bash
wl-skills-gate attest --summary evidence/quality-summary.json \
  --profile release --project "$WL_PROJECT" --sha "$CHECKED_SHA" --env "$TARGET_ENV" \
  --expect-policy-hash "$WL_APPROVED_POLICY_HASH" --expect-rules-hash "$WL_APPROVED_RULES_HASH" \
  --manifest evidence/artifact-manifest.json \
  --private-key "$WL_SIGNING_KEY_FILE" --issuer "$WL_GATE_ISSUER" \
  --pipeline-id "$WL_VERIFIED_PIPELINE_ID" --job-id "$WL_VERIFIED_JOB_ID" \
  --out evidence/signed-proof.json
```

有基线/例外时必须补其批准摘要。签名认证签发者和绑定内容，不能替代平台来源查询；issuer/jobId 字符串本身不是查询。这个查询连接需按真实 GitLab/Jenkins API、身份与授权实施，当前包不自动配置。

## 部署前验证

```bash
wl-skills-gate verify-artifact evidence/signed-proof.json \
  --summary evidence/quality-summary.json --project "$WL_PROJECT" \
  --sha "$CHECKED_SHA" --env "$TARGET_ENV" \
  --public-key "$WL_GATE_PUBLIC_KEY" --expect-issuer "$WL_GATE_ISSUER" \
  --expect-pipeline-id "$WL_VERIFIED_PIPELINE_ID" --expect-job-id "$WL_VERIFIED_JOB_ID" \
  --expect-policy-hash "$WL_APPROVED_POLICY_HASH" --expect-rules-hash "$WL_APPROVED_RULES_HASH" \
  --manifest evidence/artifact-manifest.json --artifact-root artifact-staging \
  --max-age-minutes 1440
```

artifact-staging 中保持 manifest 相对路径。任何非零退出停止 Deploy。固定公钥/期望值/来源 ID 从平台控制配置和查询取得，不接受作者上传的公钥、passed 字符串或自行计算的批准值。

验证后部署只读不可变工件，发布记录写入证明、制品、配置和实际环境。冒烟失败停止后续环境晋级、按恢复方案处理并建单；扫描或部署成功不自动关闭线上缺陷。

## 保留待接入

双仓 release-manifest 组合核验（前后端 SHA/契约/脚本/批准）、生产恢复演练、现场冒烟、紧急通道及事后补检仍须平台实现和留证，不能因为单仓 verify-artifact 通过而标为完成。
