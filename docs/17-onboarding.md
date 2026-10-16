# 17 统一接入入口

`wl-gate` 与 `wl-skills-gate` 是同一个 Gate 包的两个命令名。接入脚本、Hook 调度器、IDE 操作和配置模板随 Gate 包一起交付；不再要求从文档目录挑脚本组装。本文介绍共享程序契约，团队按独立《接入操作手册》执行项目与远端验收。

## quality-tools 是什么

| 项目 | Gate 与规则包安装位置 | 业务编译 |
|---|---|---|
| PC Vue 管理端 | 根 `package.json` 固定 Gate、Kit、UI；复用既有 Husky、lint-staged、commitlint | 项目原有 pnpm 构建 |
| Java/Maven | `quality-tools/package.json` 固定 Gate、BD；脚本位于 `scripts/quality` | 原 Maven/Java 构建 |

**quality-tools 是 Java 仓库中的工具依赖目录。它不是独立产品、不是新的 npm 包，也不是另一个 Gate。** Java 依然使用 Maven；Node 负责调用 BD、聚合原生 Maven 报告、执行门禁、生成证据。

## 技术经理一次接入，开发者由 Hook 自动检查

负责人从批准的完整包打开 `templates/launchers/setup.command` / `setup.cmd` / `setup.sh`，选择任务即可。首次项目接入使用 `setup project` 交互向导：选择真实 Git 根和批准 HTTPS 安装源，查看文件、依赖、Hook 与固定安装 argv，确认当前阶段。脚本管理本阶段计划摘要，出现安装后的新差异再展示确认。

| 入口 | 自动执行 | 成功反馈 |
|---|---|---|
| `setup project` | 预检→批准配置/依赖安装→原生规则/POM/锁→doctor→真实Hook首扫和提交说明正反验证 | `quality-reports/setup/<sessionId>/result.html`；阶段原件与执行回执可追溯 |
| `setup workspace` | 按已提交 `quality/workspace.json` 与依赖锁安装，恢复本机 Hook，实际验收 | `quality-reports/onboarding/workspace-execution.json`；不覆盖项目策略 |
| `setup central` | 中央配置、来源、身份、凭据存在性、旧状态及部署回流预检 | 逐项状态、责任人和下一步；预检不联网、不启动、不发送 |
| `setup release-input` | 核验固定来源原件、签名、摘要、兼容证据，确认后生成组合输入 | `configHash` / `inputHash` 与实际输入文件；不代替授权或签发 |

非交互入口默认只读。`setup project --root PATH --registry URL --preview --json` 可用于预检；项目首次写入由交互逐阶段批准，自动任务可继续使用下文底层 `onboard` 契约。

### 已接项目的新克隆

首次接入完成后，将生成的工作副本清单、依赖锁、Hook、脚本与 IDE 任务一并审阅提交。新成员在 VS Code/Cursor 中选择 **wl-quality:初始化本机质量环境**。缺少本地 Gate 时入口先展示清单固定版本和批准源，确认后获取引导工具；随后展示项目初始化计划，确认后安装与验收。不得重跑首次接入来覆盖已经批准的项目策略。

**wl-quality:打开项目检查接入状态** 在允许自动任务的受信工作区打开时执行，只读、不联网、不安装。IDE 的 Workspace Trust 与自动任务许可由用户环境控制；Git clone 自身不会执行仓库脚本。首次初始化成功后，日常仍由 Hook 自动检查。

### 已接项目升级

先提交已批准的配置、清单和受管脚本。同一项目接入任务展示固定依赖和已登记受管资产的升级差异，确认后继续；0.10.0旧脚本通过包内固定摘要识别。自定义policy、九维适用范围、必测与POM原文保留；未提交策略、自改脚本或未登记旧版先审阅适配。升级后审阅提交供新clone使用，不删文件绕过冲突。

### 运维与发布输入

GitLab/Jenkins模板用中央预装固定Gate调用`ci-prepare`，中央登记`quality/workspace.json`和依赖锁的真实字节摘要；按锁安装时关闭任意生命周期，必要准备仅用内置固定适配，不激活CI Hook。准备通过不等于质量检查通过。

pnpm预检和安装同时禁用pnpmfile执行；发现项目或全局pnpmfile声明会停止，由工程工具维护者提供固定摘要、允许目录和幂等验证适配。`--ignore-scripts`本身不覆盖pnpmfile，[pnpm说明](https://pnpm.io/id/11.x/pnpmfile)可供维护者核对。

Jenkins在准备和构建前调用`verify-release-review --publication-dir`，以checkout SHA自动选最新正式Review并重查当前CI，记录放本机quality-reports，不写只读中央原件。发布输入配置固定`reviewConfigFile`和组件`reviewPublicationDir`；组合及部署强制重验同候选Review签名、独立授权和原件。旧组合缺该证据需重新生成，不接受布尔批准。

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
- 包内交付源：`templates/onboarding/{frontend,backend,automation}`。`templates/scripts-quality/run.mjs` 与 schema 同包核验。
- 文档目录旧 `automation/configure.mjs` 仅兼容转发；不得再次复制实现。文档配套文件是审阅用样例副本，维护时与包内交付源核对摘要。
- 本模块测试覆盖真实 Git Hook 拒绝、前后端位置、旧 Hook 复用、幂等、漂移拒绝、完整包独立交付；不把隔离测试计为业务项目或远端验收。

只读配置采集禁止pnpm隐式版本下载，兼容pnpm10/11；安装强制项目固定版本，版本不符在预览中阻断，由运维提供批准运行环境。registry scope与锁文件实际下载源均核验；项目内vendor tarball按字节摘要绑定，不把锁文件deprecation里的文档URL当下载源。
