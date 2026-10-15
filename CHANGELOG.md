## [0.9.1] — 2026-10-15

- 重写 README：按实际能力梳理定位、接入步骤、使用场景与验证入口，完整细节保留在对应手册。
- 统一 World Leading 精密工业系列 Logo，提供深浅色版本并纳入 npm 发布内容。
- 接入固定依赖同步至 Kit 2.33.1、UI 1.22.1、BD 0.41.1，完整接入同时核对对应实际安装版本。

# 0.9.0 — 2026-10-15

- 修复接入环境与依赖准备、候选Review上下文和索引、删除/暂存区修复恢复、真实阻断与必要环境关闭、消息隔离。
- 补齐真实CI发现与可恢复调度、九维原件采集/补证/认证确认、授权前CI重新核验、OIDC处理页与投递恢复。
- 补齐独立签发、前后端组合与API/数据库/顺序约束、单次部署授权、实际冒烟和显式故障恢复。
- 重整README为接入、运行流程与文档入口，提供可复用的WL系列字标及Gate品牌资产。
- 本地源码和独立tgz分别验收；业务仓库、远端权限/群/SSO与真实业务必测仍以现场回执确认。

# 0.8.0 — 2026-10-15（本地交付候选，未发布）

- Gate 收入版本化前后端接入资产和 onboard，识别实际项目、显示完整差异并绑定确认；quality-tools 明确为后端私有 Node 依赖目录。
- 九维 Review 草稿、同口径修前修后对比、原始证据重算和逐维独立授权；正式签发及晋级强制要求 v2 记录，旧的仅身份/SHA批准不再放行。
- 固定 GitLab/Jenkins API 只读采集、真实 SHA/ref/全部必需作业与精确工件校验；拒绝 WebHook 自报成功、allow_failure、缺项、取消/跳过旧报告和采集中漂移。
- 飞书分类卡片、Review/构建/部署独立事实流共用签名台账与待发箱；构建成功、投递成功不会关闭质量问题。
- 文档明确包内实现、项目实接、远端权限/身份/存储与业务复验的验收责任；本地候选不代表 registry 发布或生产已接通。

# 0.7.0 — 2026-10-13（源码修订，未发布）

- JUnit 多模块明确 files/reportDirs/requiredSuites，报告全集、必测计数、生产一次和终轮摘要验证；拒绝旧 XML、源码覆盖、解析损坏与后续篡改。
- doctor 只读预检项目接线，Java 单测包装器明确模块/报告全集与依赖准备，补充前后端 GitLab 和 Jenkins 接线片段。
- governance 最小中央签名事件台账、独立复核关闭、漏跑对账、自然分钟 SLA、消息摘要/认证跳转、飞书签名与企业微信投递；默认预览。并发租约、未知投递和死信显式失败。
- 台账固定配置/公钥身份，动作和通知绑定当前 revision；拒绝过期卡片、输出路径别名与损坏台账。平台 API/SSO 查询、真实接线、服务和群投递仍须操作手册实测。
- 同步 V3 三份文档职责与精选 code-scan-kit 规则已正式集成的定位；无需 AI API。

# 0.6.1 — 2026-10-12

- npm 发布访问策略改为 public；公开获取与使用授权分开，保留 UNLICENSED，不授予开源许可。
- 新增独立 LICENSE：权利人为 AGILE TEAM，未经事先书面授权不得使用、复制、修改或再分发；授权申请通过仓库 Issues，不伪造或推定授权记录。
- LICENSE 明确纳入 npm 包；README、当前手册与模板版本锁同步 0.6.1。保留 0.6.0 历史记录和标签，不修改业务解析、风险分级或门禁裁决代码。

# 0.6.0 — 2026-10-12

