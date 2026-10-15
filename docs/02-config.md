# 02 策略、版本、基线和例外

对应 3.3/3.4/3.6、A1。项目 quality/ 支持 policy.yml/.yaml/.json、waivers.yml/.yaml/.json、baseline.json、rules.lock.json。

0.7.0 源码修订（实际 registry 发布另验）：`cmd-json.format` 可选 wl-kit/wl-ui/wl-bd，`captureStdout: true` 必须同时声明 file；`java-xml` 必填 format=checkstyle/pmd/p3c/spotbugs 与 file。java-xml 与 junit 可声明共享 producer，同组必须有相同 tool/command/timeoutMs，在本轮只生产一次；不允许将两个适配器混为同一组。见 [Java 静态片段](../templates/quality/java-static-checks.yml)、[适配器契约](05-adapters.md)与 [14 执行约束](14-low-token-execution.md)。

JUnit 单报告保留 file；多报告使用与 file 互斥的 files 明确路径数组，并必填 reportDirs（各报告直接父目录的完整集合）。requiredSuites 精确匹配 testsuite.name，requiredTests 使用 classname#name；目录全部 XML 必须与 files 一致，不使用 glob 或动态“实际清单自动批准”。全过程及签发核验真实 testcase/计数/必测、原始摘要、SHA/eventId/sourceDigest；终轮报告被改也 invalid。示例与 Java 单元计划见 [16 正式操作入口](16-project-ci-integration.md)。

仅 java-xml 允许 `sourceRoots`，须为无重复、实际存在且没有符号链接的项目内相对目录数组；SpotBugs 未配置时只兼容 `src/main/java`，不搜索整个仓库。详见 [Java 分级与定位](15-java-report-triage.md)。风险分级和测试拆分见 [13 质量成本与隔离](13-quality-cost-and-isolation.md)。`enforceWarnings: false` 只控制 Gate 警告，不改变原生 Maven 插件的失败行为。

policy 必需。没有 baseline/waivers 表示没有登记任何基线/例外，摘要为 `sha256("absent")`；存在的文件损坏时失败关闭。受控 `--sha`、release 和正式签发时，有文件就必须提供批准的 `--expect-baseline-hash` / `--expect-waivers-hash`，空文件也一样；本地非受控诊断可不传。

## policy

```yaml
schemaVersion: 1
project: wl-ui-produce
enforceWarnings: false
blockerWaivers: reject
releaseRequires: [TS-TYPECHECK, FE-ESLINT]
checks:
  - id: TS-TYPECHECK
    tool: typecheck
    bin: node_modules/.bin/vue-tsc
    args: --noEmit
    versionCommand: node_modules/.bin/vue-tsc --version
    profiles: [standard, release]
  - id: FE-ESLINT
    tool: eslint
    targets: [src]
    versionCommand: node_modules/.bin/eslint --version
    profiles: [fast, standard, release]
```

检查 id 唯一。required 默认 true。确不适用的观察检查才可 `required:false + naReason`；类型、测试检查不可降级。releaseRequires 非空、引用已声明且在 release 中必需的检查，漏项判 invalid。

项目声明不是中央底线。平台批准策略和适用表，固定摘要；作者不能通过删除检查、改成 observe 或修改期望变量改变强制口径。不能凭包中有 adapter 认定九维度已全部覆盖。

## 实际版本锁

rules.lock.json 示例：

```json
{
  "lockVersion": 1,
  "wl-skills-gate": "0.7.0",
  "tools": {
    "TS-TYPECHECK": "<实际版本命令完整输出>",
    "FE-ESLINT": "<实际版本命令完整输出>"
  }
}
```

tools 以 check id 为键。执行 versionCommand 时使用其真实输出，随后与锁比对。release 所有必需检查均要有版本锁；实际 gate 版本也核验。raw/cmd 工具的自报版本不足以证明执行器真实性，生产接入需受控执行器、版本命令、固定镜像/依赖锁和覆盖证据。

## 基线

```json
{
  "generatedAt": "2026-10-08T00:00:00Z",
  "ruleSetVersion": "approved-rule-set",
  "items": [{
    "fingerprint": "<完整指纹>", "ruleId": "ESLINT/example", "file": "src/legacy.ts",
    "severity": "error", "occurrenceCount": 1,
    "firstSeenSha": "<首次发现SHA>", "owner": "409322"
  }]
}
```

只承接经审批的历史静态 error/warning。blocker、类型/编译、关键测试、权限/数据/环境等质量底线不进入基线；其他执行器用 `baselineAllowed:false` 标出不可基线化规则。

同指纹合并取最高严重程度，发生次数超过基线 occurrenceCount、风险提高时重新判新增。基线摘要需与批准版本一致。完整且所有检查有效的全量扫描才标 resolvedPending；增量扫描不以“没看到”认定消失；最终移除仍需独立复验，复发按新增。

## 例外

每条包含字符串 id/ruleId/reason/owner/approver/expiresAt，可选 path。自批、非法日期、缺字段记录为无效，按无豁免处理；正式签发拒绝含无效例外的报告。例外文件必须是数组。到期自动阻断，质量底线不能豁免，blockerWaivers 只接受 reject。

姓名字段不能证明实际审批。平台需核验审批来源，并向签发/更新作业传批准的 waiversHash；自行修改文件、重新算摘要不能取得批准。

## 配置格式与修复白名单

yaml-lite 支持简单键值、一级列表、流式数组、布尔/null、裸十进制安全整数、引号与注释；timeoutMs 等整数可直接写 600000。引号数字仍是字符串，日期/普通参数不转数值，超出安全整数范围拒绝。检查内 files/reportDirs 等用行内数组；复杂或嵌套 fixer 结构用 policy.json，见 04。重复键和不支持语法失败关闭。未使用的工具包不强制安装或登记。

受控 --sha / release 的全部必需检查还须实际查询工具版本并匹配 rules.lock.tools；仅 JSON 自报版本不能签发正式证明。ESLint/typecheck 可查询对应 bin --version，其他 adapter 需登记受控 versionCommand。

## ESLint 范围配置（0.5.1）

`targets` 是非空、无重复的项目相对目录/文件/glob 数组，缺省 `["."]`；`args` 是批准的额外 CLI 参数。全量检查传入 targets；staged/range 检查以 NUL 分隔的 Git 文件清单为准，保留中文与空格。ESLint 的 `command` 覆盖仅供全量接入，不能配增量或 promote；生产优先用 `bin + targets + args`。检查 args 禁止 `--fix` / `--fix-dry-run`，机械修复使用独立入口。

ESLint 8 的 eslintrc 项目可按实际需要配置 `args: --ext .js,.jsx,.ts,.tsx,.vue`；flat config 通过文件匹配配置纳入扩展名，不照抄 `--ext`。参数和扩展名必须结合项目配置验收。[ESLint 8 官方 CLI](https://eslint.org/docs/v8.x/use/command-line-interface)。

扫描数大于零只证明没有空跑；应检查哪些目录/扩展名、哪些排除项获批准、历史数量变化是否合理，仍由平台适用登记和覆盖对账承担。不要因检查了一个 JS 文件就认定 Vue/TS 项目全部覆盖。
