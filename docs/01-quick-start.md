# 01 快速开始

对应 3.1/4.1、A1/A3。需要 Node 22.13+或24+，业务检查器与项目依赖需另行准备。

## 包仓库自测

```bash
npm test
node bin/wl-skills-gate.js self-test
```

自测使用临时项目/临时 Git 仓库，退出后清理，fixture 源目录不写报告。self-test 只覆盖 fixture；完整回归用 npm test。

## 业务项目接入

使用前须取得 AGILE TEAM 事先书面授权，并遵循该授权约定范围；公开 npm 包可下载不构成使用许可。详见 [LICENSE](../LICENSE)，申请通过 [仓库 Issues](https://github.com/ChenyCHENYU/wl-skills-gate/issues)。

项目负责人优先使用完整交付包的`01_接入项目.sh`，自动识别前后端、安装配套、接入Hook并首扫；运维使用运维包的`01_接入Jenkins.sh`。均按包内主说明逐步执行。

已安装固定Gate时运行：

```bash
wl-quality init
```

未安装Gate的维护者也可从批准源启动固定版本向导：

```bash
npm exec --yes --ignore-scripts --registry=https://registry.npmjs.org/ \
  --package=@agile-team/wl-skills-gate@0.13.3 -- wl-quality init
```

向导展示差异与实际安装计划，确认后执行；检查异常不能当成零问题。接入后日常由Hook自动检查；正式Review、远端强制检查、群消息与报告权限仍按现场清单验收。

## 三档

| 档位 | 位置 | 约束 |
|---|---|---|
| fast | 本地提交反馈 | staged 与 worktree 有差异时拒绝；暂存文件列表不代表所有适配器都支持增量 |
| standard | 推送前、个人分支 CI、候选检查 | 完整适用检查；受控作业显式提供真实 --sha |
| release | 构建发布验证 | Git HEAD 确定且源码干净、合法 --env、releaseRequires、实际 tools 版本锁；完整范围 |

`--base/--head` 必须成对、非空；head 必须是 checkout 的完整 HEAD SHA。当前只有 ESLint 根据范围选文件，其他适配器按各自政策执行，不能宣称统一增量。增量基线未知时采用批准的全量策略或判 invalid。

可选中央摘要参数：`--expect-policy-hash`、`--expect-rules-hash`、`--expect-baseline-hash`、`--expect-waivers-hash`。这些值由批准登记表提供，不能对候选内的任意文件临时算一个值就称“已批准”。

`--sha` 不能用来替报告贴标签；它必须与真实 HEAD 相同。release 的 `--env` 支持 dev/sit/uat/pre/prd，源代码不能在检查期间变化。

0=passed，1=blocked，2=invalid；1/2 都阻断。归档整个 quality-reports，失败也归档。

受控 --sha / release 的全部必需检查还须实际查询工具版本并匹配 rules.lock.tools；仅 JSON 自报版本不能签发正式证明。ESLint/typecheck 可查询对应 bin --version，其他 adapter 需登记受控 versionCommand。