- 汇总 0.5.2 源码修订：共享工程包报告转换、Java XML 本轮一次生产、只读分页 inspect 与离线 cost；保留原 CLI/模块能力和平台权限边界。
- Java 报告补齐 P3C/原引擎身份、原生优先级与成员签名；成员指纹防止同一行、同一说明的不同字段被合并。
- Gate 单源风险表新增三项安全/正确性底线；locale 显式预警和 SpotBugs 四类上下文复核保留发现，不自动排除整类。
- 严格 sourceRoots 支持多模块 main/test 实际文件定位；缺文件、歧义、符号链接和越界失败关闭。报告单独保留 parser 版本，未知外部工具版本不虚报验证。
- 自测使用包内实际版本生成临时 rules.lock，避免发布升版后夹具仍锁旧版本。更新安装/迁移/版本冻结文档，去除 standalone npm 包中的工作区兄弟路径链接。
- 发布准备保留现有 restricted/UNLICENSED 设置；包级与实际 tgz 自测可证明本地能力，不替代 registry、Git、平台权限与生产接线回执。

# 0.5.2 — 2026-10-11～12（源码修订，未发布）

- cmd-json 集中转换 Kit/UI/BD 原生完整 JSON，校验执行与覆盖证据、保留等级与质量底线；项目不再各自维护同类转换。
- captureStdout 以文件描述符接收大报告，防止生产者立即退出导致管道 JSON 截断；仍拒绝旧文件、超限及无证据的非零退出。
- java-xml 解析 Checkstyle/PMD/SpotBugs 原 XML，区分确定缺陷和治理提示；分析异常、依赖缺类、缺报告及生产失败返回 invalid。
- Java XML 补齐显式 format=p3c、producer/原引擎版本/原生优先级类别rank/主类和方法字段签名；稳定成员context避免同一generic说明合并不同字段。本地parser版本单独归档，不假装外部工具已核验。
- Gate 单源 Java 风险表保留原四底线，增加 HardCodedCryptoKey/InsecureCryptoIv/BrokenNullCheck 不可基线error；locale显式预警，SpotBugs四类表征/构造风险保留context-review warning及理由，不自动识别@Service并豁免整类。
- 新增严格java-xml sourceRoots，按明确多模块main/test源目录探测真实文件；不存在、同名歧义、符号链接和越界失败关闭。旧合成parser夹具补真实源码文件，未降低运行时校验。
- 同步当前接入文档：三档成本、Java 静态/单元/集成隔离、历史治理与预警；既有业务项目接入未自动升级，平台通知仍待验收。
- Java XML 新增显式 producer 本轮一次生产：清除同组全部旧文件、完整报告检查与消费前哈希核验；下一轮重新生产，失败/缺报告不重试伪装成功。
- 新增离线 cost：工件去重、项目/档位和检查分位耗时、生产次数及候选重复；可导入来源标明的宿主 usage，缺失不填零，缓存输入不重复计数。
- 阻止 displayOnly、裁剪和未完成分页结果回流为门禁输入。
- 增加只读 inspect：默认摘要、规则/等级/状态过滤、UTF-8 字节预算与绑定报告/筛选的分页游标；翻页只读工件，不重复扫描，过滤不改变原结论和全量计数。
- 明确确定性脚本、AI 上下文与 Runner 成本分别统计；完整报告留存、按需读取，重复检查/告警由共享接线收敛，不削减 release 必测。增加 7 项视图预算、分页、防漂移、只读与 CLI 回归验证。

# 0.5.1 — 2026-10-09

- ESLint 全量显式 targets/args；保存实际覆盖清单，拒绝空扫描、全忽略与增量漏文件，兼容中文/空格及物理路径别名；检查参数禁止修复模式。
- release 参数及证明核验均要求全量；已跟踪源码不因生成目录/报告排除而消失，报告目录防覆盖，路径与特殊文件失败关闭。
- 保留适配器执行失败的原诊断；受控检查提前要求基线/豁免批准摘要，promote 全链传递；依赖准备留脱敏诊断。
- 晋级以明确旧 HEAD 的 lease 拒绝最后时刻目标并发；仍核验候选父提交并只推进批准的快进。
- 修复符号链接/HEAD 漂移失败关闭；安全恢复后重新扫描并清空尝试 fixed 结果，不完整恢复要求人工处理。
- 93 单元 + 29 fixture + 17 集成通过；文档细化覆盖、漏跑、乱序/复发、恢复授权和修复发布准入。未发布 npm，真实平台接线仍待验收。

# 0.5.0 — 2026-10-08

