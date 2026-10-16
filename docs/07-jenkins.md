# 07 Jenkins 构建、签发与部署

使用包内 [CI 模板](../templates/ci/)，由米传汇智和运维冻结实际作业、SCM/ref、镜像、脚本、凭据与修改权限。项目作者不能替换或跳过受控作业；真实环境另做验收。

## 一次接好五类作业

| 顺序 | 模板 | 自动执行与成功条件 |
|---:|---|---|
| 1 | [Jenkinsfile](../templates/ci/Jenkinsfile) | checkout → 按实际 SHA 选择正式 Review、重查当前 CI → 固定依赖准备 → release 全量检查 → 实际构建 → manifest |
| 2 | [Jenkinsfile.attest](../templates/ci/Jenkinsfile.attest) | 独立查询成功作业、下载原始报告/清单/制品，再签组件证明；不执行项目代码 |
| 3 | [Jenkinsfile.release-sign](../templates/ci/Jenkinsfile.release-sign) | 消费助手生成且已另行批准的组合输入；核验两仓正式 Review、组件证明、实际制品与兼容依据，签固定组合 |
| 4 | [Jenkinsfile.deployment](../templates/ci/Jenkinsfile.deployment) | 核验组合、当前环境与固定适配器 → 自动登记计划 → 登录后独立授权 deploy → 执行并交付原始记录 |
| 5 | 同一部署模板的 smoke / recover | 各自生成新计划、取得对应动作授权；独立验证人授权 smoke，恢复依据已批准的旧组合和恢复约束 |

[Review 签发模板](../templates/ci/Jenkinsfile.review-sign)独立消费认证页面的九维确认授权，产生正式记录与交付 manifest。它与构建、组件/组合签发、部署分别运行，不把私钥授给项目检查 Runner。

## 构建前检查什么

`verify-release-review --publication-dir` 从中央固定目录自动选择本次 checkout SHA 的当前正式记录，不要求人复制动态报告路径。固定信任配置核验 Review 与身份授权公钥、issuer、复核名单、九维/机器策略和原始证据；随后重新查询当前 CI。缺证据、自审、错误 SHA、被替代的 Review、重试后的失败/新作业均阻断。

中央 Review 原件可只读挂载。当前 CI 复验记录写入本机 `quality-reports/release-review-live/<uuid>/`，结果和失败原因写入 `release-review-verification.json/.log`，随 `post always` 归档。

`ci-prepare` 使用中央预装固定 Gate，核对已提交 `quality/workspace.json` 与依赖锁的批准字节摘要，按锁安装且关闭任意生命周期；必要准备仅用固定适配。未知脚本、版本不符、锁或源码漂移均停止。它不在 CI 激活 Hook，也不代替后续质量检查。

实际构建脚本来自批准作业配置。前端 manifest 纳入真实 dist，后端纳入真实 JAR；分发配置和数据脚本用 `WL_CONFIG_PATHS` 纳入。部署只消费这些不可变制品，不重新构建。

## 组合与授权

发布负责人从接入助手选择“生成组合发布输入”。固定 [输入配置](../templates/platform/release-input-config.json)引用真实采集/签发原件与 `reviewPublicationDir`，程序按两仓实际 SHA 自动选 Review，展示作者、复核人、作业、部署顺序和 schema。确认只授权生成输入；组合签发与部署另行批准。

[release-review-trust.json](../templates/platform/release-review-trust.json)固定中央公钥、人员、摘要、证据根、collector 和 catalog。[deployment-config.json](../templates/platform/deployment-config.json)通过 `reviewConfigFile` 绑定同份信任。`release-set create/verify --review-config` 与部署消费都会重验正式 Review 及归档原件；直接给旧 formal 文件也不能绕过当前版本。旧组合缺 Review 归档须重新生成。

普通新发布要求当前有效 Review。smoke/recover 对已签组合按其签发时点核验历史 Review，仍须核验原签名、实际制品/环境和新的独立动作授权，不因此取得新发布或关闭权限。

`run release`、`attest`、`verify-artifact` 是机器事实接口，单独通过不能代替正式 Review、组合准入、部署授权或问题关闭。构建成功也不关闭问题；必要环境独立复验后，再由认证处理页执行关闭。

## 固定变量与凭据

下表配置在受控作业/凭据库，不能由作者临时提交或覆盖。路径/摘要由批准资产与真实采集结果交接，生成值由作业传递，发布操作者不逐次抄填。

