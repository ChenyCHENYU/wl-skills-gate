# 13 质量分级、执行成本与测试隔离

适用源码：Gate 0.7.0、BD 0.41.0；2026-10-11 原稿，2026-10-12/13 补充执行与证据能力，实际 registry 发布另验。11/12 手册及既有 test-qa 报告保留为当时记录。本轮只修改共享包与体系文档，未向业务项目安装或升级资产。正式逐步接入统一见 [16 操作入口](16-project-ci-integration.md)。

## 目标和执行边界

质量工具提前发现问题、输出证据并支持治理。规则包放在开发依赖，Java 检查插件放在独立 Maven profile，测试依赖使用 test scope。业务运行代码不引用 Gate，不为满足检查自动改变接口、事务、DTO 可变性或现有组件技术。

静态扫描按源文件只读执行，允许在隔离的生成目录写报告。构建、单元测试、E2E 和 Maven 插件会执行代码，必须使用无生产凭据的受控 Runner。源码摘要相同只能证明检查未修改被纳入摘要的源码，不能证明没有网络、数据库或 MQ 副作用。测试选择规则也不能替代网络隔离。

## 三档执行及分级

| 档位 | 检查内容 | 管控方式 |
|---|---|---|
| fast | 前端 ESLint 暂存检查；后端选择已经支持的确定性静态检查 | 不启动应用、不连接外部系统、不执行自动修复；空扫须区分无适用变更和漏配置 |
| standard | 已验收的增量扫描；全量类型/编译、必要的跨文件规则和核心单元/架构测试 | 新增确定缺陷阻断；经审批的历史静态问题单独治理；警告进入责任台账 |
| release | 完整源码检查、构建、规定测试及独立集成/端到端验收证据 | Gate 禁止增量 release；不能以静态通过或单元测试代替业务验收 |

当前 ESLint 支持 Gate 的 staged/base/head。`cmd-json.format` 原生转换只接完整扫描：不支持上述范围或 quick/staged/changed/only/skip 裁剪参数，遇到这些组合返回 invalid。项目可让 fast 只运行 ESLint；原生检查另跑完整 standard，不能把全量命令写成增量已经实现。

`enforceWarnings: false` 表示 warning 不直接阻断，不会覆盖 Maven 自己的硬失败。存量 Java 项目采用独立的静态报告生产 profile，由 Gate 分级裁决；已验收严格规范的项目可保留严格 profile。不要同时启用两种模式。

| 结果类别 | 当前处理 | 例子 |
|---|---|---|
| 明确质量底线 | 阻断，不允许基线/豁免隐藏 | 类型、关键测试失败，权限/租户/危险数据操作，PMD CloseResource，SpotBugs 高/中置信度正确性和安全缺陷 |
| 普通静态错误 | 所有error阻断，历史基线和豁免不能放行；warning按批准指纹和发生数治理 | 现有工程包声明的普通 error；本轮没有统一降级其全部规则 |
| 风格、规模、复杂度及待核实风险 | 保留 warning、定位和原报告；按时限治理 | Java Checkstyle 规则、PMD 复杂度/维护性规则、SpotBugs 低置信度问题、未证明消费端的返回 DTO |
| 工具或证据失效 | invalid，分派平台/工具负责人 | 缺报告、旧报告、分析器异常、依赖缺类、partial、空扫、未知格式、超时 |

Java 映射单源维护在 Gate [java-risk-policy.js](../lib/java-risk-policy.js)：PMD 的 CloseResource、EmptyCatchBlock、OverrideBothEqualsAndHashcode、UseEqualsToCompareStrings、HardCodedCryptoKey、InsecureCryptoIv、BrokenNullCheck 为不可基线/豁免的 error；UseLocaleWithCaseConversions 为要求显式 Locale 的 warning。未知安全规则保留待审 warning 并禁止自动基线化。SpotBugs EI_EXPOSE_REP2/EI_EXPOSE_REP/MS_EXPOSE_REP/CT_CONSTRUCTOR_THROW 保留 context-review warning，必须审查实际成员/调用方/所有权；不读取@Service就自动忽略全类。其他 CORRECTNESS/SECURITY/MALICIOUS_CODE 且 priority 1/2 底线不变。人工批准 warning 的历史治理仍保留finding及成员身份；未批准时不得自动豁免。细节见 [15 Java 分级与复核](15-java-report-triage.md)。规则增加/升级后先用真实样本验证分类，再审批版本与适用表；不能把未知业务风险自动当作已解决。

BD B32：请求模型缺入口保留 error；返回模型未知 Java 消费端时为 warn。只有序列化用途无需增加 setter；存在 Java 消费端时验证实际 ObjectMapper/Feign 配置和契约测试。静态启发式并不能断言所有 Jackson 配置都失败。

## 工程包报告直接接入

Gate 复用 `cmd-json`，增加 `format: wl-kit/wl-ui/wl-bd`。读取实际 issues 与执行/覆盖证据，归一 `warn → warning`，保留原始等级、规则和文件定位；权限、数据等指定底线不允许历史基线吞掉。转换文件包含原始完整报告，不另造一套项目解析脚本。