- 将 unsigned 检查结果与独立 Ed25519 签发分离；强制核验项目、真实 SHA、档位、环境、批准摘要、公钥、签发身份、作业和时效。
- 新增 manifest，发布证明绑定真实制品/配置摘要；部署验证读取实际字节。
- promote 只生成候选和 bundle；promote-apply 以新 bare 仓库核验签名、非作者 Review、父提交与最新远端 HEAD 后更新。禁用旧 --push/--allow-any，失败也归档。
- 质量底线不可基线/豁免；合并取最高风险，基线风险/发生数增长重新阻断，增量不标历史问题消失，拒绝自批例外。
- JUnit 核验完整 XML、实际计数和必测，跳过/零用例阻断；清旧报告、修正非零退出契约，暂存/工作区不一致拒绝。
- 修复计划 v2 绑定文件/报告/策略/HEAD，忽略报告任意命令，白名单外变更/命令失败/回归回滚，扫描通过仅进入待复验。
- 新增 Code Quality 导出、共用 commit-message 验证；docs 随包发布，自测在临时目录执行，清理 fixture 生成报告。
- 同步真实权限边界和 0.4 迁移说明；D1～D4 明确首期，平台查询、通知和双仓组合仍保留待接入。

# Changelog

## 0.4.0（2026-10-08）

代码/逻辑/验证/报告四层全面闭环（平台接线与自动扫描脚本除外）：
- 新适配器：`cmd-json`（任意命令输出统一 findings，工程包/扫描器通用入口）、`junit`（失败/错误=error、跳过=warning、零用例=error，正文 3.5/5.6）、`sarif`（SARIF v2.x 映射）；共用 finding-input 解析，无胶水重复。
- eslint：`--base/--head` 增量（git diff 范围过滤）、`cache: true` 缓存参数；`command` 覆盖与 staged/增量范围同时出现直接 invalid。
- `verify-artifact` 子命令（正文 13.3 C3）：证明结论/SHA/受控哈希/reportDigest 防篡改/eventId 关联/时效/报告内阻断问题复核，任一不符 exit 2。
- `promote` 子命令（正文 5.2/13.2 B4 引擎件）：流向校验（dev-工号-模组→dev、相邻顺序晋级，跨级须 --allow-any 留痕）、临时 worktree 候选合并、候选上重跑门禁、目标 HEAD 并发复核、受控 push（非 force）、promotion-record 与候选证据归档。
- 报告新增自包含 `quality-report.html`（与 Markdown 同口径）。
- 验证闭环：新增 5 组 lib 单元测试（node:test）；`fix --apply` 集成用例（修复→复扫→closed→beforeArchive/changedFiles）；本地 bare 仓库集成测试 4 场景（晋级推进/违规拦截/流向拒绝/证据核对）；新适配器 fixture 25~27；self-test 全量 29 项。
- 修复：run.js 适配器注册表补齐三个新工具（缺失时误报 invalid）。

## 0.3.1（2026-10-07）

二次深挖闭环（回归缺陷 + 零消费者断点）：
- **修复 0.3.0 引入的回归**：模板 policy 移出 fast 档类型检查后 fast 变空 → pre-commit 必挂。模板/示例将 FE-ESLINT 恢复进 fast（配合 `--scope staged` 只查暂存区）；新增 fixture 24-fast-empty 固化"空档位即 invalid"语义（已实测复现回归并验证修复）。
- **schema 从摆设变契约**：新增 `validate-report` 子命令按 schema 校验报告结构；self-test driver 对每个 case 的 summary 执行 schema 校验，报告与 schema 漂移从此有回归（实测通过/篡改两路径）。
- attestation 补 `eventId`（成功与 failFast 两路径），证明与报告可关联。
- hooks 模板：缺少 `scripts/quality/run.mjs` 薄入口时给出复制指引并 exit 2（原为晦涩的 cannot open）。
- `--scope` 白名单校验（仅 staged），任意值不再静默无效。
- `enforceWarnings` 布尔强转，json 变体传字符串 "false" 不再被当 true。
- self-test 25 项全绿。

## 0.3.0（2026-10-07）