| 作业 | 固定变量或输入 |
|---|---|
| 全部 Jenkins 模板 | `WL_APPROVED_GATE_CLI`：批准镜像/安装包中的固定 CLI；Node、项目包管理器、JDK/Maven 和镜像摘要另行固定 |
| 检查/构建 | `WL_PROJECT`、`WL_TARGET_ENV`；`WL_APPROVED_REVIEW_TRUST_CONFIG`、`WL_APPROVED_REVIEW_PUBLICATION_DIR`；`WL_APPROVED_WORKSPACE_HASH`、`WL_APPROVED_DEPENDENCY_LOCK_HASH`；`WL_APPROVED_POLICY_HASH`、`WL_APPROVED_RULES_HASH`、`WL_APPROVED_BASELINE_HASH`、`WL_APPROVED_WAIVERS_HASH`；`WL_APPROVED_BUILD_SCRIPT`、`WL_ARTIFACT_PATHS` |
| 构建可选项 | `WL_CONFIG_PATHS`：实际分发配置/脚本；`WL_APPROVED_REVIEW_BASE_SHA`：批准的差异基点 |
| 组件签发 | `WL_APPROVED_GATE_ROOT`、`WL_FIXED_CI_SOURCE_CONFIG`、`WL_CENTRAL_CI_REQUEST`、`WL_NEW_COLLECTED_DIRECTORY`、`WL_FIXED_COMPONENT_SIGN_REQUEST`；请求绑定本次实际来源、候选/环境、清单、四类策略摘要和输出 |
| 正式 Review 签发 | `WL_REVIEW_PUBLISH_CONFIG`：隔离签发配置 |
| 组合签发 | `WL_APPROVED_RELEASE_INPUT`、`WL_APPROVED_RELEASE_INPUT_HASH`、`WL_CENTRAL_EVIDENCE_ROOT`、`WL_APPROVED_REVIEW_TRUST_CONFIG`、`WL_RELEASE_ISSUER`、`WL_NEW_RELEASE_SET_FILE` |
| 部署/复验 | `WL_DEPLOYMENT_CONFIG`、`WL_DEPLOYMENT_CONFIG_ID`、`WL_SELECTED_RELEASE_SET`、`WL_SELECTED_RELEASE_SET_HASH`、`WL_FIXED_ENVIRONMENT_STATE`、`WL_CONTROL_DATA_DIR`、`WL_CONTROL_ORIGIN` |
| 中央调度 | `WL_CENTRAL_AUTOMATION_CONFIG`；Jenkins 定时作业与 systemd/常驻循环择一 |

| 凭据 ID / 环境变量 | 只授给谁 |
|---|---|
| `wl-ci-review-readonly-token` → `WL_GITLAB_READ_TOKEN` | 构建前 Review 重查与独立 Review 签发；构建模板仅在校验阶段绑定 |
| 来源配置的 `tokenEnv` / `userEnv` | 对应查询作业；Jenkins 来源另按配置注入 `WL_JENKINS_READ_USER`、`WL_JENKINS_READ_TOKEN`，不授源码执行阶段 |
| `wl-component-proof-signing-key` → `WL_COMPONENT_KEY` | 独立组件签发 |
| `wl-review-signing-key` → `WL_REVIEW_PRIVATE_KEY_FILE` | 独立正式 Review 签发 |
| `wl-release-set-signing-key` → `WL_RELEASE_KEY` | 独立组合签发 |
| `wl-deployment-execution-key` → `WL_EXECUTOR_KEY` | 受控部署/复验执行；实际部署 API 凭据由固定适配配置的 `secretEnv` 注入 |

`WL_CHECKED_SHA` 来自实际 checkout。`ACTION` 是 deploy/smoke/recover 选项；`WL_CURRENT_PLAN_ID`、`WL_NEW_DEPLOYMENT_PLAN`、`WL_NEW_EXECUTION_DIRECTORY` 由模板生成。Jenkins 提供的 `JOB_NAME/BUILD_NUMBER/BUILD_URL` 必须与部署配置匹配；不以人工 SHA 参数代替真实 SCM revision。

中央飞书、身份与事件签名凭据由[中央接线配置](../templates/platform/README.md)引用并隔离，不放入检查/构建作业。运行前创建受控持久目录、输入队列和归档目录；通知失败保留原始检查/部署结果，并由待发箱与独立监控反馈。

## 验收

至少演练：正常完整组合、缺/旧 Review、当前 CI 失败或重试、错 SHA、替换制品/配置、错环境、无授权/重放、冒烟失败与显式恢复。成功与失败都保留原始报告和作业 ID；真实 Jenkins 权限、实际部署/冒烟与群投递另留现场证据。
