# 15 Java 原生报告身份、定位与复核

适用 Gate 0.7.0；业务项目不会自动安装或升级。BD 提供团队约束和安全修复建议，扫描器负责引擎执行与原 XML；组织风险、基线和门禁分类只由 Gate [java-risk-policy.js](../lib/java-risk-policy.js) 维护。业务项目无需复制该表，BD 单包不依赖 Gate 运行时。

## 来源与版本

java-xml支持checkstyle/pmd/p3c/spotbugs。PMD/P3C使用pmd XML；P3C须显式format=p3c，生成 `P3C/<nativeRule>`。context保留producer、报告引擎和XML版本、P3C规则提供者及已报告版本、native severity/priority/category/rank、primary类/方法/字段/签名、风险表版本与复核理由。缺失属性保持null，不猜测。

P3C原XML.version表示PMD引擎版本；P3C插件版本未出现在XML时为null。`parserMetadata.parser=java-xml-v2` 和 `policyVersion=java-risk-policy-v1` 是Gate实现版本，不是外部引擎核验。`reportedVersionVerified=false`不替代真实versionCommand、rules.lock、批准POM/配置与日志；mvn -version只查询Maven，不能宣称动态核实每个插件。

## 单源风险表

| 原规则/类别 | Gate分级 | 边界 |
| --- | --- | --- |
| PMD CloseResource / EmptyCatchBlock / OverrideBothEqualsAndHashcode / UseEqualsToCompareStrings | error，baselineAllowed=false | 原四底线保留，baseline/waiver不能隐藏 |
| PMD HardCodedCryptoKey / InsecureCryptoIv / BrokenNullCheck | error，baselineAllowed=false | 安全/正确性底线，关闭warning仍阻断 |
| PMD UseLocaleWithCaseConversions | warning，explicit-locale | 按业务显式Locale.ROOT或目标语言环境，不全局禁用或猜测替换 |
| 未批准PMD安全规则 | warning，unclassified-security-review，baselineAllowed=false | 保留发现，先审核中央映射，不能自动加入历史基线 |
| SpotBugs EI_EXPOSE_REP2 / EI_EXPOSE_REP / MS_EXPOSE_REP / CT_CONSTRUCTOR_THROW | warning，context-review | 审查具体成员、引用所有权、消费者可变性及构造期攻击面 |
| 其他SpotBugs CORRECTNESS / SECURITY / MALICIOUS_CODE且priority1/2 | error，baselineAllowed=false | 原安全与正确性底线不变 |
| Checkstyle、其他PMD及低置信度SpotBugs | warning | 原生等级和定位保留，按批准范围与时限治理 |

context-review不代表误报已证实。DI注入可能由容器拥有，但同一个@Service内的可变DTO、静态数组/表头、返回内部集合仍须保留发现；不能因注解、DTO名称或final自动免检整类。CT_CONSTRUCTOR_THROW须审查继承与攻击面，不能为消掉报告机械地给所有构造器加catch。

warning可走Gate现有人工审批baseline/waiver，仍保留finding、身份及existing/waived状态；不自动全局豁免。enforceWarnings=false只控制warning是否阻断，不删除发现或覆盖生产失败。确属问题在BD约束内安全修复，再用同一引擎/规则/范围复扫；外部消费者与运行时语义未验证时保留人工/业务测试待验证。

## 多模块main/test源定位

```yaml
- id: PL-SPOTBUGS
  tool: java-xml
  format: spotbugs
  profiles: [standard, release]
  command: <批准的本模块只读报告生产命令>
  file: pl/target/spotbugsXml.xml
  sourceRoots: [pl/src/main/java, pl/src/test/java]
  versionCommand: <批准的实际工具版本查询>
```

占位命令须替换并在受控Runner验收，片段不证明执行发生。sourceRoots只java-xml支持，须为无重复、实际存在的项目内相对目录，只声明存在的源集；绝对路径、空值、..、不存在目录和符号链接拒绝。Gate只逐根探测原XML的精确包内sourcepath，不遍历全仓、不任取第一份同名源码。多处命中返回invalid，须按实际报告所属模块/源集拆检查。

未配置sourceRoots时仅兼容单模块src/main/java，不推测模块前缀。实际定位必须为存在的普通文件；PMD/P3C/Checkstyle原始绝对或项目相对路径也核验项目边界。主SourceLine或成员身份歧义拒绝，不能拼凑不同注解的成功定位。

## 稳定指纹与迁移

Java context为稳定JSON字符串，主class/method/field/signature参加指纹；不同字段或方法即使文件、行号与generic说明相同也独立。行号留在finding/occurrences，不参加稳定身份。报告引擎/规则或native风险证据变化会改变context，旧指纹不能当作新版本已批准。

原Java仅message指纹会变化。升级后真实复扫、核对成员与发生数，再审批迁移普通warning基线；不自动把全部新增项写入baseline，七项底线永远不能豁免。坏XML、PMD分析error、SpotBugs Errors/MissingClass、零类、源定位失效或生产非零仍invalid，不回退读旧报告，不降成warning。

本包回归用隔离源码和合成XML验证身份/指纹/DI可变DTO与静态表头保留/底线/locale/main-test/同名歧义/符号链接/零生产器执行/parserMetadata等契约。真实扫描范围、性能、覆盖与业务缺陷另用实际引擎验收；合成finding不是生产漏洞，空PMD/Checkstyle findings也不证明完整覆盖。
