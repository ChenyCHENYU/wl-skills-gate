# 14 低 token 执行与按需阅读

2026-10-12 原稿，2026-10-13 按 Gate 0.7.0 源码更新；实际 registry 发布/消费另验，使用条件见 [LICENSE](../LICENSE)。本文与团队执行文档 V3.4 的附录 E/G 配套；正式接入步骤见 [16 操作入口](16-project-ci-integration.md)，外部体系文件不属于本 npm 包。扫描与阅读分开：完整事实用于门禁，少量相关证据用于人工/AI 诊断。

## 三类成本分开核算

| 环节 | 是否需要大模型 | 实际成本 |
|---|---|---|
| ESLint、类型/编译、Kit/UI/BD 扫描、Java 静态分析、测试 | 不需要；当前内置执行链没有模型 API 调用 | CPU、内存、I/O、Runner 时间；测试还需环境隔离 |
| 报告转换、门禁、指纹关联、固定消息模板、SLA 定时对账 | 不需要 | 共享确定性治理入口已实现；实际平台查询/身份/存储/渠道及调度待接线 |
| AI 读取报告、规则、源码，解释或修复 | 需要模型上下文 | 宿主输入/输出 token；缓存输入是否计费取决于实际服务 |
| 复杂业务判断、低置信度问题、Review | 按需要由人或 AI 辅助 | 相关上下文与人工时间，不能用 AI 判断替代原必需的独立 Review |

Gate 的 policy 可以执行项目自定义命令，平台须审查其是否引入模型服务；不能由共享包没有模型 SDK 推导所有项目命令都是零模型调用。Skill/MCP 安装不等于每次扫描调用模型；宿主加载工具声明、指令与工具输出仍可能占上下文。

## 现有优化与差异

| 实现 | 当前证据 | 边界 |
|---|---|---|
| Kit | 页面源码/配置/规则上下文指纹缓存；MCP resultCursor 读取原快照、UTF-8 预算 | 旧 offset 请求仍进入 CLI；只读快照不证明修改后的源码已复验 |
| UI | summary/compact-v2；MCP resultCursor 原快照与 UTF-8 预算；原生 changed-only | 旧数字 cursor/CLI 分页仍独立扫描；原生阅读视图不能作为 Gate 完整输入 |
| BD | 共用扫描上下文、Source Index 缓存、按规则读取；MCP 结果字节预算/短期游标；上下文文件/字节/估算 token 上限 | MCP 游标续读不重跑；存储有总量/时效上限。预算估算不等于真实计费 |
| Test | API/audit/report/用例生成的大结果默认紧凑，完整报文/用例保留工件 | TopN/摘要不等于统一字节硬上限；执行 API、E2E、性能测试有环境与 Runner 成本 |
| Design（可选） | 结构、引用、ID 与 Schema 的机械校验由 CLI 执行 | 设计语义与业务事实由人/AI 处理；不接入日常代码提交门禁，不因父目录存在而强制安装 |
| Gate | run 精简输出；inspect 摘要/分页；Java/XML 与 JUnit 同轮共享生产；cost 离线汇总；确定性台账/预览/对账 | 不复用跨轮放行；没有新增报告索引/成本服务；平台 API/SSO 与实际渠道另验 |

确定性检查优先，AI 只读命中的少量规则和问题所在函数、调用方或契约。工具失效先读实际诊断并交平台负责人，不启动反复全仓问答。问题不需要 AI 就直接用 IDE、报告定位和常规开发流程处理。

正常提交的 Hook/CI 根据脚本退出码结束，普通警告继续进入治理台账；不要求每次提交打开 AI 或调用 inspect。inspect 是有诊断需要时的阅读入口，预算不是新增开发者操作。

## inspect 使用

```bash
# 扫描一次，由实际运行决定是否放行；完整报告用 when: always 归档。
wl-skills-gate run --profile standard

# 查看已有报告：默认 summary，无 findings 明细，不扫描、不写入。
wl-skills-gate inspect quality-reports/quality-summary.json

# 新增问题先按等级/规则筛选；也可查 existing/waived/expired。
wl-skills-gate inspect quality-reports/quality-summary.json \
  --view findings --status new --severity error --limit 10 --max-bytes 6000
wl-skills-gate inspect quality-reports/quality-summary.json \
  --view findings --rule BD/B32 --limit 10

# 同一报告、同一筛选继续取 page.nextCursor；不会重新跑生产者。
wl-skills-gate inspect quality-reports/quality-summary.json \
  --view findings --status new --severity error --cursor "$REPORT_CURSOR" --max-bytes 6000
```

