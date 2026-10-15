# 18 可信 CI 采集

当前自动入口：`automation`负责真实发现、采集、对账与通知；`review-ci`自动汇总同候选九维原件并登记；`control serve`提供OIDC认证确认页面。具体中央参数与部署模板见[中央执行接线](../templates/platform/README.md)。以下CLI是维护/诊断接口，日常开发无需手工执行。

`collect-ci` 是包内的只读 API 适配器；不是 WebHook 转发器。由米传汇智和运维配置中央定时/事件触发作业。WebHook 只提供待查运行编号，状态、源码和报告以固定来源查询为准。接口依据 [GitLab Jobs API](https://docs.gitlab.com/api/jobs/)、[Pipelines API](https://docs.gitlab.com/api/pipelines/) 和 [Jenkins Remote API](https://www.jenkins.io/doc/book/using/remote-access-api/)。

## 一次配置

选择 `templates/platform/ci-source.gitlab.json` 或 `ci-source.jenkins.json`，填写实际项目、批准范围、固定 HTTPS origin、分支/ref、全部必需作业、证据作业与精确工件路径。配置放在受保护中央仓库，不能从业务候选读取。

GitLab 固定数字 projectId 和批准的 Runner 编号，查询指定 pipeline、分页取全部作业，再查询精确 job；不使用“分支最新成功工件”。所有必需作业不得 allow_failure。子流水线需要分别配置实际 pipeline；不能把桥接作业成功当成下游测试成功。Runner准入不等于模板不可被作者更改；实际强制模板/独立中央作业由运维配置和反向验收。

Jenkins 固定含文件夹的 jobPath 和批准 config.xml 的 SHA256，采集前后核对配置。配置正文不复制到报告，配置读取权限单独授权。逐构建使用 Git 插件 BuildData 的唯一实际 revision 和 branch；缺失、多 SCM 冲突或只有参数 SHA 均失败。一个配置对应一条实际 Jenkins 作业，多作业组合在受控发布作业逐项验证，不把任意一条成功当成整组通过。

工件路径使用明确文件，不用 glob 或目录。下载真实 HTML/JSON/XML/制品文件，保留字节和 SHA-256；制品目录可以由构建作业先生成不可变归档文件再纳入。Jenkins 路径必须实际存在于归档列表。

## 自动执行

中央触发器从实际作业/认证系统映射作者和运行编号，分配单调序号，生成请求文件。请求只允许以下四项，不能覆盖 URL、凭据、范围或状态：

```json
{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runId":123,"sequence":456,"authorId":"authenticated-employee-id"}
```

这些是示例值；不能拿示例 SHA、作者或序号签发实际证明。作者须对应源码提交者，不能直接使用流水线触发人的显示名。

```bash
node "$GATE_BIN" collect-ci --config "$CONTROLLED_SOURCE_CONFIG" \
  --request "$TRUSTED_RUN_REQUEST" --out "$NEW_CAPTURE_DIRECTORY"
```

仅使用环境变量中的只读凭据；HTTPS GET，禁止重定向，限制超时和大小。证据目录必须新建且不经过符号链接，失败不覆盖旧响应。输出 `source.json` 保存来源 JSON 原文、批准配置摘要、真实必需作业和下载工件摘要；`artifacts/` 保存原始字节。

全部必需作业成功返回 0，其余状态返回 2。取消/跳过/未执行不下载旧报告，也不生成质量通过事件。缺作业、错误 SHA、成功作业缺工件、超限、API不可用、采集期间变化均拒绝；实际失败作业缺制品时保留not-passed来源和missingArtifacts，不生成通过事件。中央finally/post always读取存在的来源生成失败通知并保留原退出码；无有效来源由对账登记未完成/执行异常，不能因set -e或采集失败就不入账。

配置了 `qualitySummary` 时，校验报告 schema、project、SHA、eventId、实际作业状态和全部必需作业；一致才输出**未签名**的 `quality-event.json`。该采集器不批准规则或 Review、不签发部署证明。中央隔离签发作业核对固定配置、范围与身份后调用 `governance receipt`，随后 `governance ingest`，复用已有签名、幂等台账、待复验和分类待发箱。

## 现场验收

米传汇智提供原始 API 响应、运行编号、全部必需作业和下载摘要；运维确认来源配置与凭据隔离、存储/调度。演练错误 SHA、删必需作业、allow_failure、取消、缺工件、报告篡改和机器人不可用。只有实际 Runner/API/原始工件的证据才能验收远端接线；包内模拟 HTTP 用于验证代码的拒绝行为。

SSO身份、分支保护、实际部署/冒烟、告警调度与恢复策略使用团队现有授权系统。采集器没有创建用户、修改权限或执行部署的能力。
