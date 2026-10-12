# 03 报告、签名证明和制品清单

参数非法或输出目录覆盖源码/经项目内符号链接时，Gate 在新建安全临时目录保存 invalid 报告，位置见控制台及 summary.run.outDir。CI 除常规 quality-reports 归档外必须保留作业日志；拒绝路径不能回读工作区中的旧绿报告当作本次结果。

对应 4.2、A2/C3/C4。quality-summary.json 是本次事实快照，最新问题状态以主台账为准，不回改历史报告。

run 包含 project/profile/commitSha/eventId/targetEnv/startedAt/sourceBound/sourceDigest；policy 包含策略、规则、基线、例外摘要和 requiredCheckIds；checks 记录实际状态/必需性/版本；findings 记录指纹、风险、位置、发生明细和处置状态；decision 为 passed/blocked/invalid。

Java 显式共享生产时，checks[].production 保存本轮 eventId、producer、commandHash、reportHash、生产耗时与 reused；顶层 productions 记录本轮各组 commandRuns、status、选中成员与报告数。reused 仅指同轮其他消费者共用，不能当作上一轮报告复用。旧报告没有该字段表示生产次数不可获取。离线 cost 统计读取原工件，不改变历史状态，详见 [14](14-low-token-execution.md)。

生成后自动做 schema 校验。签发和部署还做语义核验：检查非空、无重复、必需项全部 ok、声明数一致、无失效检查和未处置强制问题。只有 JSON 结构合法不足以放行。

## 按需查看，不重新扫描

`inspect quality-reports/quality-summary.json` 默认输出有字节预算的 JSON 摘要，包含原结论、完整问题计数和检查状态。`--view findings` 才展开明细，支持 `--status`、`--severity`、`--rule` 精确过滤及 `--limit/--max-bytes/--cursor` 分页；查看下一页只读取已有报告。详见 [低 token 执行](14-low-token-execution.md)。

输出标记 `displayOnly: true`，只作阅读视图；原 JSON/原生 XML、签名、规则及源码证据继续完整归档。过滤后的零条问题仍保留整份报告的 blocked/invalid 结论与退出码。结构校验不认证来源，也不证明报告仍对应当前源码；不能将 inspect 作为流水线放行或问题关闭依据。

## unsigned 结果

run 产生 gate-attestation.json，kind=`unsigned-gate-result`，仅供定位和后续受控签发。该文件未认证，部署拒收。摘要用于关联，不表示可信来源。

## 受控证明

attest 在独立受控作业中将通过的 standard/release 报告签为 kind=`gate-proof`，Ed25519 签名覆盖规范化完整证明，包括项目、真实候选 SHA、档位、环境、事件、报告摘要、策略/规则、issuer/pipelineId/jobId 和时间。

签发前必须由平台查询确认输入来自批准的流水线模板/作业/Runner，源码、档位、工具和报告工件正确；包的离线命令不能替代这次平台查询。私钥不能进入运行作者代码的检查环境。

验证方固定公钥、issuer 和平台查询取得的 pipeline/job ID，并提供 SHA、项目、策略/规则摘要。baseline/waivers 有文件时另外提供批准摘要。缺参数、缺签名、错误身份、过期/未来时间、档位或环境不匹配均拒绝。

## 制品清单

```bash
wl-skills-gate manifest --project wl-ui-produce --env prd \
  --artifacts dist --configs deploy/runtime.json,deploy/migration.sql \
  --out quality-reports/artifact-manifest.json
```

artifacts/configs 为项目内相对路径（逗号分隔）。记录真实干净 HEAD、与门禁一致的 sourceDigest、环境、文件字节或完整目录内容及目录内文件模式。空目录、符号链接、越界路径拒绝。release 签名绑定整个 manifest 摘要，verify-artifact 再读取即将部署的真实内容重算。

构建后同一份制品进入验证和部署；重新构建、更换配置或制品需重新出清单/证明。验证后部署使用受控、不可被其他作业改写的工件。

## 平台报告

包导出 `code-quality/gl-code-quality-report.json` 供 GitLab codequality 消费。JUnit 由真实测试工具本次产出 XML，adapter 校验其结构/计数，再把原始 XML 配置为 GitLab/Jenkins 测试报告。多个 suite 文件需全部接入，不用一份 XML 代表全部测试。

## 明确保留的缺口

双仓 release-manifest 的前后端 SHA、契约、数据库变更、发布顺序和批准组合核验仍需平台实现；单仓签名证明不能替代。metrics、业务复核、待部署到现场生效的管理状态也由对应事实源提供。