参数：view=summary/findings；status=all/new/existing/waived/expired；severity=all/blocker/error/warning/info；rule 为精确规则 ID；limit 默认 20、范围 1～100；max-bytes 默认 12,000、范围 4,096～65,536。输出为单行 JSON，预算按 UTF-8 计算，包含元数据与换行，不声称能精确限定模型 token。

摘要保留原判定、SHA/eventId、完整风险计数、检查状态计数及最多五个失效/慢检查。明细按阻断风险优先排列；长描述明确裁剪，保留原文件、规则、指纹定位；遗漏检查/原因有计数。`page.selectedTotal/returned/nextCursor` 说明筛选后总量和未读部分，完整总量仍在 totals。字节不足以容纳一条定位或必要元信息时明确失败，不输出看似完整的空页。

游标绑定报告字节摘要、筛选条件与位置；报告被覆盖或筛选变化须重取第一页。游标只是阅读定位，不是认证或签名。每页需要本地读取/解析完整工件，报告很大仍有 I/O 和解析成本，但不执行源文件扫描或测试。

inspect 返回原报告的 0=passed、1=blocked、2=invalid；参数/报告错误也为 2。过滤无命中不改变原结论。输出 `displayOnly: true`，不验证平台来源、签名或当前源码新鲜度，不能用于签发、部署或问题关闭；这些仍用完整报告和既有证明核验。摘要不得作为 raw-json/cmd-json 上游输入，AI 裁剪输出也不能替代完整原生报告。

## 避免重复工作的接线约束

- pre-commit 只跑已验收 fast；原有 lint-staged 与 Gate 同范围 ESLint 不同时各跑一次。平台审查后在现有 dispatcher 中明确唯一生产者，保留原覆盖；不在 Hook 启动 AI、全量 Maven 或集成/E2E。
- pre-push standard 是当前默认模板。实际耗时过高可由平台将完整 standard 前移到强制 CI，保留本地已批准的快速反馈；只有服务端必需检查真正接通后才能减少本地重复项。
- 每个作业同一生产者、输入、配置只运行一次供多个下游消费。java-xml 和 junit 可分别用显式 producer 合并本轮命令，同组 tool/command/timeout 一致；不跨工具混组、不删 command 回读旧 XML，不把版本查询次数算编译次数。
- 展示翻页用既有 Gate 工件或 Kit/UI 的 resultCursor；不循环使用原生 offset/数字 cursor 重跑扫描获取下一页。源码、范围、规则/插件/依赖锁或环境变化须重新检查；内容/AST 缓存不能冒充上一版放行结果。
- release 保持全量和必测。签名绑定候选、策略、环境与制品；不同 SHA 或复验不能借节流跳过。相同 fingerprint 的新发生数、风险升高、复发、工具失效和 SLA 超时仍及时告警。

## 预算与管理验收

无需新建成本服务。平台从现有作业和报告采集：各档 P50/P95、检查次数/重复率、输入文件数/缓存命中、报告及返回字节、阅读分页次数、AI 调用原因及可获取的实际 input/output/cached usage、误报与逃逸缺陷、人工处理时间。拿不到 usage 时标“不可获取”，用字节或估算值分析趋势，不填零、不当账单。

预算按项目/语言/Runner 试点批准；超预算先定位重复执行、无关上下文、日志洪水与慢规则。AI 辅助预算耗尽转人工或缩小上下文，不绕过质量门；Runner 超时为失效，不当无问题。普通警告汇总；问题状态变化和对账由脚本处理，不让 AI 每次重新总结所有历史告警。

当前共享验证覆盖输出预算、原生只读游标、Java/JUnit 同轮生产、成本汇总与治理/消息协议 mock；真实大项目性能、团队模型用量、跨作业传输以及 API/SSO/消息闭环待内网实测。不能由小夹具推导提交费用或全系统误报率。dispatch 默认仅预览，只有独立通知作业显式 --send 才联网，详见 [治理模板](../templates/platform/README.md)。

## Kit/UI 的原生阅读游标

Kit `wls_validate_page` 首次运行返回 `structuredContent.nextCursor`；下一页同工具传 resultCursor。UI `wl_ui_scan` 的 summary 返回 `response.nextResultCursor`，指向明细第一页；同工具传 resultCursor + output=compact-v2 续取。两者续取不运行检查、不遍历源码、不写新回执；原校验的完整事实仍用于实际检查记录，不以裁剪列表充当覆盖。