```yaml
- id: BE-BD
  tool: cmd-json
  format: wl-bd
  profiles: [standard, release]
  command: node quality-tools/node_modules/@agile-team/wl-skills-bd/bin/wl-skills-bd.js validate --target . --json
  captureStdout: true
  file: quality-reports/native/bd.json
  okExitCodes: [0, 1]
  versionCommand: node quality-tools/node_modules/@agile-team/wl-skills-bd/bin/wl-skills-bd.js --version
```

Kit 使用 `wl-skills validate --json`，UI 使用 `wl-ui scan --project . --target src --output json --fail-on-error`，各自登记 format、完整目标、真实版本及项目适用性。CLI 路径按实际安装包确认，未使用的兄弟包无需安装。

`captureStdout: true` 让子进程 stdout 直接写文件描述符，避免大 JSON 在 CLI 立即退出时被管道截断。必须声明 file，命令不要再次使用同一个输出文件参数。报告启动前删除旧文件，输出大小、JSON、退出码和执行证据仍须校验；不使用 `|| true`。旧版本缺少完整覆盖/回执时返回 invalid，应升级生产者或明确保留其他已经验收的 adapter。

原生 CLI 会写自己的运行回执与缓存。接入时合并 [生成目录忽略片段](../templates/quality/generated.gitignore) 到现有 .gitignore，仅排除报告、runs 与指定生成缓存，规则/配置仍跟踪；不隐藏整个 .wl-skills* 目录。没有 Git 忽略或隔离输出时，新增回执/缓存会被 Gate 识别为检查中源码变化并拒绝。已跟踪文件即使位于上述生成目录仍纳入 Gate 摘要。

## Java 流水线拆分

BD 提供三个共享模板，均不改业务逻辑：

| profile | 用途 | 调用及输出 |
|---|---|---|
| wl-quality-audit | 存量项目静态报告生产，不绑定测试生命周期 | compile + checkstyle:checkstyle / pmd:pmd / spotbugs:spotbugs；原始 XML + Gate 分级 |
| wl-quality-unit | 独立单元/架构测试和覆盖率 | verify；Surefire 原 XML、JaCoCo、实际必测身份 |
| wl-quality | 已批准全套严格标准 | verify；保留原生 Checkstyle/PMD/SpotBugs/Spotless/覆盖率硬失败 |

Maven 模板由独立的 `@agile-team/wl-skills-bd` 包维护，位置为其 `files/.github/java-quality/maven-snippets/README.md`；该配套资产不包含在 Gate 的 npm 包中，未安装 BD 时按项目自身质量 profile 配置。同一调用只选一个 profile；审计作业没有测试证据。配置文件从 `${maven.multiModuleProjectDirectory}/.github/java-quality` 读取；从仓库根运行，包装命令应显式绑定此根目录。每个实际 Java 子模块单独登记，纯聚合 POM 不当作已经分析的业务模块。

```yaml
- id: BE-PMD
  tool: java-xml
  format: pmd
  profiles: [standard, release]
  command: mvn -B -ntp -Pwl-quality-audit compile pmd:pmd
  file: target/pmd.xml
  versionCommand: mvn -version
```

上面单项命令示例仍可用。需要三类静态检查时优先使用 [共享生产片段](../templates/quality/java-static-checks.yml)：各项保持完整 command，增加相同 producer，一轮仅执行一次组合生产；缺任一新 XML、失败或内容漂移仍 invalid。见 [14 执行细节](14-low-token-execution.md)。

Checkstyle 使用 format=checkstyle、目标 checkstyle:checkstyle、文件 target/checkstyle-result.xml；SpotBugs 使用 format=spotbugs、目标 spotbugs:spotbugs、文件 target/spotbugsXml.xml。子模块使用实际 `-pl`/`-am` 和 `<module>/target/...` 路径，逐个验收，不能只拿根模块的一份报告代表全仓。

SpotBugs 的包内 sourcepath 须配合同一检查的真实 sourceRoots，例如 wl-produce 的 PL service 是 `wl-produce-pl/wl-produce-pl-service/src/main/java`，不是简写 pl/src。数组只声明实际存在的项目内相对目录，test 根存在才加入；不能绝对路径、`..`、符号链接或模糊全仓搜索。同名存在多处按报告所属模块/源集拆开，定位不唯一或不存在返回 invalid。默认仅 src/main/java，不推测模块前缀。P3C 用 format=p3c，PMD 6 引擎与 P3C 插件版本分开归档；与 PMD 7 不同调用/输出，防默认 target/pmd.xml 互相覆盖。Java finding 验证真实普通源文件，空 Checkstyle/PMD 仍不证明完整覆盖。

静态生产命令必须 exit 0；出现编译失败、分析异常或缺失依赖时返回 invalid，即使残留报告有 findings 也不放行。原报告与 policy、插件 POM/配置、源码摘要一起归档。`versionCommand: mvn -version` 只证明 Maven 版本；插件版本仍由受控 POM/配置和运行日志核验，不能称为逐一动态核实插件版本。

