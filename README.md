<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ChenyCHENYU/wl-skills-gate/v0.9.0/assets/wl-gate-logo-dark.svg" />
    <img src="https://raw.githubusercontent.com/ChenyCHENYU/wl-skills-gate/v0.9.0/assets/wl-gate-logo.svg" width="920" alt="WL Gate — Automated quality workflow" />
  </picture>
</p>

<p align="center">
  <strong>从提交检查到复验关闭的质量工程执行包</strong><br />
  自动接入 · 脚本修复与复扫 · 九维 Review · 构建发布门禁
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agile-team/wl-skills-gate"><img src="https://img.shields.io/npm/v/@agile-team/wl-skills-gate?color=0D9488&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-172B43" alt="Node.js 22.12 or later" />
  <img src="https://img.shields.io/badge/runtime_dependencies-0-0D9488" alt="Zero runtime dependencies" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-authorization_required-64748B" alt="Authorization required" /></a>
</p>

<p align="center">
  <a href="#三步接入"><strong>快速接入</strong></a> ·
  <a href="#接入后怎么运行">运行流程</a> ·
  <a href="#wl-系列怎么配合">包与目录</a> ·
  <a href="./templates/ci">CI 模板</a> ·
  <a href="./docs/README.md">完整文档</a> ·
  <a href="./CHANGELOG.md">更新记录</a>
</p>

---

## Gate 做什么

Gate 把项目检查器、Git Hook、CI、Review 与处置记录接成同一条流程。开发者正常提交代码即可触发检查，技术经理和运维统一维护规则、必测、权限与通知。

| 需要解决的事 | Gate 的处理方式 |
| --- | --- |
| 问题到构建时才暴露 | 提交、推送阶段自动检查；CI 再做完整核验 |
| 修复依赖反复问 AI | 先展示问题和修复计划，确认后执行批准脚本，自动复扫 |
| Review 只有一张扫描结果 | 汇总九维证据、代码差异和修前修后变化，由非作者逐维确认 |
| 构建成功就被当作闭环 | 分别记录检查、Review、构建、部署和复验；满足关闭条件才结项 |

**九维范围：** 提交 · 分支 · 编码 · UI 与交互 · Code Review · 测试 · 扫描门禁 · CI/CD · 工程治理。

## 三步接入

准备 **Node.js ≥22.12**，并使用项目固定的包管理器、检查器及 Java 工具链。以下命令由接入维护者执行一次；安装源可替换为团队批准的镜像。

**1. 预览。** 在实际 Git 项目上识别技术栈，查看文件差异、固定依赖、Hook、检查范围和阻断项。

```bash
npx --yes @agile-team/wl-skills-gate@0.9.0 onboard \
  --root /path/to/project --complete --registry https://registry.npmjs.org
```

**2. 确认执行。** 审核预览后，使用本次返回的 `planHash` 应用同一计划。

```bash
npx --yes @agile-team/wl-skills-gate@0.9.0 onboard \
  --root /path/to/project --complete --registry https://registry.npmjs.org \
  --apply --plan-hash "<本次 planHash>" --confirm
```

接入任务按计划安装依赖、同步适用规则、配置 Hook，并验证真实检查和报告。失败保留阶段回执，修正后续跑。

**3. 验证效果。** 查看首份报告及 Hook 正反例，再接入下表的 CI 与中央服务。日常提交、推送自动检查，开发者不用输入扫描命令。

| 项目 | 工具装在哪里 | 业务构建 |
| --- | --- | --- |
| PC Vue 前端，如 `wl-ui-produce` | 现有 `package.json` / `node_modules` | 沿用原前端构建 |
| Java/Maven 后端，如 `wl-produce` | 独立的 `quality-tools/` 目录 | 沿用 Maven，Node 工具不进入 jar |

内置后端配套针对 `wl-produce` PL 模块；其他 Maven 项目先批准自己的模块与必测配套。移动端、UniApp 不套用 PC 配套。完整步骤见 [项目接入](./docs/17-onboarding.md)。

## 接入后怎么运行

| 环节 | 自动执行 | 人员操作与结果 |
| --- | --- | --- |
| 提交 / 推送 | Hook 执行快速或标准检查，生成报告 | 有阻断先处理，保留项目已有提交约定 |
| 修复 / 复扫 | 按批准计划执行脚本，核对变更范围并复扫 | 确认后修复；查看新问题、剩余项与真实差异 |
| 九维 Review | 收集 Git、CI、测试及责任证据，生成待确认记录 | 非作者补充实际 UI / 影响 / 外部测试材料，再逐维确认 |
| 合并 / 发布 | 核验候选 SHA、正式 Review、制品、环境和发布组合 | 合并、部署和恢复分别授权；冒烟由独立验证人确认 |
| 通知 / 关闭 | 分类推送，漏跑与超时对账，失败重试并留证 | 主备认领，按必要环境复验后关闭；复发重新打开 |

**项目接入与远端接线分别验收。** 运维配置受保护分支、必需作业、固定 Runner 和独立凭据；中央服务连接真实 CI、SSO、证据存储与飞书群。可直接使用包内 [CI 模板](./templates/ci) 和 [中央配置](./templates/platform/README.md)。

检查退出码：`0` 通过、`1` 阻断、`2` 执行或证据无效。扫描通过、消息送达和人工补证都不会自动清除必需测试失败或批准发布。

## wl 系列怎么配合

| 名称 | 职责 |
| --- | --- |
| **Gate** | 统一接入、执行检查、裁决、修复复扫、证据与处置流程 |
| **Kit** | PC Vue 管理端编码与工程约定 |
| **UI** | PC 管理端 UI、样式与交互检查 |
| **BD** | Java 后端规范、规则资产及检查能力 |
| `quality-tools/` | Java 仓库的 Node 工具目录，里面安装 Gate / BD；不是另一个包 |

Gate 复用项目已有 ESLint、类型检查、Maven、JUnit 及适用规则包，统一报告与裁决。检查、修复、归档和通知由脚本执行，Gate 不调用大模型 API。按需查看报告可用 [`inspect`](./docs/14-low-token-execution.md)，无需重复扫描。

## 文档入口

| 要做什么 | 从这里开始 |
| --- | --- |
| 项目接入、Hook 与首扫 | [接入指南](./docs/17-onboarding.md) · [项目与运维集成](./docs/16-project-ci-integration.md) |
| 配置检查器、范围与等级 | [配置](./docs/02-config.md) · [适配器](./docs/05-adapters.md) · [Java 报告](./docs/15-java-report-triage.md) |
| CI、SSO、飞书与处置 | [可信 CI 来源](./docs/18-ci-source.md) · [中央接线](./templates/platform/README.md) |
| 九维证据与正式 Review | [Review 契约](./docs/19-nine-dimension-review.md) |
| 验证、升级与排障 | [完整索引](./docs/README.md) · [自测与环境验收](./docs/09-selftest-coverage.md) · [更新记录](./CHANGELOG.md) |

## 开发与授权

仓库验证使用 `npm test`，包含单元、规则场景及本地 Git / 签名 / 制品集成测试。发布前对固定 tgz 独立安装并复验。

[WL 系列标识](./assets/wl-mark.svg)与[品牌配色](./assets/brand-tokens.json)随包交付，后续 wl 包可复用同一字标并区分模块色。使用授权见 [LICENSE](./LICENSE)；npm 公开可下载不等于开源授权，授权申请通过[仓库 Issues](https://github.com/ChenyCHENYU/wl-skills-gate/issues)。
