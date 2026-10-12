# wl-skills-gate

统一质量门禁引擎，当前版本 **0.6.1**。对应《工程化与代码质量管控体系-落地执行（V3）》V3.2 主体、V3.3 附录 B/C 及质量成本与隔离增补；包配置为 npm 公开发布；公开获取不授予使用授权，使用前须取得 AGILE TEAM 事先书面授权，详见 [LICENSE](LICENSE)。发布流程核验版本与工件摘要。

包集中维护检查执行、结果归一、门禁裁决、修复计划和证据验证。项目引用固定版本；平台分别配置检查、Review、证明签发、分支更新、部署、台账与通知的权限。代码自测通过不代表内网接线已验收。

完整手册见 [docs/README.md](docs/README.md)，当前接入建议见 [质量分级、执行成本与测试隔离](docs/13-quality-cost-and-isolation.md) 和 [低 token 执行](docs/14-low-token-execution.md)。11/12 手册保留为历史验证记录，既有 test-qa 接入尚未自动升级。

日常目标是提前发现缺陷并减少返工：静态检查不修改业务源码，自动修复需独立明确执行；构建和测试在隔离 Runner 运行。新增缺陷与质量底线阻断，历史问题按审批治理，警告保留责任与时限。源码未变不代表没有外部系统副作用。

共享 `cmd-json` 已支持 Kit/UI/BD 原生 JSON 转换及文件描述符接收大报告；`java-xml` 统一解析 Checkstyle、PMD、P3C、SpotBugs，保留真实原生身份并由 Gate 单源风险表分级。七项 PMD 安全/正确性底线不可基线化；SpotBugs 表征泄露与构造期异常保留为需上下文复核的 warning，不自动豁免整类。多模块源定位须声明项目内 `sourceRoots`，缺失/歧义/符号链接拒绝，不能任取同名文件。详见 [Java 原生报告分级与复核](docs/15-java-report-triage.md)。项目无需各自维护这些解析脚本。类型、关键测试、权限/数据底线仍不能放进历史基线。

质量扫描默认由确定性脚本执行，包内没有大模型 API 调用。Hook、CI 裁决、报告归档和通知模板无需 AI；策略中的自定义命令仍须由平台审查。AI 阅读命令输出、规则和源码会消耗上下文，不能将“脚本没有调用模型”说成整个 AI 会话零 token。完整报告留作工件，AI 先用 `inspect` 看摘要，再按需分页读取问题；不因阅读分页重跑扫描。Java XML 可显式共用本轮一次生产；离线 cost 从既有工件汇总耗时，宿主实际 usage 不可获取时保持未知。Kit/UI 的 resultCursor 源码优化同步完成，业务安装态尚未升级。

## 能力与边界

| 能力 | 命令 | 当前边界 |
|---|---|---|
| 三档检查 | `run --profile fast/standard/release` | 退出码 0/1/2；失败也归档；release 要求真实干净 HEAD、合法环境、最低检查集与实际工具版本锁 |
| 报告 | `validate-report` | JSON/Markdown/HTML；Code Quality JSON 自动导出；JUnit 保留真实生产者 XML，不能拿转换后的计数替代原始测试报告 |
| 精简查询 | `inspect <quality-summary.json>` | 默认摘要；按规则/等级/状态分页；默认 12,000 UTF-8 字节上限；只读现有报告，保留原判定与全量计数，不能替代可信门禁证据 |
| 成本统计 | `cost <artifact-dir> --out <metrics.json>` | 离线汇总各档/各检查 P50/P95、共享生产次数、候选重复；真实 usage 可选导入，缺失保持未知，不调用模型 |
| 机械修复 | `fix --plan`、`fix --apply --confirm` | standard 全量报告；文件快照、白名单、防漂移、异常回滚、强制复扫；只进入待复验，不能自动关闭业务问题 |
| 候选检查 | `promote` | 在无特权 Runner 中合并、准备依赖、检查并归档 bundle；不更新共享分支 |
| 受控晋级 | `promote-apply` | 核验签名证明和独立 Review，在新 bare 仓库中核验最新远端 HEAD 后核验父提交后以批准的旧 HEAD 条件更新；不运行项目脚本或 Hook |
| 制品清单 | `manifest` | 绑定真实 HEAD、环境、实际文件/目录及可选配置、数据脚本摘要 |
| 证明签发 | `attest` | 受控独立作业签发 Ed25519 证明；仅签通过的 standard/release 证据 |
| Review 签发 | `review-sign` | 受控 Reviewer 作业，身份取自平台认证；非作者、候选绑定、阻断问题已处置 |
| 部署验证 | `verify-artifact` | 固定公钥、签发者和作业 ID、SHA、release 档、环境、策略/基线/例外、时效、真实制品摘要全部核验 |
| 自测 | `self-test`、`npm test` | self-test 只跑 29 个 fixture；npm test 额外跑单元与本地 Git/签名/制品集成 |

