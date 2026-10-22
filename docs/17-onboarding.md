# 17 统一接入入口

首次接入和新工作副本统一使用`wl-quality init`。已接项目自动进入工作副本初始化；首次接入自动识别已支持PC Vue／Java Maven并展示差异。日常检查由Hook执行。交付包提供`01_接入项目.sh`／`.command`，自动安装本轮Gate和本类型配套，使用者不用选前后端安装命令。


`wl-gate` 与 `wl-skills-gate` 是同一个 Gate 包的两个命令名。接入脚本、Hook 调度器、IDE 操作和配置模板随 Gate 包一起交付；不再要求从文档目录挑脚本组装。团队按交付包根目录的完整或运维接入操作说明执行；本文供维护者排查程序契约。

## quality-tools 是什么

| 项目 | Gate 与规则包安装位置 | 业务编译 |
|---|---|---|
| PC Vue 管理端 | 根 `package.json` 固定 Gate、Kit、UI；复用既有 Husky、lint-staged、commitlint | 项目原有 pnpm 构建 |
| Java/Maven | `quality-tools/package.json` 固定 Gate、BD；脚本位于 `scripts/quality` | 原 Maven/Java 构建 |

**quality-tools 是 Java 仓库中的工具依赖目录。它不是独立产品、不是新的 npm 包，也不是另一个 Gate。** Java 依然使用 Maven；Node 负责调用 BD、聚合原生 Maven 报告、执行门禁、生成证据。

## 技术经理一次接入，开发者由 Hook 自动检查

负责人填写批准完整包的`现场参数.json`，运行根目录`01_接入项目.sh`（macOS可双击`.command`）。脚本调用`wl-quality init`，选择真实 Git 根和批准 HTTPS 安装源，查看文件、依赖、Hook 与固定安装 argv，确认当前阶段。脚本管理本阶段计划摘要，出现安装后的新差异再展示确认。已安装Gate的维护者也可使用包内`templates/launchers/setup.*`进入底层菜单。

| 入口 | 自动执行 | 成功反馈 |
|---|---|---|
| `setup project` | 预检→批准配置/依赖安装→原生规则/POM/锁→doctor→真实Hook首扫和提交说明正反验证 | `quality-reports/setup/<sessionId>/result.html`；阶段原件与执行回执可追溯 |
| `setup workspace` | 按已提交 `quality/workspace.json` 与依赖锁安装，恢复本机 Hook，实际验收 | `quality-reports/onboarding/workspace-execution.json`；不覆盖项目策略 |
| `setup branches` | 首次中央配置中自动生成六个目标分支来源、独立scope、Review和UAT信任；查看完整差异并确认，保留验证/候选来源 | 未修改远端权限；已有运行台账时拒绝覆盖，逐分支现场验收 |
| `setup central` | 中央配置、来源、身份、凭据存在性、旧状态及部署回流预检 | 逐项状态、责任人和下一步；预检不联网、不启动、不发送 |
| `setup jenkins` | 从已提交项目自动提取八项批准摘要，绑定仓库/分支/scope、固定包和Job，生成受控登记及统一调用入口 | 菜单7；不写业务项目，不改远端权限，不自动批准Review |
| `setup jenkins --verify` | 只读核对远端真实Pipeline script、分支和触发器，自动计算Job配置摘要 | 菜单8；接线核验不等于业务链路运行验收 |
| `setup release-input` | 核验固定来源原件、签名、摘要、兼容证据，确认后生成组合输入 | `configHash` / `inputHash` 与实际输入文件；不代替授权或签发 |

非交互入口默认只读。`setup project --root PATH --registry URL --preview --json` 可用于预检；项目首次写入由交互逐阶段批准，自动任务可继续使用下文底层 `onboard` 契约。

### 已接项目的新克隆

首次接入完成后，将生成的工作副本清单、依赖锁、Hook、脚本与 IDE 任务一并审阅提交。新成员在 VS Code/Cursor 中选择 **wl-quality:初始化本机质量环境**。缺少本地 Gate 时入口先展示清单固定版本和批准源，确认后获取引导工具；随后展示项目初始化计划，确认后安装与验收。不得重跑首次接入来覆盖已经批准的项目策略。