两者默认 maxBytes=12,000，范围 4,096～65,536；预算覆盖序列化处理结果，外层 MCP/JSON-RPC 和宿主元信息另计。缓存仅在同进程内存，固定五分钟、单份 8 MiB、总共 32 MiB、最多 16 份，按存入顺序淘汰。过大结果不缓存，未读项仍保留总数；读取 CLI 工件，不自动重复扫描。过期、越界、跨项目或 runId 不匹配明确失败；续取不能重设扫描条件。

阅读输出标记 displayOnly 和快照时间；改代码后的旧游标仍读历史事实，复验须重新扫描。旧 Kit offset、UI 数字 cursor/CLI 分页语义保持独立检查。Gate 现在拒绝 displayOnly、明确裁剪以及带未完成游标的原生/通用输入，防止阅读结果误作全量证据。原生字段由各自独立的 Kit/UI 包 `docs/result-reading.md` 维护，不包含在 Gate 包中，也不要求安装未使用的兄弟包。

## Java 静态与单元分别同轮生产一次

平台把 [Java 静态片段](../templates/quality/java-static-checks.yml)合并到批准 policy。Checkstyle/PMD/SpotBugs 配置相同 producer、组合 command/timeoutMs，各自保持不同 XML/风险规则；JUnit 用独立 producer 绑定 [单元计划/生产器](../templates/scripts-quality/java-unit.mjs)。同组 tool/命令/超时冲突、缺 command、重复路径在执行前拒绝。files/reportDirs 与 suite/必测详见 [05 适配器](05-adapters.md)。

本轮先预检全部输出范围，禁止清理源码/跟踪文件，再删除组内旧 XML 并执行一次命令。Java 静态要求 exit 0；JUnit 只有完整真实 failure/error 才可消费 exit 1。缺/未登记 XML、坏编码/结构/摘要、零用例、必测未成功、超时及不安全路径不能放行；异常不会为每个消费者重启生产。production/productions 记录 eventId/commitSha/sourceDigest、命令/报告摘要、耗时/次数。消费前及终轮核验内容，签发独立复核完整通过证据；下一轮重新生产，不缓存放行。

该能力收敛 Maven **生产命令调用次数**，不承诺每个插件内部不会重复进入编译生命周期。多模块可以对受控整仓组合命令登记全部实际子模块 XML，也可以按模块分组；均须核验子模块/源码范围与排除规则。不要用根 POM 或三份 XML 代替测试、业务必测和完整 release。跨 CI 作业传输/复用尚需平台来源与 SHA 验证，不由 producer 字段授权。

## 不调用模型的成本汇总

```bash
# 平台归档时间窗口内多个 quality-summary.json；不再次扫描或调用模型。
wl-skills-gate cost archived-quality-runs --out cost-metrics.json
# 可选：导入宿主/服务实际导出的用量，缺失就省略 --usage。
wl-skills-gate cost archived-quality-runs --usage host-usage.json --out cost-metrics.json
```

cost 递归读取同名工件，最多 12 层/5,000 份/单份 64 MiB；排除 node_modules/.git，拒绝符号链接、坏报告、空样本和相同 eventId 的冲突内容。相同事件的相同副本只计一次。按项目/档位汇总原 passed/blocked/invalid 数量、总耗时与各检查 P50/P95（nearest-rank）、实际时长样本数和共享生产命令次数。旧报告缺 productions 时缺失量显式记录，总生产次数为 null，observed 字段仅代表已知部分；不以未知当零。

sameInputAdditionalRuns 只统计具备源码/策略/规则摘要的相同输入候选，并比较项目、档位、范围、SHA、环境与基线/豁免摘要；可能是必要复验，不能据此跳过门禁。它不证明执行重复、跨环境等价或结果缓存可信。

usage 是非空记录数组，每条需要唯一 id、非空 source、非负安全整数 inputTokens/outputTokens，可选 cachedInputTokens（不超过 inputTokens）。例如：

```json
[{"id":"实际请求ID","source":"宿主导出来源","inputTokens":1000,"outputTokens":200,"cachedInputTokens":600}]
```

该示例只解释格式，不是本轮真实用量。缓存输入已包含在 inputTokens，totalTokens=inputTokens+outputTokens，不重复加缓存。缺缓存口径为 null；缺 usage 整体 status=unavailable、计数=null。提供的数据标 supplied-unverified：工具校验格式，不认证服务账单、货币成本或模型收费。统计输出为 displayOnly，只写 --out 工件并打印路径；平台按窗口自动执行并归档统计失败，不要求开发者填表，不把成本超限当作业务代码违规。
