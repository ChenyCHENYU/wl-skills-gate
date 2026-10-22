# 07 Jenkins：薄接入、严格构建与发布

**新接入只保留一份受控登记和一个包调用入口。** 核心执行在Gate内，前后端用同一入口；不同项目、分支和模块通过独立scope／policy绑定。

## 公共入口（新接入默认）

Gate直接在实际节点安装服务器公共入口，随包升级，不需要新增仓库或单独发布共享库。交付包运行运维包的`01_接入Jenkins.sh`或完整包的`02_接入Jenkins.sh`；底层为`wl-quality jenkins install --config <批准安装参数>`。生成命令别名、`jenkins-cluster.json`、受控`jenkins/entry.groovy`和一行Pipeline：

```groovy
node('wl-quality-router') { load('/opt/wl-quality/gate-validation/jenkins/entry.groovy') }.call()
```

路径以安装回执为准。路由节点增加`wl-quality-router`标签，读取受控配置；入口按实际Job识别角色、核验入口／包字节，先释放路由节点再分配业务节点，不检出业务代码。业务Job必须唯一登记，不能切换为签发或配置任务。Jenkins原生`load`见[官方步骤文档](https://www.jenkins.io/doc/pipeline/steps/workflow-cps/#load-evaluate-a-groovy-source-file-into-the-pipeline-script)。

运维只建一个`wl-quality-fleet` Pipeline任务，启用Sandbox并粘贴生成的一行。首次“准备公共任务”使用配置服务账号，预览／确认后创建其余四个任务，逐项回读；同名自定义配置拒绝覆盖，不启动业务或定时。中央与Review实际联验后，勾选各自`ENABLE_SCHEDULER`运行一次，启用每分钟调度。后续项目按批准登记批量接入，不逐Job复制脚本。节点准备脚本现已自动核对项目登记与中央配置；缺工程配置时保留准备成果、列出责任人与下一步，补齐后重跑同一入口，不再使用单独核对脚本。节点入口损坏仍须停止。交付包另在验收目录提供自包含环境／飞书测试任务，节点未安装Gate时也可先验流水线机器人。

`wl-quality jenkins context --verify-entry`验证本轮真实Job与安装字节。CHECK及BUILD准备阶段生成`quality-reports/ci-integration/entry-context.json`，与原件一同归档；中央来源固定运行时与入口摘要，缺失或旧版本证据拒收，升级不能沿用旧绿报告。

## 节点自检与失败通知

正常接入先运行编号脚本，再由自动创建的`wl-quality-doctor`验环境与机器人。若要在安装Gate前先验证失败通知，使用交付包`验收/环境与飞书验证.Jenkinsfile`：首次默认环境检查；后续在参数化构建中勾选`TEST_NOTIFICATION`可只测消息。自检使用 Python3 标准库；即使 Node 或 Gate 缺失，也能记录失败并尝试签名通知。安装自动记录实际Node目录，服务器公共入口、命令别名及任务子进程统一使用该目录；其他节点路径不同时，在该节点设置受控`WL_NODE_BIN_DIR`。无需修改受控脚本，不能在自检与构建中各选一套运行时。

生成的业务入口与辅助任务均先自检，再执行业务操作。异常处理使用流水线机器人凭据 `wl-feishu-ci-webhook`、`wl-feishu-ci-signing-secret`；凭据只在通知阶段绑定。缺凭据、缺 Python3、网络失败不会把原失败变成成功，也不假报送达。普通代码质量阻断由中央质量卡片通知，避免再发一张环境异常卡片；报告发布失败仍单独报执行异常。

新接入的五类任务共用同一个本地入口：节点自检、接线核验、中央调度、独立Review签发、批量接入维护。旧内嵌模板由`lib/jenkins-bootstrap.js`保留兼容，不能直接复制含`__WL_*__`的源模板。签发节点保持隔离。

底层CLI入口为 `node <gateHome>/bin/wl-skills-gate.js`；日常接入使用生成的一行Pipeline，正式准入由包内执行。

中央调度模板显式绑定四项 Secret text：`wl-feishu-ci-webhook` → `WL_FEISHU_CI_WEBHOOK`、`wl-feishu-ci-signing-secret` → `WL_FEISHU_CI_SECRET`，项目机器人对应 `wl-feishu-project-webhook` / `wl-feishu-project-signing-secret` → `WL_FEISHU_PROJECT_WEBHOOK` / `WL_FEISHU_PROJECT_SECRET`。绑定名与治理配置保持一致；节点自检可用 `TEST_NOTIFICATION` 单独测试流水线机器人，不执行质量或构建动作。中央调度先执行同凭据上下文的只读中央预检，通过后才采集发送。中央任务另绑定`wl-jenkins-ci-readonly`、`wl-ci-review-readonly-token`、`wl-jenkins-build-dispatch`与`wl-quality-sso-client-secret`，分别注入CI读取、GitLab身份读取、批准续建及SSO预检变量。事件签名与身份服务按批准配置挂载并独立运行；代码执行和正式Review签名私钥不混入中央采集任务。

## 批量接入：一次安装，一个维护入口

**运维不逐个Job粘贴入口。** 每个实际Agent或固定镜像安装一次Gate及所需分析器；工程侧按项目/分支/scope交付批准登记、中央来源和构建资产。几十个Job由一个受控维护任务统一配置。

| 步骤 | 运维操作 | 成功反馈 |
|---|---|---|
| 1 准备一次 | 安装固定包、准备持久卷及凭据；工程侧交付批准配置 | 节点自检`ready`；机器人连通测试`sent` |
| 2 建维护入口 | 使用安装脚本生成的一行入口建立`wl-quality-fleet`；执行“准备公共任务”后再“盘点” | 真实Job清单及无法识别项；仅GET，不改任务 |
| 3 批量接入 | `jenkins-fleet.json`选择已批准项目及分支；执行“接入”，核对预览后由指定人员确认 | 创建/更新入口、精确分支Push Hook、回读配置、同步中央摘要；逐Job返回结果 |
| 4 联验与扩展 | 先对`test`完成真实联验；扩大批准清单后再次接入 | `configuration-verified`后另验真实合入、阻断、修复、审核、构建、通知与报告 |

[批量清单模板](../templates/platform/jenkins-fleet.json)不存密钥。`registryFiles`可引用多个节点组登记，每份登记一个Agent标签；`selection`必须明确项目及分支，不按视图名或通配符授权。新增范围由工程侧完成检查计划、正式Review信任、中央来源及构建脚本的批准，运维重复同一维护入口。

维护任务与其余公共任务共用安装脚本生成的一行Pipeline。配置凭据固定为：`wl-jenkins-config-manager`（Username with password，密码填API Token）、`wl-gitlab-hooks-token`（Secret text）、`wl-gitlab-jenkins-webhook-secret`（Secret text，GitLab/Jenkins共用Webhook Secret）。只授予受控维护任务，不能给项目源码执行阶段。原有GitLab插件仍需可用；不新增Job DSL插件。API Token沿用Jenkins现有认证与CSRF机制。

自动处理重复执行、写后回读、部分失败续跑、配置漂移检查及原始配置留存；支持“核验”和“回退”。私有计划/原始配置放`dataDir/plans/<批次>/`，不归档到工作区；Jenkins只归档公开结果与批准人。回退已有Gate任务恢复原配置，新建任务禁用并保留历史；不删除Job或已有Hook。新增Hook可能保留，指向禁用Job不执行构建。

**已有自定义部署、回滚或SCM流水线不自动覆盖。** 盘点会保留并列出；工程侧先把批准构建动作纳入Gate接入，部署/回滚另做适配。`configuration-verified`表示配置回读通过，不能代替业务运行验收。

技术排查可使用`jenkins fleet inventory|plan|show|apply|verify|rollback --config <清单>`；有写入的动作必须有当前预览摘要和确认，日常由维护任务传递，不要求运维手抄。中央调度空闲时批量执行；任务运行/排队或有未完成采集时停止相关写入，不强制中断。迁移中央摘要时保留原问题台账、发现水位与历史；中断后续跑原批次，不删除维护标记或重建台账。

单任务排查仍可使用启动器菜单7生成登记、菜单8只读核验。可先登记CHECK完成自动检查、九维草稿和报告发布；接入BUILD必须补齐同范围严格Review信任、批准构建脚本与真实制品范围。批量路径自动同步`stable-v1`作业摘要；该协议只忽略已知Declarative跟踪元数据，脚本、权限、参数及触发设置仍固定核验。

## 粒度和防误配

- 一条登记精确对应项目、目标分支、scope、一个CHECK及可选BUILD；CHECK与BUILD不得使用同一个Job。可为模块选择`quality/scopes/pl/policy.json`等已批准策略，并用`evidencePlanFile`绑定该模块的必测和证据计划。不同scope不能复用正式Review。
- 自动生成工作副本、锁、机器策略、规则、基线、豁免、九维策略和证据计划的八项摘要；不在CI重新计算后自行批准变更。
- 配置错拼、占位、重复Job、错仓库/分支/SHA、包/策略/信任/脚本漂移，均明确拒绝。
- 准入结果由受控Jenkins阶段捕获摘要，绑定项目、scope、SHA、源码、Job和运行编号；缺准备记录、改回执、过期或重复执行不能继续。
- 源码检查与业务构建子进程不继承Review/机器人凭据；安装阶段仅保留必要的包源认证环境。节点、固定包、登记及报告读取凭据仍须由运维隔离并限制权限。

**包不能强迫一条未调用它的任务执行检查。** 服务端接线核验、中央固定作业配置核验、必需状态与共享分支保护共同强制，不能只看某个Jenkins Job显示绿色。目标分支Push检查发生在合并之后；合并前拦截仍需候选合并结果检查。

## 当前交付边界

本轮以0.13.2固定正式版本交付。包发布和隔离测试不代表两业务仓库或远端已接通。正式Review后的自动续建、验证构建结果/制品采集、紧凑检查卡片可靠投递已通过隔离贯通测试；真实项目配置、中央服务、TEST任务和飞书身份仍需现场交接／验收。

团队操作以交付包根目录的完整或运维接入操作说明为准，本文供维护者排查底层契约。

## 中央自动续建与两阶段通知

工程侧交付固定中央配置，运维只启动一个调度器。参考[TEST自动执行配置](../templates/platform/automation-config.jenkins-test.json)、[CHECK来源](../templates/platform/ci-source.jenkins-test.json)与[BUILD来源](../templates/platform/ci-source.jenkins-build.json)；批量接入自动同步作业摘要，单任务排查可用菜单8只读核验。模板占位不能验收。

- CHECK来源登记`buildDispatch`（受控登记路径和bindingId）及正式Review订阅。签发后自动核对当前分支HEAD、同范围正式Review和实际BUILD入口；传入获批SHA/追踪ID。队列/构建记录对账恢复，未知结果保留告警，不盲重发。
- 同scope的BUILD来源登记固定`buildResultPath`与制品ZIP，无`qualitySummary`及部署环境；必须关联该CHECK的续建任务，不能跳过九维Review。成功后仍不表示部署或问题关闭。单ZIP上限256MiB/5000文件，超过时明确失败，拆分批准构建范围。
- `scopes.<scope>.notification`固定`channel`、`surface`、`branch`与严格清零；批准的验证分支再设`validationBranch: true`。可绑定范围技术经理，项目/CI机器人按范围分流，首次发现一轮一张卡，最多3项预览。原生彩色数量、@与恢复复用中央可靠待发箱；旧台账不能直接改身份配置。

## 附录：现有正式发布与部署作业

以下模板用于已采用相应发布契约的作业；新项目的检查／构建按前文公共入口接入。[内嵌fleet模板](../templates/ci/Jenkinsfile.fleet)仅供历史接线兼容，由`renderJenkinsMaintenance`生成，不用于替代新公共入口。

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

要求“构建前问题全部处理完”的项目在固定信任中启用 `requireResolvedFindings: true`。真实签名和原始证据核验后，必须是源码绑定的完整报告、全部检查有效、所有发现及新旧/豁免计数为零；警告和提示也不能带入构建。该判断不会关闭治理台账，部署后才能取得的验证仍在相应阶段验收。

新薄入口由包内`jenkins-runtime.js`统一断言当前项目/SHA的`preBuildFindingsResolved: true`和`liveVerified: true`；仅`status: verified`不足以放行。构建先准备固定依赖，再实时核验正式Review；只执行摘要匹配的工作区外POSIX构建脚本，制品归档不得为空。旧`Jenkinsfile.quality-check/build`和`check-project.mjs`仅兼容历史接线，不作为新项目拼装入口。

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
| `wl-jenkins-ci-readonly` → `WL_JENKINS_READ_USER` / `WL_JENKINS_READ_TOKEN` | Jenkins来源的构建前重查和独立签发；只授固定作业的配置核验/构建/工件读取，不进入项目检查阶段。仅用GitLab来源时按实际移除该绑定 |
| 来源配置的 `tokenEnv` / `userEnv` | 对应查询作业；Jenkins 来源另按配置注入 `WL_JENKINS_READ_USER`、`WL_JENKINS_READ_TOKEN`，不授源码执行阶段 |
| `wl-component-proof-signing-key` → `WL_COMPONENT_KEY` | 独立组件签发 |
| `wl-review-signing-key` → `WL_REVIEW_PRIVATE_KEY_FILE` | 独立正式 Review 签发 |
| `wl-release-set-signing-key` → `WL_RELEASE_KEY` | 独立组合签发 |
| `wl-deployment-execution-key` → `WL_EXECUTOR_KEY` | 受控部署/复验执行；实际部署 API 凭据由固定适配配置的 `secretEnv` 注入 |

`WL_CHECKED_SHA` 来自实际 checkout。`ACTION` 是 deploy/smoke/recover 选项；`WL_CURRENT_PLAN_ID`、`WL_NEW_DEPLOYMENT_PLAN`、`WL_NEW_EXECUTION_DIRECTORY` 由模板生成。Jenkins 提供的 `JOB_NAME/BUILD_NUMBER/BUILD_URL` 必须与部署配置匹配；不以人工 SHA 参数代替真实 SCM revision。

中央飞书、身份与事件签名凭据由[中央接线配置](../templates/platform/README.md)引用并隔离，不放入检查/构建作业。运行前创建受控持久目录、输入队列和归档目录；通知失败保留原始检查/部署结果，并由待发箱与独立监控反馈。

旧TEST模板曾使用`WL_SOURCE_REPOSITORY`等逐项变量；新薄入口从受控登记统一读取，仅受控续建传入`WL_REVIEW_SHA`。纯 CHECK 中央来源不设 `manifestPath`，可省略 `environment`，不产生业务构建成功事实；`test` 不是正式部署环境枚举。

## 报告发布与人员识别

新薄入口的CHECK自动调用固定[报告发布脚本](../templates/ci/jenkins-quality-report.groovy)，检查结束即发布完整九维HTML，不等构建/部署。BUILD输出本轮准入、`build-result.json`和实际`business-artifacts.zip`，非空归档后由中央独立采集，单独生成构建事实；不复用CHECK报告冒充BUILD扫描。包从受控登记读取工作区外持久卷和报告读取凭据，无需逐Job拼发布变量。旧发布模板只有实际生成本轮原始报告时，才使用它的报告发布阶段。

脚本先保存不可变 HTML/JSON 到持久卷，再用 HTML Publisher 保留本次构建报告，最后认证回查页面与文件摘要。中央采集配置的 `reportPublication.manifestPath` 指向 `quality-reports/report-publication.json`，重新核验同作业、同 SHA、同阶段和在线 HTML，才能生成群内详情链接。发布失败仍归档原始检查证据，不能发送失效按钮或当作质量通过。

`keepAll` 不保护被删除的整次构建。米传/运维需为报告所依附的构建记录设置保留策略，并独立备份持久卷；清理大体积业务制品时不能一并删除仍在有效期内的报告链接。服务只读账号验证通过后，仍用普通群成员账号验收访问权限。Jenkins 对外 URL、`BUILD_URL`、`JENKINS_URL` 应统一为批准的 HTTPS 入口；页面样式使用受控资源域，不关闭全局 CSP。

查询凭据代表服务接入权限；人工触发人读取本次构建的 `UserIdCause`，不读取凭据用户名作为触发人。配置批准的 GitLab `actorSource` 后，自动触发与手动重建均关联唯一真实合并记录，点击构建的人单独记入 `triggerSource`；上游关联缺失时拒绝回退到点击人。未配置该关联的旧入口仍含触发人语义，不能用于正式 Review 的源码作者归属。Git 提交作者、合并申请作者、合并执行人和技术经理仍分别核对，MR 作者不等于全部代码贡献者。正式运行使用范围受限的服务凭据，无需每位开发者交 Token。

## 验收

至少演练：正常完整组合、缺/旧 Review、当前 CI 失败或重试、错 SHA、替换制品/配置、错环境、无授权/重放、冒烟失败与显式恢复。成功与失败都保留原始报告和作业 ID；真实 Jenkins 权限、实际部署/冒烟与群投递另留现场证据。


## 运维巡检：项目尚未接入也能先运行

服务器统一入口安装后，先创建`wl-quality-fleet`运行“准备公共任务”，再运行`wl-quality-doctor`。它独立读取Jenkins任务、隔离检出明确的目标分支、检查Gate及项目质量配置，并用流水线机器人发送缺项提醒。无需先手工创建空的bindings／fleet／automation文件。

`jenkins-ops.json`由安装器首次生成；默认盘点可读任务中的dev、sit、uat、pre、prd、main及test。只读凭据及CI机器人的两项凭据在Jenkins配置一次。动态分支或无法唯一定位的内联脚本，在该文件的`jobMappings`一次确认，不执行项目Jenkinsfile来猜。责任人和已核验飞书身份也在此登记；缺映射会明确提示，仍发送缺项记录。

在doctor勾选`ENABLE_MONITOR`运行一次后，每5分钟自动复查。同一缺项不重复刷屏，变化、恢复及复发留存新记录。`RETRY_NOTIFICATION`只用于核对群记录后的明确补发；`RETRY_UNCONFIRMED_CHECK`只用于核对实际队列后的重试，两项均默认关闭，可能重复。

项目声明／锁／规则／证据计划未就绪时只告警，不把缺项计为代码风险，也不标记质量通过。已批准且锁定但尚未安装的依赖由CHECK自动准备。项目与登记、实际公共入口、目标分支触发及中央前置配置通过后，巡检可承接该项目固定SHA的CHECK；原有目标分支Hook继续负责后续变更触发。九维证据、实名Review授权、独立签发和BUILD准入仍由各自受控任务执行。未迁移的旧部署／回滚Job保持“未受控”，不能据此声称已经拦截；其Configure权限须限制在批准维护者。

本轮JSON及HTML在doctor构建归档可访问，持久记录保存在中央配置目录的`ops-state/`。普通群成员仍需Jenkins报告只读权限；通知送达、真实@、CPS与插件接线均需现场验证。
