# 中央执行与认证处理接线

包内已提供执行器和认证页面。配置及脚本随固定 Gate 包交付；此目录不需要另开发服务。`REPLACE` 必须替换为批准的实际值，不能用模板值验收。

| 顺序 | 实施工作 | 执行与成功现象 |
|---|---|---|
| 1 | 运维准备固定 Node 22.13+ 或 24+、中央目录/持久卷、独立密钥、只读CI凭据与SSO客户端 | 配置/目录权限收紧；检查Runner无法获得签名或部署凭据 |
| 2 | 米传汇智填项目CI来源、全部必需作业、Runner/配置摘要、真实用户映射、初始发现窗口 | `automation-config.json`引用前后端`ci-source.*.json`，无作业/取消也被发现；不手填expectedRuns |
| 3 | 配置九维策略、原始证据映射与认证入口 | `review-ci.*.json`→`review-collector.*.json`→`control-config.json`；缺人工证据生成待补报告，逐维非作者确认前不能签发 |
| 4 | 启动认证入口与一个中央调度方式 | `control serve`由现有HTTPS反向代理接入；选择Jenkinsfile.automation或systemd自动循环，勿重复部署 |
| 5 | 杨晨誉配置前后端飞书群与签名密钥，先预览再验收实投 | 默认无发送；批准后中央调度`--send`，卡片能跳到问题/Review处理页，故障可在投递恢复页处理 |

执行入口（由受控作业/服务管理器调用）：

```sh
node "$GATE_BIN" control serve --config "$CONTROL_CONFIG" --port 8787
node "$GATE_BIN" automation --config "$AUTOMATION_CONFIG" --watch
# 已批准真实群投递后加 --send；systemd与Jenkins只选一种调度。
```

`automation`自动完成发现、固定来源采集、签名入账、原始Review补证/登记、分类事实、漏跑/SLA对账和待发箱。进度在副作用前持久化，重启复用同份事实；同机已退出进程的锁隔离留证后可恢复，活锁/跨主机/坏锁拒绝猜删。未完成且过期的来源重新查询并分配新generation，旧证据不改时间。中央`result.json`和退出码须接现有独立运维监控，不能依赖故障中的同一飞书群。

认证入口使用固定issuer/audience/公钥、授权码+PKCE/state/nonce、Secure HttpOnly会话及CSRF校验；`sub`只映射真实员工。项目成员可看证据，主备认领，独立Reviewer逐维确认。发布Review前重新查询CI，旧job/新失败/工件变化使旧表单失效。Review发布、脚本修复、晋级、部署和问题关闭分别授权。身份、事件、Review签发及部署执行密钥分开配置。

源码证据由CI自动调用`produce-review-facts.mjs`产生真实提交/分支/diff；必需JUnit清单由接入程序从批准policy带入，并核原XML。中央从已核验CI和批准责任配置生成流水线/责任事实。缺少UI、影响分析或外部测试材料时，非作者Reviewer在认证页填写实际范围、结论和批准来源的报告链接，生成签名补证及新版本，再另行逐维确认。此记录不冒充机器测试执行，也不清除原机器阻断。`ci-source.artifacts.optionalPaths`只对明确登记的非机器Review原件有效；原始Gate报告、发布清单和实际制品缺失仍阻断。

Review身份确认后，`Jenkinsfile.review-sign`独立自动消费授权并发布正式记录；中央`automation.review.publication`订阅其manifest，公钥复验后入账和通知。签发器不持有身份或事件私钥。

发布采用已有检查/构建模板（构建前按实际SHA从固定中央目录自动匹配最新正式Review并重查CI，缺失/旧版/新失败均阻断），再依次使用`Jenkinsfile.attest`、`Jenkinsfile.release-sign`、`Jenkinsfile.deployment`。组合必须固定前后端SHA/制品、实际API契约或兼容测试、数据库迁移/无变更依据、部署顺序和恢复约束。计划先登记到`/deployments/<id>`，实际操作人确认后执行；冒烟由独立验证人另行授权。模板`controlled-deployment-http.mjs`提供真实HTTP适配，也可配置经过摘要批准的现有现场脚本。执行系统须回传实际组合、API/schema与顺序，单纯success不被接受。

CI依赖准备复用已提交工作副本清单/锁及中央批准摘要，关闭任意生命周期，仅运行固定Gate的必要适配；不在CI重复激活Hook或执行本机首扫。

组合生成/消费和deployment配置须绑定中央`release-review-trust.json`，固定Review与授权公钥、issuer、九维与机器策略摘要、独立复核名单、证据根/collector/catalog；旧组合缺正式Review归档须重新生成。

普通warning在当前周期汇总；来源首次失联、回流异常、输入队列缺失及恢复均有签名执行提醒。输入队列由运维在持久卷创建，运行时缺失不能伪装成空队列。

关闭要求当前修复SHA的完整通过报告，以及关闭策略逐环境要求的当前修复后产生且观察到的最新部署/独立验证事实。构建成功、扫描消失、消息已接收均不关闭问题；新失败使旧成功失效。复发重新打开。旧配置缺必要环境可读账但不能关闭，`governance migrate`只接受独立签名授权的精确策略收紧，不删除旧账绕过。

验收必须留下真实作业、认证用户、群投递、同候选/同制品、各必要环境复验和独立关闭记录。包内隔离测试不代替现场结果；统一操作仍以V3接入手册为准。