Checkstyle/PMD 的正常报告可能只列违规文件，空 findings 不表示所有源文件都已扫描。必须对账适用子模块、编译源码范围与实际日志，不能仅凭 XML 推断完整覆盖；SpotBugs 则核验实际分析类数与缺陷汇总，不接受零类空扫。插件配置排除、上游非底线豁免也须进入批准的适用表，不能绕过范围治理。

JUnit 已支持 files/reportDirs 的全部明确原始 XML、必需 suite/用例和同轮共享 producer；逐份解析真实 testcase，不用手填计数。缺/多报告、重复身份、坏结构/摘要、零用例与 skipped 均不能放行，签发独立核验；具体见 [05 适配契约](05-adapters.md)。单元模板依赖准备与测试模块分开，不对全部 -am 依赖模块启用 unit 后全局关闭零测试失败。独立集成环境、跨作业/双仓组合仍由平台接入，静态示例不等于完整 release policy。

## 测试选择与隔离

单元模板仅选择 `*UnitTest`、`unit/` 下 `*Test` 及 `LayerRulesTest`，同时排除 Flow、Integration、IT、integration/、mq/ 集合，并拒绝零测试。已有 `ServiceTest`/`ControllerTest`、JUnit 4 或其他命名需要先核实内容/引擎、登记为单元或集成，再逐项纳入批准集合。模板未选中的测试标记“未归类/待验收”，不能称为全部测试已通过。ArchUnit 有用例也不能替代核心业务必测清单。

外部集成测试只在独立作业启用：临时数据库/Broker 或独立 namespace/vhost、独立队列、测试凭据、禁止访问共享/生产网络、限定超时、可追踪测试数据及清理。MQ 测试不能在共享队列发布或自动确认不属于本次测试的消息；需要专用队列/关联标识和明确 ack 策略。`@Ignore`/skip 是未执行，不是问题关闭。Release 必需的集成证据缺失时停止发布。

即使文件名叫 UnitTest，也可能调用外部系统；接入时人工审查依赖，Runner 禁止出网/不给共享系统凭据才是执行边界。源码中的连接地址和口令不得进入报告或群消息。

## 监督闭环与成本预算

预警按 project + rule + fingerprint 关联问题台账，eventId 记录每次运行。群消息只推新增阻断、工具失效、复发、无人认领/逾期及复验结果；普通风格警告默认汇总成日报，避免每次扫描重复轰炸。消息包含等级、主备责任人、截止时间和认证的“查看证据/认领/申请复验”链接。

警告按项目批准时限治理；认领不等于修复，扫描消失仅进入待复验。核验目标 SHA、必测、部署/观察证据及非作者复核后关闭；增量扫描不能关闭未扫描范围中的问题。0.7.0 已提供签名平台 receipt、串行持久台账/outbox、动作与自然分钟 SLA/预期运行对账，dispatch 默认预览、不联网，显式 --send 支持飞书/企业微信群实际投递。平台 API/SSO、认证网页、群权限、长期存储/调度仍须实接；当前不自带应用卡片回调、@个人或工作日历。见 [中央治理模板](../templates/platform/README.md)。本轮仅 mock/预览，没有真实发送。

记录各档 P50/P95 用时、误报/争议率、重复告警、每次人工维护时间及逃逸缺陷；先积累样板数据，再由团队批准预算和升档条件。慢检查移到 CI 或夜间治理，不靠跳过必需检查提速。团队日常只保留现有开发命令和一条质量入口，报告转换、分类、规则升级和台账路由由平台维护。基线需审批，禁止首次接入时自动把全部错误写入基线。

脚本扫描、门禁计算和台账通知默认不调用模型；AI 的规则阅读、诊断和修复另行统计上下文与实际 usage。完整工件不默认进入 AI，使用 Gate `inspect` 摘要及按需分页。具体能力差异、重复执行收敛和预算口径见 [14 低 token 执行](14-low-token-execution.md)。

## 本轮验收

包测试验证原生大 JSON 完整接收、风险级别、partial/坏报告失败关闭、Java 确定缺陷与预警分级、三种 Gate 决策。Java 8 临时 Maven 工程验证单元测试实际运行、外部/未归类测试哨兵不运行、覆盖率与严格质量门；还在未运行夹具方法的情况下真实检出 PMD 资源泄漏与 SpotBugs 隐藏空指针，并由 Gate 解析原 XML 为不可基线的 error；真实结果与限制以本轮验证记录为准。

2026-10-11～12 接入调研记录（历史）：当时仅对业务目录作只读参考。两个 test-qa worktree 与原后端项目的 HEAD、Git 状态及文件摘要前后一致；原前端目录快照出现额外文件及状态变化，已单独登记，本轮未向该目录写入或回滚。模板未安装进业务仓库，未发布 npm、发群消息、推进真实分支或部署。下一步是平台维护者按本文审查具体接入差异，并在独立 Runner 验收真实依赖、必测集合与消息台账。
