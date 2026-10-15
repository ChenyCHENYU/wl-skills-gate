<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ChenyCHENYU/wl-skills-gate/main/assets/wl-gate-logo-dark.svg" />
    <img src="https://raw.githubusercontent.com/ChenyCHENYU/wl-skills-gate/main/assets/wl-gate-logo.svg" width="100%" alt="WL skills-gate · World Leading · Quality Automation" />
  </picture>
</p>

<p align="center"><strong>让项目检查、修复复扫、九维 Review 与构建发布接成一条可验证的质量流程。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agile-team/wl-skills-gate"><img src="https://img.shields.io/npm/v/@agile-team/wl-skills-gate?color=087A7D&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-172634" alt="Node.js 22.12 or later" />
  <img src="https://img.shields.io/badge/runtime_dependencies-0-087A7D" alt="Zero runtime dependencies" />
</p>

<p align="center">
  <a href="#快速接入">快速接入</a> · <a href="#日常怎么用">日常流程</a> · <a href="#流水线怎么接">流水线接线</a> · <a href="./docs/README.md">技术手册</a>
</p>

## 解决什么

Gate 是质量执行与裁决层，复用项目已有检查器和适用的 WL 规则包。检查、报告、机械修复、复扫和通知由脚本执行，不调用大模型 API。

| 场景 | Gate 提供什么 | 能看到什么 |
| --- | --- | --- |
| 日常提交 | Hook 自动运行分档检查 | 问题位置、规则、修复建议与阻断原因 |
| 问题整改 | 预览方案 → 本人确认 → 白名单脚本 → 复扫 | 修前修后变化、剩余问题与回归项 |
| Code Review | 汇总九维证据，生成待确认草稿 | 非作者逐维确认后的正式 Review |
| 合并与发布 | 核验候选 SHA、必需检查、Review、制品和目标环境 | 绑定本次代码与制品的放行或拒绝结果 |
| 问题跟进 | 分类通知、认领、超时对账、独立复验 | 可追溯的处理与关闭记录 |

**九维范围：** 提交 · 分支 · 编码 · UI 与交互 · Code Review · 测试 · 扫描门禁 · CI/CD · 工程治理。

## 快速接入

技术经理拿到批准的 Gate 完整包后，打开 `templates/launchers/setup.command`（macOS）、`setup.cmd`（Windows）或 `setup.sh`（Linux），按菜单选择任务。先提供 Node.js ≥22.12、项目固定的包管理器及原有构建工具。

| 任务 | 人只需做什么 | 脚本完成什么 |
| --- | --- | --- |
| 首次接入项目 | 选择 Git 项目根、批准安装源，确认各阶段差异 | 识别范围、安装固定依赖、同步规则、Hook、POM/锁、首扫及提交说明正反验证 |
| 新成员初始化 | 选择已接项目，在安装与激活计划上确认 | 按仓库已提交清单恢复本机环境，保留项目策略，再验真实 Hook |
| 运维接线 | 选择批准配置目录，预检后选择启动 | 核对配置/身份/凭据存在性/旧状态，启动中央采集与操作入口；消息默认预览 |
| 组合发布输入 | 选择批准配置，确认组件与输出 | 从真实采集原件生成输入，核验来源、SHA、制品与兼容证据 |

也可用一个命令启动相同交互流程；进入后无需复制计划摘要或拼接后续命令：

```bash
npx --yes --ignore-scripts --registry https://registry.npmjs.org/ \
  --@agile-team:registry=https://registry.npmjs.org/ \
  @agile-team/wl-skills-gate@0.10.0 setup project
```

| 项目 | 依赖装在哪里 | 业务构建 |
| --- | --- | --- |
| PC Vue 管理端，如 `wl-ui-produce` | 根 `package.json`：Gate / Kit / UI | 保留原前端构建 |
| Java/Maven，如 `wl-produce` | `quality-tools/package.json`：Gate / BD | Maven；Node 工具不进入 jar |

`quality-tools/` 是 Java 仓库内的 Node 工具依赖目录。内置后端配套针对 `wl-produce` PL；其他 Maven 项目先由负责人配置模块与必测。移动端、UniApp 不套用 PC 配套。

首次接入反馈在 `quality-reports/setup/<sessionId>/result.html`，质量报告在 `quality-reports/quality-report.html`。只有真实首扫及 Hook 正反验证通过，才返回 `local-validated-awaiting-remote-acceptance`。GitLab/Jenkins 强制检查、独立 Review、真实到群及部署另做现场验收。