对照落地执行文档逐章核对后的冲突修复（A/B/C/D 四类 14 项，均附 fixture 或实证）：
- blocker 豁免默认拒绝（`blockerWaivers: reject`，正文 3.4）：命中有效豁免仍阻断并标记 `waiverRejected`（fixture 20）。
- `required: false` 必须登记 `naReason`（可选 `alternative`），缺失即 policy invalid（正文 3.6，fixture 17 强化）。
- 模板 policy：类型检查移出 fast 档（10s 预算，附录 B.2 #3）；新增 `commitTypes`、`releaseRequires`、`blockerWaivers` 键。
- 全零 `--base` SHA 拒绝（正文 13.2，fixture 21）。
- commit-msg 钩子类型白名单改读 policy `commitTypes`，缺省回落内置表（收敛"第四套白名单"口径分裂，已实测 wip/feat 两路径）。
- 新增 `--expect-policy-hash` / `--expect-rules-hash` 运行期摘要校验，不符即 invalid；docs/10 声明的"版本锁第三处咬合"落地（fixture 22 + 实测匹配/不匹配两路径）。
- release 档最低检查集 `releaseRequires`，缺任一即 invalid（正文 3.1"不能关闭的条件"，fixture 23 + 满足路径实测）。
- attestation 字段改名 `compareBaseSha/compareHeadSha`（消除与晋级语义的混淆），新增 expected/match 字段。
- baseline 元数据（`generatedAt/ruleSetVersion/fileDigest`）进报告（正文 3.3）。
- fix-report 新增 `changedFiles`（git status，排除门禁产物目录；已实测）；快照/自动回滚登记层级Ⅱ。
- summary 新增 `run.eventId`（正文 7.2 幂等入库键）；finding 新增可选 `suggestion`（正文 4.2 修复建议，已实测进 markdown）。
- 信任边界写入 docs/06/10：策略作者可执行任意命令，Runner 不得持特权凭据（正文 12.6）。
- self-test 24 项全绿；driver 支持 per-case `profile/args`。

## 0.2.0（2026-10-07）

自审修复（缺陷均有实证复现）：
- 指纹合并不再吞位置：同指纹多处命中保留 `occurrences` 行号清单，报告展示"行 10/20，共 2 处"；eslint 指纹改由 规则+文件+消息 决定。
- yaml-lite：重复键直接报错（防配置静默漂移）；未加引号值支持行内 `#` 注释截断，`src/#x.vue` 类值不受影响。
- 豁免记录按索引判定有效性，同 id（或同缺 id）记录不再连坐。
- eslint 适配器：配置 `command` 覆盖时禁止 `--scope staged`（语义不明确即 invalid）。
- fix --apply：复扫前把修复前 summary 归档为 `repair/summary-before-<planId>.json`；fix-report 新增 `failedCommands`。
- 薄入口模板：包未安装时给出安装指引并 exit 2（原为原始 MODULE_NOT_FOUND、exit 1）。
- self-test driver：FAIL 输出 stderr 尾部；支持 `occurrencesAtLeast` 断言；新增 fixture 13~19（未知工具/重复检查 id/缺 project/enforceWarnings/required=false 降级/多处命中/JSON 配置变体），共 20 项；fixture 产物加入 .gitignore。

## 0.1.0（2026-10-07）

- 首个骨架版本：run/collect/gate/fix 统一入口，三档 profile，统一退出码 0/1/2。
- 失败关闭：配置缺失、工具缺失、报告损坏/缺失/结构错误、finding 缺字段、超时均判 invalid。
- 稳定指纹（项目+规则+文件+结构特征）、有期限豁免、存量基线、到期回退、基线待复验移除。
- 伪造结论防护：输入结果的 decision/status/passed 字段一律忽略，按 findings 重算。
- 统一报告：quality-summary.json（schemaVersion=1 最小集）、quality-report.md、gate-attestation.json。
- 13 个 fixture 自测（self-test）覆盖通过/阻断/invalid/豁免/基线/伪造/修复计划。
- 模板：quality/ 配置、scripts/quality/run.mjs 薄入口、hooks（pre-commit/commit-msg/pre-push，含耗时打点）。