**wl-quality:打开项目检查接入状态** 在允许自动任务的受信工作区打开时执行，只读、不联网、不安装。IDE 的 Workspace Trust 与自动任务许可由用户环境控制；Git clone 自身不会执行仓库脚本。首次初始化成功后，日常仍由 Hook 自动检查。

### 已接项目升级

先提交已批准的配置、清单和受管脚本。同一项目接入任务展示固定依赖和已登记受管资产的升级差异，确认后继续；0.10.0旧脚本通过包内固定摘要识别。0.11标准预设经明确批准后补齐原生检查；后端替换已核对的旧生产命令，保留组织规则与必测，自定义生产器差异停止并提示。自定义policy、九维适用范围、必测与POM原文保留；未提交策略、自改脚本或未登记旧版先审阅适配。升级后审阅提交供新clone使用，不删文件绕过冲突。

默认新接前端还识别 `validate:deps` / `validate:steelmaking`：已存在时登记脚本摘要；精确拆出既有Node测试列表并生成批准计划，其余业务断言保留执行。未知复合语法不猜测拆分；Playwright仍登记为独立必需CI作业并保留JUnit原件。其他项目自有测试按实际格式适配，不套生产业务名。

Java完整扫描的固定离线分发、自动缓存和环境变量由运维一次准备，详见[适配器](05-adapters.md#012-原生检测接线)。未准备会明确阻断首扫，不输出零问题；Gate并不自动安装系统JDK/Maven。

### 运维与发布输入

GitLab/Jenkins模板用中央预装固定Gate调用`ci-prepare`，中央登记`quality/workspace.json`和依赖锁的真实字节摘要；按锁安装时关闭任意生命周期，必要准备仅用内置固定适配，不激活CI Hook。准备通过不等于质量检查通过。

Jenkins新接入由Gate安装服务器公共入口，无需新增仓库；运维只建一个fleet任务，其余公共任务与业务接线由包批量配置。使用受控`jenkins-bindings.json`与包内`jenkins-gate.groovy`，两个Job共用生成的薄入口，不复制检查/准入逻辑或逐项拼环境变量。仓库、目标分支、scope和可选模块policy分别绑定；八项摘要由菜单7从已提交文件生成。CHECK可先独立接通，未登记BUILD便不能构建；补全正式Review后才开放构建门禁。接线核验会发现漏Gate或错误触发，最终强制仍依赖受保护分支、固定中央来源和任务权限。

pnpm预检和安装同时禁用pnpmfile执行；发现项目或全局pnpmfile声明会停止，由工程工具维护者提供固定摘要、允许目录和幂等验证适配。`--ignore-scripts`本身不覆盖pnpmfile，[pnpm说明](https://pnpm.io/id/11.x/pnpmfile)可供维护者核对。

Jenkins新入口先`jenkins prepare`准备固定依赖，再由`jenkins admit`以checkout SHA选择当前正式Review并重查CI；`jenkins build`复核本轮准入及源码后执行批准构建。记录放本机quality-reports，不写只读中央原件。发布输入配置固定`reviewConfigFile`和组件`reviewPublicationDir`；组合及部署强制重验同候选Review签名、独立授权和原件。旧组合缺该证据需重新生成，不接受布尔批准。

中央输入队列（正式Review交付、部署回流）首次由运维在受控持久卷创建；运行中缺失视为异常并提醒，不能自动造空目录。普通warning当周期汇总，首次/持续采集故障与恢复通过同一可靠待发箱反馈；配置或台账本身不可用由独立监控兜底。

中央交互先询问配置目录及独立Review签发是否分机，默认分机，不读取独立私钥。只预检时使用 `setup central`；经批准启动时使用 `setup central --start --watch`，消息仍只预览。真实发送另加 `--send`，启动确认会明确显示发送范围。非交互启动要求 `--config-dir DIR --start --watch --confirm --plan-hash HASH`；分机时加 `--separate-review-signer`。服务以前台受控任务运行，SIGINT/SIGTERM 清理本任务启动的服务，不安装系统服务、不改GitLab/Jenkins权限或密钥、不启动独立签发。

发布负责人维护 `templates/platform/release-input-config.json` 的项目副本。`setup release-input --config FILE` 展示实际组件、SHA、作业和输出，确认后生成输入。非交互生成需 `--confirm --config-hash HASH --input-hash HASH`；原件变化会使旧确认失效。作者映射、兼容性结论、恢复方案仍由对应负责人批准。生成后的原件摘要在签发前再次复核。

- 默认计划将尚未配置的本地 `core.hooksPath` 指向生成的 `.githooks`；应用后生效。已有仓库内 Hook 路径直接复用，`.husky/_` 映射到用户 `.husky` 文件。既有Husky9转发器通过计划中独立、固定资产的激活阶段生成，不执行整个自定义prepare脚本；未知版本或路径明确阻断。
- 既有脚本与检查保留。发现旧 Hook 自动写源码或重复检查时列出迁移项；不会擅自删除或跳过。
- 依赖版本冲突默认拒写。批准固定工程依赖升级时，在预览和应用两次都添加 `--allow-dependency-updates`；原依赖类别保持。
- 计划、项目 HEAD、文件、模板、接入实现或选择变化后，旧摘要失效。冲突、路径越界、符号链接均拒写；写入有备份、独占锁与失败回滚。
- `--no-activate-hooks` 可显式只生成文件；此时不能登记自动检查已生效。预览与应用必须使用相同选项。

## 底层自动任务契约与阶段确认

交互向导自动调用以下同一底层契约；脚本集成者才需要管理摘要。

```bash
node "$GATE_ROOT/bin/wl-skills-gate.js" onboard --root "$PROJECT_ROOT" --complete --registry "$APPROVED_NPM_REGISTRY"
node "$GATE_ROOT/bin/wl-skills-gate.js" onboard --root "$PROJECT_ROOT" --complete --registry "$APPROVED_NPM_REGISTRY" --apply --plan-hash "$ONBOARD_PLAN_HASH" --confirm
```

首次尚未安装固定包时，无法提前知道它们的真实规则差异。确认首份计划后只完成本地配置与固定清单安装，结果为 `native-approval-required`；接入界面重新调用同一预览，显示实际 Kit/UI/BD 差异和新摘要，负责人确认后继续。BD 刚同步而 POM 模板首次出现时，以 `pom-approval-required` 展示完整 before/after，再确认同一入口。后续不需要技术经理拼装多个 update、Maven、版本查询或 Hook 命令。

原生包、项目文件、预览输出或工具版本变化都会使旧确认失效。复杂/冲突 POM 不自动猜合并；内置 PL 补丁仅新增缺失 profile，保留已有 profile，将核对过的三个测试类加入新的 unit profile。真实 Maven 继承、插件、测试和覆盖率必须由后续首扫证明。

省略 `--complete` 仍保留兼容的“只配置文件”模式；该模式不会安装或执行项目检查，结果不得登记接入完成。

## 自动识别有适用范围

已声明 Kit 的 PC Vue 或 `wl-ui-produce` 可自动选 PC 配套；未接 Kit 的 Vue 必须由技术经理明确选择 `--kind frontend`，不能仅因使用 Vue 就套用 PC 规范。移动 H5、UniApp、小程序、React 等不套此配套。Maven 与 Vue 同根时需要明确项目边界和 `--kind`。

内置 Java 配套是 `wl-produce-pl/wl-produce-pl-service` 的真实接线起点，含已核对的三类六例；它不代表整个后端业务覆盖。对其他 Java 项目，入口识别为 Maven，但拒绝套用 PL 的模块、测试和私有 settings。维护者从 `templates/onboarding` 提供经审阅的同结构项目配套，使用 `--asset-root` 指向其目录；全部资产字节仍绑定进计划。这样统一的是执行入口和证据契约，项目特有的模块/规则/业务必测由实际负责人确认。

## 如何验收

| 结果 | 含义 | 下一步 |
|---|---|---|
| `configuration-blocked` / 退出 2 | 同名策略、脚本、版本或路径冲突 | 负责人合并，重新预览 |
| `configuration-planned` / 退出 0 | 只读计划生成成功 | 确认实际文件、固定 argv、差异与摘要 |
| `configuration-applied` | 仅配置模式完成 | 不能据此登记检查已运行 |
| `native/pom/lock-approval-required` | 当前阶段完成，新实际差异需要审阅 | 界面同入口显示新计划，再确认 |
| `onboarding-execution-blocked` / 退出 2 | 安装、资产、锁、Hook 或扫描失败 | 看具体阶段/日志，处理后重新预览 |
| `local-readiness-blocked` / 退出 2 | doctor、旧 Hook 静默修复/重复检查等仍有缺项 | 修复具体差异，不能跳过 |
| `local-validated-awaiting-remote-acceptance` | fresh 首扫通过、正常提交说明通过、违规说明被 Gate 正常拦截 | 开始远端强制检查/Review/通知/部署验收 |

执行回执位于 `quality-reports/onboarding/executions/<runId>.json`；每次一份，不覆盖历史。`execution.json` 提供最近一次索引。每阶段保存批准摘要、固定 argv、实际退出码、原生包/预览摘要、POM/锁前后摘要和实际报告事件/文件摘要；敏感日志脱敏。执行锁阻止并发安装和修改。

依赖缺失、安装失败、原生预览漂移、POM 冲突、版本查询异常、零/失效测试、旧绿报告、Hook 在扫描后改源码、负例因执行器损坏而失败，都不能算接入通过。首扫通过后也只登记 `localValidated=true`；`remoteValidated` 和 `businessClosureValidated` 保持 false。

GitLab/Jenkins 权限、可信中央模板、候选/独立 Review、构建/部署、飞书通知及独立复验仍须在真实环境验收；完整接入入口不会代替这些权限或向远端发布。它实际运行批准的 Maven/业务检查，可能发现问题并阻断，不会为了展示成功而降低规则。

## 维护单源

- 交互入口：`lib/setup.js` / `lib/setup-modes.js`；底层首次接入：`lib/onboard.js` / `lib/onboard-config.js` / `lib/onboard-complete.js`；新克隆：`lib/workspace-init.js`；中央预检：`lib/setup-central.js`；发布输入：`lib/release-input.js`。
- 包内执行源：`lib/project-actions.js`负责Hook、报告及确认后的修复复扫；`lib/jenkins-integration.js`、`lib/jenkins-runtime.js`负责接线与执行。项目的`project-actions.mjs`只有固定版本加载逻辑。
- 包内交付源：`templates/onboarding/{frontend,backend,automation}`。`templates/scripts-quality/run.mjs` 与 schema 同包核验；规范目录中的历史配套不作为新接入的复制源。
- 接入只从当前固定包生成脚本与配置，不从其他文档目录复制样例实现。
- 本模块测试覆盖真实 Git Hook 拒绝、前后端位置、旧 Hook 复用、幂等、漂移拒绝、完整包独立交付；不把隔离测试计为业务项目或远端验收。

只读配置采集禁止pnpm隐式版本下载，兼容pnpm10/11；安装强制项目固定版本，版本不符在预览中阻断，由运维提供批准运行环境。registry scope与锁文件实际下载源均核验；项目内vendor tarball按字节摘要绑定，不把锁文件deprecation里的文档URL当下载源。


### 同一项目的多分支与UAT报告

首次中央接线在助手中选择“6 生成同项目六分支中央接线”，使用 `templates/platform/branch-setup.json` 项目副本；默认保留验证/候选来源，生成六个固定目标分支的来源、独立scope、Review/签发和发布信任。`additionalCollectorConfigFiles` 是同项目批准的额外采集器；治理scope、必需作业和人员映射分别校验。候选上下文不能移植到最终分支；普通MR源分支不能冒充合并结果，动态MR来源仍需另行可信接线。

Jenkins每条分支提供批准ref/jobPath/jobConfigHash，有上游作者关联还须给actorSourceRef。本节`setup branches`只生成首次分支配置，不创建作业、不改权限、不发送消息；作业批量配置由fleet完成，通知由中央任务发送。已有台账或锁明确拒绝首次配置，不能通过删账重跑。运行中配置变更按受审计迁移处理。

新模板把 `requireTechnicalManagerReview` 与技术经理人员标识同步（可用已登记账号，不强制工号）到治理、签发和发布信任；非作者经理确认，或经理为执行人时由已登记人员独立复核。确认人与执行人分别记录，群@不替代授权。UAT独立smoke成功后自动生成版本化HTML/JSON交付报告，记录固定Review/组合/真实验证及原件摘要；失败可单独续跑，篡改不可覆盖，不自动对客户发送。

### 飞书里的人员与详情按钮

普通提交的阻断通知 @提交人和技术经理，同一飞书人员只 @一次。技术经理本人提交时，仍保留本人署名，并同步 @李月；项目配置 `managerSubmissionNotify` 指向李月在 `people` 中的实名记录。经理本人提交即使没有阻断问题也同步她。这里配置的是通知对象，正式审核是否通过仍由真实审核记录决定；姓名和群消息不能代替审核或真实飞书 ID。

群内按钮应直接打开**本次报告**，使用固定作业/构建编号，不能链接到会变化的 latest 报告。底部集中 @责任人，说明修复、自动复扫、回归和反馈要求；提交人/技术经理同排展示姓名，同一飞书人员只 @一次。

新公共入口的CHECK在检查后的`finally`调用包内[报告发布脚本](../templates/ci/jenkins-quality-report.groovy)，不等待BUILD或部署；BUILD单独归档准入、构建结果与制品，不重复生成CHECK报告。旧发布模板的`post always`按各自契约保留。运维一次接好以下三项，检查任务自动归档、发布、验链接后再推送：

| 接线项 | 配好后的结果 |
|---|---|
| 安装当前固定Gate，在项目登记配置`reportArchiveRoot`与`reportReaderCredentialId` | 包自动选择固定发布脚本并绑定变量，业务候选不能替换；不用逐Job拼装发布步骤 |
| 预建工作区外的报告持久卷，启用 HTML Publisher | 包将登记目录绑定为`WL_QUALITY_REPORT_ARCHIVE_ROOT`；按项目、阶段、事件/SHA及内容摘要留存 HTML/JSON，复扫新增归档，历史报告不被覆盖 |
| 只读凭据 `wl-quality-report-reader` 与报告任务读取权限 | 发布后回查固定 HTTPS URL、HTML 类型及文件摘要；登录页、403、旧报告或篡改均不发送详情按钮 |

鉴权账号只用于查询，不作为所有构建的触发人。人工构建的实际触发人来自 Jenkins `UserIdCause`；提交作者、GitLab 合并申请作者和合并执行人分别关联本次 SHA 与真实记录。Git 作者姓名/邮箱只作为元数据，不能充当已认证责任身份；没有唯一身份时登记待核实，不能默认填鉴权账号。中央人员表再关联技术经理、飞书 ID；无需收集每位开发者的 Token。Jenkins配置批准的`actorSource`后，自动触发和手动重建都核验真实GitLab合并关联，点击构建的人单独保留在`triggerSource`；关联缺失时拒绝退回点击人。未配置上游关联的旧入口仍含触发人语义，不能作为源码作者的正式Review归属依据。

运维还须保留报告所依附的 Jenkins 构建记录；`keepAll` 不能保住被整次删除的构建，持久卷备份也不会自动修复已删除构建的旧 URL。报告任务记录与大体积业务制品分别制定保留策略。服务账号能打开只证明服务端可读，仍须用普通群成员账号验收报告读取权限、失败报告、定位与历史链接。Jenkins 返回的 URL / `BUILD_URL` / `JENKINS_URL` 应与批准 HTTPS 入口一致；不把内网 IP 链接直接推到群里。

仅归档产物不代表已经能在线浏览 HTML；GitLab 的 HTML 预览需启用 Pages 和访问控制。不要关闭全局 CSP 来解决样式或筛选问题，按 Jenkins 的受控资源域配置验收。发布失败保留原始检查结果和归档，登记执行异常，不能改成质量通过。

本机预览仅用于本机演示；正式群按钮须通过Jenkins固定报告链接和普通群成员权限验收。