接线配置、非交互任务参数与失败处理见 [接入指南](./docs/17-onboarding.md)。

## 日常怎么用

开发者正常提交、推送；Hook 自动检查。以 `wl-ui-produce` 修改订单列表为例：

| 步骤 | 开发者 / 负责人做什么 | 系统给出什么 |
| --- | --- | --- |
| 提交前 | 按原流程暂存、提交代码 | 快速检查；有阻断显示具体位置和建议 |
| 推送前 | 正常推送 | 标准检查、HTML 报告；已配置 Review 策略时自动生成九维草稿 |
| 处理问题 | 在已生成的编辑器任务中选择“预览脚本修复”，核对并确认 | 执行批准的机械脚本、自动复扫，展示差异；语义问题保留人工处理 |
| 发起 Review | 非作者查看代码、补齐实际交互与业务证据、逐维确认 | 绑定当前候选与证据的正式 Review |
| 构建发布 | 通过受控流水线推进 | 核验本次候选、检查和制品；部署后独立复验再关闭问题 |

同口径的修前修后报告才展示质量变化。扫描通过、Review 确认、发布授权和问题关闭分别核验；一项通过不会代替其余步骤。

## 流水线怎么接

由 GitLab / Jenkins 维护者接线，项目负责人确认规则与必测，通知负责人配置群与分类。执行模板都在本包中。

| 接线内容 | 入口 | 验证方式 |
| --- | --- | --- |
| GitLab MR、候选与受保护分支 | [CI 模板](./templates/ci) · [GitLab 指南](./docs/06-gitlab.md) | 违规候选不能合并，真实必需作业齐全 |
| Jenkins 构建、制品与部署 | [Jenkins 指南](./docs/07-jenkins.md) | SHA、制品摘要、目标环境一致，缺证据拒绝推进 |
| 真实 CI 证据、身份与 Review | [可信 CI 采集](./docs/18-ci-source.md) · [九维 Review](./docs/19-nine-dimension-review.md) | 旧报告、缺证据、自审与过期批准被拒绝 |
| 飞书通知、认领、超时与复验 | [中央执行接线](./templates/platform/README.md) | 实际送达、失败重试、认领和独立关闭均留记录 |

项目检查作业与受控签发、部署、通知作业隔离。Hook 提供早反馈；服务端强制检查负责防绕过。

## 按需深入

| 要做什么 | 文档 |
| --- | --- |
| 调整检查器、范围、等级与例外 | [策略配置](./docs/02-config.md) · [适配器](./docs/05-adapters.md) |
| 维护修复白名单、漂移检查与回滚 | [修复闭环](./docs/04-fix-loop.md) |
| 只读定位问题，减少重复扫描与上下文 | [低 token 执行](./docs/14-low-token-execution.md) · [Java 报告分级](./docs/15-java-report-triage.md) |
| 排查接入与环境问题 | [项目与运维集成](./docs/16-project-ci-integration.md) · [完整索引](./docs/README.md) |

检查退出码：`0` 通过，`1` 质量阻断，`2` 执行或证据无效。后两者都需要处理，不得以历史绿报告替代本轮结果。

## WL 系列

**WL = World Leading。** 按职责组合，未使用的包无需安装。

| 包 | 职责 |
| --- | --- |
| **Gate** | 统一接入、检查裁决、修复复扫、Review 与发布证据 |
| [Kit](https://github.com/ChenyCHENYU/wl-skills-kit) | PC Vue 管理端需求、契约、代码生成与工程规范 |
| [UI](https://github.com/ChenyCHENYU/wl-skills-ui) | PC 管理端设计令牌、样式与交互质量 |
| [BD](https://github.com/ChenyCHENYU/wl-skills-bd) | Java 后端规范、契约与检查能力 |
| [Test](https://github.com/ChenyCHENYU/wl-skills-test) | 测试设计、执行与结果验证 |
| [Design](https://github.com/ChenyCHENYU/wl-skills-design) | 需求与设计模型、交付契约 |

使用授权见 [LICENSE](./LICENSE)。问题反馈请附包版本、执行命令和脱敏报告，提交至 [Issues](https://github.com/ChenyCHENYU/wl-skills-gate/issues)。
