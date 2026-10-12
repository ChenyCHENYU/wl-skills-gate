// Gate owns risk classification; engine priority/category remain native evidence, not organisation severity.
export const JAVA_RISK_POLICY_VERSION = "java-risk-policy-v1";
const PMD_FLOORS = Object.freeze({
  CloseResource: "resource-lifetime",
  EmptyCatchBlock: "exception-handling",
  OverrideBothEqualsAndHashcode: "object-equality",
  UseEqualsToCompareStrings: "string-equality",
  HardCodedCryptoKey: "cryptographic-key",
  InsecureCryptoIv: "cryptographic-iv",
  BrokenNullCheck: "null-safety",
});
const CONTEXT_REVIEW = Object.freeze({
  EI_EXPOSE_REP2: "检查可变输入的所有权、真实共享与防御性复制；DI 注入不能自动免检全部字段",
  EI_EXPOSE_REP: "检查返回引用、可变 DTO 和调用方是否能改变内部状态",
  MS_EXPOSE_REP: "检查静态数组/集合是否泄露；静态表头也须保留真实发现",
  CT_CONSTRUCTOR_THROW: "检查构造期异常、继承/终结器与实际攻击面；不能仅凭框架或类名豁免",
});
const BUG_CATEGORIES = new Set(["CORRECTNESS", "SECURITY", "MALICIOUS_CODE"]);

export function classifyJavaRisk({ format, rule, category = null, priority = null }) {
  if (["pmd", "p3c"].includes(format)) {
    if (Object.hasOwn(PMD_FLOORS, rule)) return { severity: "error", baselineAllowed: false,
      classification: "quality-floor", family: PMD_FLOORS[rule], reviewRequired: false,
      reason: "已批准安全/正确性底线，不允许历史基线或豁免隐藏" };
    if (rule === "UseLocaleWithCaseConversions") return { severity: "warning", baselineAllowed: true,
      classification: "explicit-locale", family: "locale", reviewRequired: true,
      reason: "大小写转换须显式 Locale；按业务选择 Locale.ROOT 或目标语言环境，不能全局禁用或猜测替换" };
    if (/security|crypto/i.test(category || "") || /(?:Crypto|Security|Insecure)/.test(rule)) {
      return { severity: "warning", baselineAllowed: false, classification: "unclassified-security-review",
        family: "security-review", reviewRequired: true, reason: "未批准的新安全规则须审核中央风险映射，不能自动加入历史基线" };
    }
  }
  if (format === "spotbugs") {
    if (Object.hasOwn(CONTEXT_REVIEW, rule)) return { severity: "warning", baselineAllowed: true,
      classification: "context-review", family: "representation-and-construction", reviewRequired: true,
      reason: CONTEXT_REVIEW[rule] };
    if (BUG_CATEGORIES.has(category) && Number.isInteger(priority) && priority >= 1 && priority <= 2) return { severity: "error", baselineAllowed: false,
      classification: "quality-floor", family: category.toLowerCase(), reviewRequired: false,
      reason: "原生高/中置信度正确性或安全底线，不允许基线或豁免" };
  }
  return { severity: "warning", baselineAllowed: true, classification: "governance-warning",
    family: format === "checkstyle" ? "style" : "static-review", reviewRequired: true,
    reason: "保留原生静态发现与定位，按批准的范围和时限治理；静态提示不等于业务缺陷已证实" };
}