## 先只读试运行

取得事先书面授权并按授权范围使用后，可从公共 npm registry 安装固定版本：

```bash
# 公开获取不构成使用授权；先申请授权，再按其约定使用。
pnpm add -D --save-exact @agile-team/wl-skills-gate@0.6.1
# 按真实技术栈配置 quality/policy.yml 和 rules.lock.json；工具需实际安装。
pnpm exec wl-skills-gate run --profile standard
pnpm exec wl-skills-gate validate-report quality-reports/quality-summary.json
# 给人工/AI 查看现有报告，不再执行扫描；完整报告仍独立归档。
pnpm exec wl-skills-gate inspect quality-reports/quality-summary.json
pnpm exec wl-skills-gate inspect quality-reports/quality-summary.json --view findings --status new --limit 10
```

Gate 自身零依赖。前端仍需 ESLint/TypeScript 和工程检查器；后端 Runner 仍需 JDK/Maven/Node 与实际质量 profile。只有已安装且适用的规则包进入版本锁，不安装无关兄弟包。

退出码：0=passed；1=blocked；2=invalid。1/2 都停止后续晋级和部署，报告用 `when: always` 归档。无效证据不能当成“没有问题”。

## 0.5.x → 0.6 迁移

- 保留原 CLI、主模块和直接 lib 路径；Gate 仍可独立安装，扫描器和规则包按真实技术栈分别配置。
- P3C 使用 `format: p3c`；XML 的 PMD 引擎版本与 P3C 提供者版本分开记录，未提供的版本保持未知。
- SpotBugs 多模块配置显式 `sourceRoots`。未配置只兼容实际存在的单模块 `src/main/java`；缺失、歧义和符号链接定位返回 invalid。
- 成员身份进入 Java 指纹，旧成员基线可能需要重新审查。七项 PMD 底线不可基线/豁免；SpotBugs 四类上下文复核 warning 保留发现，不自动排除。
- `rules.lock.json` 的 Gate 版本须与实际安装版本一致；模板中的检查器版本占位值仍需替换为真实版本。

## 打包与版本冻结

使用 Node ≥20 执行 `npm test` 后运行 `npm pack --ignore-scripts --json --pack-destination <工件目录>`；对这个 tgz 独立安装、调用 CLI/自测并校验哈希，再提交和发布同一产物。`files` 包含所有运行模块、schema、模板、手册、fixture 与自测脚本，不依赖兄弟包源码。

npm 发布访问策略为 `public`，授权状态仍为 `UNLICENSED`。未经 AGILE TEAM 事先书面授权，不得使用、复制、修改或再分发；公开获取不等于使用授权。授权申请通过 [仓库 Issues](https://github.com/ChenyCHENYU/wl-skills-gate/issues)，完整条款见 [LICENSE](LICENSE)。源仓库为 [ChenyCHENYU/wl-skills-gate](https://github.com/ChenyCHENYU/wl-skills-gate)，默认分支 `main`；仓库推送与 npm 发布由发布流程分别核验。平台接线、真实权限、部署和群通知仍按下文单独验收。

## 0.4 → 0.5 迁移

- `promote --push`、`--allow-any` 禁用，更新分支改走隔离的 `promote-apply`。
- `run` 生成的是 `unsigned-gate-result`；部署拒收 unsigned。签发与检查使用不同凭据和执行环境。
- `verify-artifact` 必须提供固定公钥、受控期望、环境、清单与实际制品根目录，详见 [Jenkins](docs/07-jenkins.md)。
- `cmd-json` 默认成功退出码为 `[0]`；工具“发现问题返回 1”需显式登记 `[0,1]`，且报告有相应问题证据。
- 基线项增加 `severity`、`occurrenceCount`。blocker、类型/关键测试等质量底线不能基线化或豁免。
- 旧修复计划需重新生成。报告中的任意 `fixCommand` 不再执行；仅使用内置 ESLint 修复或政策登记的 fixer。
- 必需测试跳过、零用例、计数与明细不一致会阻断。部分暂存存在未暂存修改时，快检拒绝。

## 平台待接入能力

受保护分支、固定 CI/Runner、签发密钥与授权、平台作业来源查询、独立 Review、双仓发布组合、真实业务/UI/性能验证、台账与飞书/企业微信通知均需平台接线和实测。本包不自动创建这些权限或服务。

D1～D4（台账、责任路由、通知、SLA 升级）属于首期，与前后端样板同步验收。先证明一个真实问题从发现到复验关闭，再推广项目数量。
