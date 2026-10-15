# 10 强制、权限与可信来源

对应 1.2/12.6/15.2、附录 B.4。

共享包统一实现。固定版本、受控配置、真实执行器、平台权限和证据来源共同形成强制链。

## 四处职责

| 位置 | 负责什么 | 平台前提 |
|---|---|---|
| 本地 | 快速反馈、修复计划 | 可被跳过，不作为最终证明 |
| 个人分支 CI | 无特权真实检查、归档 | 固定版本/批准配置、真实依赖和覆盖 |
| 共享分支更新 | 候选证明+Review+最新 HEAD，受控账号更新 | 普通账号禁写、独立控制器、同目标串行化 |
| 部署 | release 签名、真实制品/环境/批准，冒烟与回写 | 受控发布入口和独立部署凭据 |

普通 include 固定 tag 只统一引用；项目仍可覆盖 job/script/rules 或删 include。[GitLab include 官方规则](https://docs.gitlab.com/ci/yaml/includes/#override-included-configuration-values)。A23 巡检负责发现漂移，不能替代放行前的权限/证据核验。

版本/授权实际支持时可采用 [Pipeline Execution Policies](https://docs.gitlab.com/user/application_security/policies/pipeline_execution_policies/)（当前官方标 Ultimate）；否则使用独立受控晋级流水线，按候选 SHA 重跑强制检查并保护共享分支。

## 可信证据

run 的 unsigned 结果不允许部署。Ed25519 私钥仅在固定版本的受控签发作业，公钥/issuer/期望作业 ID 固定在更新/发布控制配置。Review 使用单独 Reviewer 授权及签名密钥，非作者、候选绑定。

签发前的权威查询确认真实项目、source SHA、job/pipeline、成功状态、模板/Runner、approved policy/rules/baseline/waivers、真实工具与覆盖。包内 collect-ci 已提供固定 GitLab/Jenkins 只读来源查询，详见18；实际受控模板/权限/身份和中央作业仍须配置与实测。不能把“报告来自某 CI job”或“字段填了 issuer”直接当来源可信。

同一摘要需三处一致：批准登记表 → 实际检查 → 签名验证。批准摘要来自审批后的版本，不在候选中现算现批。署名签发只证明可信主体签了这些内容，该主体必须执行来源核验，不能提供任意上传报告的盲签接口。

工具版本输出只用于检测漂移，不能证明可执行文件未被替换。扫描器、适配器、规则和 versionCommand 应来自平台批准的固定镜像/包摘要或只读挂载；业务目录里的同名脚本、作者可改的 package script、仿造 --version 输出不能作为权威执行器。自定义 cmd-json 生产者需额外审查并绑定来源，平台不能仅查询一个作者可改作业的绿色状态就签发。

## 凭据隔离

policy.command、依赖安装、测试和 fixer 可执行作者影响的代码。其 Runner 不得挂签发/Reviewer/晋级/部署/通知凭据，也不能访问持有这些凭据的 socket、共享目录或缓存。仅清环境变量不足以完成隔离。

promote-apply 在新 bare 仓库运行，不继承业务仓库的 Hook/配置；它只消费签名数据和 bundle，不执行源码。受控 remote-url 与授权来自平台。平台还需管理 Git 配置/凭据、Runner 隔离和版本升级，按真实权限实测。

## 上线前反向演练

同时伪造报告和证明并重算摘要、换公钥/issuer/job/环境、用 fast 替 release、换制品、删检查或擅改基线、伪造 Review、自审、两个候选竞争，都必须拒绝或只允许满足条件的一方。留存源作业、摘要、签名、目标前后 SHA 与拒绝日志。

台账/通知 D1～D4 同属首期：可信事件建单、实名主备/复核、消息认证跳转、未认领/逾期升级，通知失败与漏跑对账。技术阻断和管理处置各自有证据，共用 issueId。

## 源码边界与时效

0.5.1 将全部 Git 跟踪内容纳入 sourceDigest/脏状态，报告排除项不能藏住 tracked 源码；报告目录不允许覆盖项目根、跟踪文件或经项目内符号链接写出。Git submodule、特殊文件等尚无独立来源绑定时失败关闭，需另行接线验收。

proof 默认有效期 1440 分钟；平台另须提供撤销、当前批准版本核对和可信缓存过期策略。签名离线有效不能独自证明当前未撤销。旧版本恢复不能靠修改 createdAt 或延长时效复用过期证明，应重新取得批准证据或由独立紧急恢复授权链处理；当前包通过固定组合的 deployment plan/run-authorized recover 动作，另行认证授权并核对实际环境状态；见包内 Jenkinsfile.deployment。
