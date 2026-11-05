# 04 机械修复与复验

对应 6.1/6.2、A7。0.5 使用 schemaVersion=2 修复计划；旧计划需重新生成。

## 先修可确定的冗余，再完整复扫

```bash
# 默认只读，输出具体文件与机械项数量
wl-gate safe-repair --root .
# 已确认执行时，一条命令应用并自动运行standard完整检查
wl-gate safe-repair --root . --confirm
```

内置AST修复只删除同一导入声明中重复的相同绑定、相邻且同值的字面量对象字段。
显式选择 `--targets scripts/tests` 时，还能修Node测试把文件URL直接当路径的问题，使用
`fileURLToPath`兼容中文、空格及不同系统；不会处理浏览器或HTTP路径。默认范围为src，
配置、依赖、Git暂存、部署和回滚脚本不在修复范围。含注释、动态值、不同值冲突、
spread或无法确定的语法保留人工处理，不调用AI改写。

此入口不依赖一份所有检查都成功执行的报告，避免其他失效项阻止已知安全修复。
它仍核验当前HEAD、源码摘要、执行器、白名单及幂等性，留原件和回执；不能修改后直接
宣布通过。应用后自动完整复扫，剩余错误或检查失效保留真实退出码，正式Review与构建
仍须按准入流程执行。项目自己的编译／业务测试也须运行；编译成功不替代九维证据。

CI公共入口保持只检查和通知；修复在开发者授权的隔离工作区完成，正常提交后人工启动
同一业务Job复检，不让运维逐个项目修改业务代码。

## 报告驱动的已批准修复器

```bash
wl-skills-gate run --profile standard
wl-skills-gate fix --plan quality-reports/quality-summary.json
# 审查计划后，在本地/个人工作区：
wl-skills-gate fix --apply quality-reports/repair/fix-plan.json --confirm
```

仅对 standard 全量报告生成机械计划，且全部检查有效。预览前核对报告对应的源码/HEAD、策略/规则/基线/例外，扫描后已有变化则先重新扫描。增量或 release 报告不能替代完整修复复扫。报告声明 autoFixable=true 且规则属于白名单才可自动执行；报告中任意 fixCommand 被忽略，权限/事务/数据等规则走人工。

ESLint报告中的可修复标志不再自动转换成整文件 `eslint --fix`。需要其他机械动作时，
在 policy.json 显式登记经过评审的规则、文件和命令：

```json
{
  "fixers": [{
    "id": "approved-mechanical-fixer",
    "ruleIds": ["STATIC/EXAMPLE"],
    "files": ["src/example.ts"],
    "command": "node approved-fixer.mjs"
  }]
}
```

finding 指明 fixerId、autoFixable、文件。fixer 必须为经过审查的机械命令，仅修改登记文件；该白名单不是操作系统沙箱，不授权任意 AI 命令、网络/数据库或 Git 分支写入。

## 防漂移与回滚

未跟踪生成目录排除 `.git/node_modules/quality-reports/target/dist/coverage`；已被 Git 跟踪的内容一律参与快照，即使处于上述目录；受控修复器不得借此修改依赖、构建产物或仓库元数据。

计划包含完整动作、输入报告摘要、真实 HEAD、文件内容/模式快照、策略/规则摘要。planHash 覆盖整份计划，应用前重查所有输入；代码、策略、报告、HEAD、白名单或快照变化则零写入。

执行前归档原始报告。命令失败/超时、白名单外文件变化、新增回归、复扫失效或复扫期间源码再次变化时恢复项目文件快照，保留失败与复扫报告。保留用户在预览前已有的文件内容，不用 git reset 覆盖整个工作区。

受控机械命令不得写项目外资源或改变 Git 元数据；包的文件回滚不承诺恢复外部服务/数据库或 Git 元数据。遇到这些变化必须人工处理。源码有符号链接时降为人工，避免越界。

## 报告与关闭边界

fix-report 包含 applied/failedCommands/unauthorizedFiles/changedFiles/rescanChangedFiles/fixed/remaining/regressions/beforeArchive/rolledBack/scanResolved。

扫描复验通过时 `scanResolved=true, nextState=pending-verification, closed=false`。负责人和独立复核人验证原失败用例及影响范围，必要时确认目标环境生效后，由主台账关闭。CI 只检查和出计划，不自动修共享分支。

## 0.5.1 的恢复结果

修复后把普通文件替换为符号链接同样视为越界。可证明安全恢复时，恢复文件后再次运行 Gate，再核对源码摘要/HEAD；报告保存 attemptedRescan 和 rollbackVerification，撤销 fixed 清单，当前 quality-summary 反映恢复后的真实代码。rolledBack=true 只表示源码恢复已核验，不表示问题已解决。

HEAD 变化、快照异常或恢复不完整时，manualRecoveryRequired=true、退出 2；不自动 git reset，不声称已经回滚，不按尝试期间的绿报告关闭问题。保留原/后证据，由负责人查明原因再恢复、全量检查。文件恢复无法回滚外部资源、依赖缓存或其他进程。

自动修复应在独占的隔离 worktree 执行；应用期间避免人工和其他进程并发编辑，防止文件恢复覆盖并发变更。将允许的修改提交后重新取得受控质量证据与独立 Review。
