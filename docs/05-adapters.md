# 05 检查适配器

对应 4.3、A4。当前七类适配器；真实工程检查和必测覆盖仍需样板验收。最新拆分与分级见 [13 质量成本与隔离](13-quality-cost-and-isolation.md)。

| tool | 输入与约束 |
|---|---|
| eslint | 实际本地 ESLint JSON；显式全量 targets、coverage 记录；空扫/全忽略/增量漏文件 invalid；exit≥2 invalid；部分暂存拒绝；仅此 adapter 支持按提交范围选文件 |
| typecheck | 实际 vue-tsc/tsc；缺失/超时 invalid，类型失败不可基线化/豁免；版本命令与 bin 对应 |
| cmd-json | 统一 findings，或 format=wl-kit/wl-ui/wl-bd 原生完整报告；captureStdout+file 支持大 JSON 文件描述符接收；默认 exit=0，显式接受 1 必须有问题证据 |
| raw-json | 本地 fixture/报告调试可读文件；受控 --sha/release 必须配置本次 command 产生新文件 |
| junit | 无 DTD 的真实完整 XML；file 单份或 files+reportDirs 全集；requiredSuites/requiredTests 核验套件和用例；计数/testcase 一致，零用例/跳过/失败阻断；支持同轮共享 producer |
| sarif | SARIF 2.1.0，runs/results 完整、工具执行成功；默认风险依据 rule 配置或 warning，不静默降 info |
| java-xml | format=checkstyle/pmd/p3c/spotbugs；解析原 XML、保留原生身份；Gate单源表分级，底线error、上下文复核warning；sourceRoots精确映射多模块main/test；生产命令须exit0，分析错误/缺类/零类/坏报告/定位失效invalid；可显式同producer共用一次本轮生产 |

## 通用 finding

必填 ruleId/severity/file/message；line 为正整数或 null；建议 context 提供稳定结构。指纹由 Gate 重算，行号不参与，合并保留 occurrences 和最高风险。

Java context 是稳定 JSON 字符串，含 producer、真实报告引擎和自报版本、原规则、原生 severity/priority/category/rank、主 class/method/field/signature、风险表版本及复核理由。不同字段/方法不会因同一generic说明合并；source line仍在finding/occurrences中，不进入稳定成员身份。P3C使用 `P3C/<原规则>`，PMD XML.version仅表示其引擎版本，不能冒充P3C插件版本。`checks[].parserMetadata` 记录本地 `java-xml-v2` 和风险表；`reportedVersionVerified=false` 不替代真实versionCommand及rules.lock核验。策略、人工分级与指纹迁移边界见 [15 Java 原生报告分级与复核](15-java-report-triage.md)。

执行器对权限、数据、编译等明确底线设置 baselineAllowed=false；Gate 内置识别 TS/JUNIT/SEC/SECURITY/BUILD/ENV/DATA/GATE 命名空间和所有 blocker。自定义规则的风险分类仍要经中央适用表批准。

## 新鲜度与失败关闭

受控检查的文件报告必须由 adapter 的 command 在本次生成；清理前先预检全部声明范围，禁止把已跟踪源码/本轮源码快照或不安全路径当输出删除。cmd-json 默认不把 exit 1 当成功；确实表示发现问题时在批准策略登记 okExitCodes=[0,1]，报告必须反映问题。声明成功但没有有效测试、异常退出却空报告、缺文件、损坏、超时均拒绝。

报告生产命令收到 WL_GATE_EVENT_ID、WL_GATE_COMMIT_SHA，可写入自己的来源字段。可信来源还依赖受控执行器与独立平台查询；JSON 中的 toolVersion、passed、completed 字样不能独自证明执行发生。

所有档位都检测执行前后源码/HEAD 变化；检查中修改源码返回 invalid。报告和构建输出应放在声明的生成目录，检查命令不能带 --fix。

## JUnit 全集与同轮生产（0.7.0）

file 与 files 互斥；使用 files 时必填 reportDirs，精确等于每份报告直接父目录的集合。生产前清理这些目录中旧 XML；新一轮目录里的全部 XML 必须与 files 全集完全相同。缺/未登记报告、子目录、symlink、路径别名、glob、坏 UTF-8/结构/计数和跨报告重复 classname#name 返回 invalid。参数化用例须保留完整不同名称；不能手写汇总计数替代 XML 中 testcase。

requiredSuites 精确 testsuite.name；requiredTests 为 classname#name，必须真实成功。每份报告/套件的零用例、skipped、failure/error 均形成不可基线化阻断。生产命令 exit 1 只有存在真实 failure/error 时才可消费；仅 skipped/缺必测不能解释异常退出。更高退出码、超时或缺新报告为 invalid。

JUnit producer 与 java-xml producer 分组独立，同组 tool/command/timeoutMs 一致，一轮执行一次。每份原始字节只读解析并核验 SHA-256，绑定 eventId/commitSha/sourceDigest；消费后到终轮的覆盖/删除/修改也拒绝。签发/部署/治理摄入对完整通过证据独立复核，不只相信 passed 字段。跨作业复制文件不能充当本轮生产。

[Java 单元生产器](../templates/scripts-quality/java-unit.mjs)和[批准 plan](../templates/quality/java-unit.plan.json)负责依赖准备及真实模块单元执行。它对任何 Maven 非零保守返回 2/invalid，保留原始阶段日志；JUnit 适配器自身能识别符合契约的真实失败为 blocked，两者不能混为一种退出口径。

## Kit/UI/BD/Test 接入

优先调用其确定性只读 CLI，将真实 findings 转入统一契约。现有 AI Skill 不一定具备确定性 CLI；没有 CLI/JSON 输出的能力需实现适配，涉及业务判断的能力保留人工 Review，不写成自动化已完成。

版本查询通过 versionCommand，release 与 rules.lock.tools 精确比对。多个 JUnit 文件、ArchUnit 匹配类数、契约/场景覆盖、首轮失败与 flaky 历史需真实生产者提供，不能只接一份空 findings。

受控 --sha / release 的全部必需检查还须实际查询工具版本并匹配 rules.lock.tools；仅 JSON 自报版本不能签发正式证明。ESLint/typecheck 可查询对应 bin --version，其他 adapter 需登记受控 versionCommand。

## 实际覆盖与原始失败原因

ESLint 的 summary.checks[].coverage 包含 mode、targets、requestedFiles、scannedFiles、scannedFileCount、ignoredFiles、complete；无适用增量文件显式记 noApplicableFiles，而全量零文件一律 invalid。必需 ESLint 检查缺覆盖证据时不能签发/使用正式证明。旧 0.5.0 ESLint 报告需要重新扫描，不能手补字段或重新签旧报告。

适配器本身失败时保留原诊断（例如 Maven 私有 parent POM 无法解析），toolVersionVerified 保持 false；不把缺失的后续版本查询覆盖成唯一原因。版本核验只在有效执行结果上继续进行。
