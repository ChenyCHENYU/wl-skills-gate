# wl-skills-gate 技术手册索引

当前版本 0.9.0；对照团队落地执行 V3.4。技术宣贯基线仍为 V3.1；团队具体操作单源见 [16 项目与运维入口](16-project-ci-integration.md)，本索引提供工具契约与参数参考。

授权声明见 [LICENSE](../LICENSE)；公开获取不授予使用、复制、修改或再分发授权，申请入口为 [仓库 Issues](https://github.com/ChenyCHENYU/wl-skills-gate/issues)。

状态分开登记：**共享实现已验证 / 项目已接入 / 平台已验收 / 业务闭环已验收**。每个状态须有自己的实际证据；以下手册不将本地自测、模板或签名通过标成生产接线完成。

| 手册 | 对应要求 | 内容 |
|---|---|---|
| [01 快速开始](01-quick-start.md) | A1/A3 | 安装、三档、退出码与只读试运行 |
| [02 配置](02-config.md) | 3.3/3.4/3.6、A1 | 策略、版本锁、基线、例外与中央底线 |
| [03 报告与证明](03-reports.md) | 4.2、A2/C3/C4 | unsigned 结果、受控签名、制品清单 |
| [04 修复](04-fix-loop.md) | 6.1/6.2、A7 | 文件防漂移、白名单、回滚与待复验 |
| [05 适配器](05-adapters.md) | 4.3、A4 | 七类输入、原生转换、JUnit 全集与同轮 producer、新鲜度/终轮防改、范围/版本 |
| [06 GitLab](06-gitlab.md) | B1～B6 | 只读检查、候选、独立 Review、受控更新 |
| [07 Jenkins](07-jenkins.md) | C1～C5 | 构建、签发、实际制品验证和部署 |
| [08 Hooks](08-hooks.md) | A13 | 与现有 Hook 合并、部分暂存边界 |
| [09 自测](09-selftest-coverage.md) | A6/E2 | 包测试与真实环境演练的区别 |
| [10 强制与权限](10-enforcement.md) | 1.2/12.6/B.4 | 防绕过、可信来源、密钥隔离与审计 |
| [11 首轮评审修复](11-hardening-review.md) | 0.5.0 历史记录 | 修复项、验证结果、兼容变化和未验证项 |
| [12 第二轮深入复核](12-closed-loop-review.md) | 0.5.1 与附录 C | 精准修复、覆盖与管理边界、隔离验证、下一步验收 |
| [13 质量成本与隔离](13-quality-cost-and-isolation.md) | 当前 0.7.0 / BD 0.41.0 | 规则分级、共享报告转换、三档执行、Java profile 拆分、预警与执行边界 |
| [14 低 token 执行](14-low-token-execution.md) | 执行附录 E | 确定性扫描、摘要与按需分页、本轮 Java 共享生产、原生只读游标、离线成本统计和 AI 使用边界 |
| [15 Java 原生报告分级与复核](15-java-report-triage.md) | Java scanner / 当前源码修订 | P3C与原引擎身份、成员指纹、Gate单源风险表、多模块sourceRoots、上下文复核和基线迁移 |
| [16 项目、流水线与治理入口](16-project-ci-integration.md) | 执行附录 G / V3.4 | 三层文档导航、正式操作单源、精选检查定位、前后端/CI/平台/台账/消息资产与验收边界 |
| [17 统一接入](17-onboarding.md) | 项目接入 | Gate 包内入口、前后端识别、计划确认与固定资产 |
| [18 可信 CI 采集](18-ci-source.md) | 运维事实 | 固定 API/Runner/作业、SHA/ref、必需检查与原始工件 |
| [19 九维 Review](19-nine-dimension-review.md) | Review与授权 | 自动草稿、逐维证据、固定摘要、独立身份授权和签发 |

## 首期闭环与配套位置

共享包承载检查事实和证据。中央模板/共享库承载流水线接线，平台受控作业承载权限。governance 提供签名 receipt、幂等中央串行台账/待发箱、主备认领/独立关闭、自然分钟 SLA 与预期运行对账；outbox/dispatch 默认不联网，dispatch 显式 --send 可推送飞书/企业微信群。配置/精确命令见 [平台模板](../templates/platform/README.md)。

GitLab/Jenkins 只读 API 查询已由 collect-ci 提供；实际来源配置、身份认证/稳定查看入口、长期存储与调度、群权限按正式操作手册实接；高级日历/应用回调按需适配。D5 对账覆盖没有 job/取消/无工件等缺执行；D6 使用认证网页或经授权应用回写主台账，D7 按需求服务化。群接口接受不等于认领，扫描消失只进入待复验。

## 常用入口

```bash
wl-skills-gate run --profile fast --scope staged
wl-skills-gate run --profile standard
wl-skills-gate doctor --kind frontend --root "$FRONTEND_ROOT" --out "$READINESS_OUT"
wl-skills-gate fix --plan quality-reports/quality-summary.json
wl-skills-gate fix --apply quality-reports/repair/fix-plan.json --confirm
wl-skills-gate validate-report quality-reports/quality-summary.json
wl-skills-gate inspect quality-reports/quality-summary.json
wl-skills-gate inspect quality-reports/quality-summary.json --view findings --status new --limit 10
wl-skills-gate cost archived-quality-runs --out cost-metrics.json
wl-skills-gate self-test
```

候选、签发和部署命令需完整受控参数，见 06/07；不要把其凭据注入上述检查或修复命令。

正式 standard/release 要绑定真实 SHA、release 目标环境和批准的四项摘要；完整命令见 06/07 与操作手册。doctor --out 必须在目标项目外，或省略用 stdout；它仅准备度，不执行项目命令或证明业务质量。governance receipt 只有在独立平台核验 API/SSO 后签发，不为项目自报字段背书；本轮消息仅mock/预览，真实群投递另验。
