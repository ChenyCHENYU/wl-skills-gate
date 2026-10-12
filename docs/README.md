# wl-skills-gate 操作手册

当前版本 0.6.0（安装需 registry 可用及对应访问权限）；对照落地执行文档 V3.2 主体、V3.3 附录 B/C 及隔离增补。

状态分开登记：**代码能力已验证 / 接线模板待验收 / 平台能力待建设**。以下手册描述包的能力和平台接线约束，不将本地自测标成生产落地。

| 手册 | 对应要求 | 内容 |
|---|---|---|
| [01 快速开始](01-quick-start.md) | A1/A3 | 安装、三档、退出码与只读试运行 |
| [02 配置](02-config.md) | 3.3/3.4/3.6、A1 | 策略、版本锁、基线、例外与中央底线 |
| [03 报告与证明](03-reports.md) | 4.2、A2/C3/C4 | unsigned 结果、受控签名、制品清单 |
| [04 修复](04-fix-loop.md) | 6.1/6.2、A7 | 文件防漂移、白名单、回滚与待复验 |
| [05 适配器](05-adapters.md) | 4.3、A4 | 七类输入、原生转换、报告新鲜度、范围与版本 |
| [06 GitLab](06-gitlab.md) | B1～B6 | 只读检查、候选、独立 Review、受控更新 |
| [07 Jenkins](07-jenkins.md) | C1～C5 | 构建、签发、实际制品验证和部署 |
| [08 Hooks](08-hooks.md) | A13 | 与现有 Hook 合并、部分暂存边界 |
| [09 自测](09-selftest-coverage.md) | A6/E2 | 包测试与真实环境演练的区别 |
| [10 强制与权限](10-enforcement.md) | 1.2/12.6/B.4 | 防绕过、可信来源、密钥隔离与审计 |
| [11 首轮评审修复](11-hardening-review.md) | 0.5.0 历史记录 | 修复项、验证结果、兼容变化和未验证项 |
| [12 第二轮深入复核](12-closed-loop-review.md) | 0.5.1 与附录 C | 精准修复、覆盖与管理边界、隔离验证、下一步验收 |
| [13 质量成本与隔离](13-quality-cost-and-isolation.md) | 当前 0.6.0 / BD 0.40.0 | 规则分级、共享报告转换、三档执行、Java profile 拆分、预警与执行边界 |
| [14 低 token 执行](14-low-token-execution.md) | 执行附录 E | 确定性扫描、摘要与按需分页、本轮 Java 共享生产、原生只读游标、离线成本统计和 AI 使用边界 |
| [15 Java 原生报告分级与复核](15-java-report-triage.md) | Java scanner / 当前源码修订 | P3C与原引擎身份、成员指纹、Gate单源风险表、多模块sourceRoots、上下文复核和基线迁移 |

## 首期闭环与配套位置

共享包承载检查事实和证据。中央模板/共享库承载流水线接线，平台受控作业承载权限。D1～D4 首期在独立治理任务中建设：GitLab Issues/既有缺陷系统作主台账，维护项目/模组→主备/复核/群映射，通知提供认证跳转，定时升级无人认领和逾期问题。

D5 对账首期至少覆盖样板必需检查的漏跑；覆盖扩面后再推广。D6 提供认领/复验入口，D7 后续按需求服务化。群消息送达不等于认领，扫描问题消失不等于业务关闭。

## 常用入口

```bash
wl-skills-gate run --profile fast --scope staged
wl-skills-gate run --profile standard
wl-skills-gate run --profile release --sha "$CHECKED_SHA" --env prd
wl-skills-gate fix --plan quality-reports/quality-summary.json
wl-skills-gate fix --apply quality-reports/repair/fix-plan.json --confirm
wl-skills-gate validate-report quality-reports/quality-summary.json
wl-skills-gate inspect quality-reports/quality-summary.json
wl-skills-gate inspect quality-reports/quality-summary.json --view findings --status new --limit 10
wl-skills-gate cost archived-quality-runs --out cost-metrics.json
wl-skills-gate self-test
```

候选、签发和部署命令需完整受控参数，见 06/07；不要把其凭据注入上述检查或修复命令。
