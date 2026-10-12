# 08 本地 Hook 接入

对应 A13。Hook 负责早反馈，服务端晋级/部署负责强制。

先读取 `git config --get core.hooksPath` 及现有 Husky/.githooks，不覆盖已有文件或改变整个 hooksPath。将 templates/hooks 中检查调用追加到现有 dispatcher，保留原有检查；Node/包/薄入口缺失时失败关闭并给安装入口。

追加前核对现有 lint-staged 与 Gate 的 ESLint 范围、参数和版本，重叠部分由平台批准唯一生产入口，保留原覆盖与失败退出；不要默认同范围重复跑两次。服务端强制检查尚未验收时不削减 pre-push standard。Hook 不启动 AI，也不为日报重复扫描；cost 从已经归档的报告统计。具体边界见 [14](14-low-token-execution.md)。

```bash
node scripts/quality/run.mjs --profile fast --scope staged
node scripts/quality/run.mjs --profile standard
```

pre-commit 调 fast 并记录耗时；pre-push 调 standard。fast 的 ESLint 只选择暂存文件，但存在部分暂存/未暂存修改时拒绝，请完成暂存或撤销后重试。其他 adapter 必须自行声明范围，不把暂存文件名当完整暂存快照。

commit-msg 通过共享包的 commit-message 入口读取同一 policy（含 JSON），核验类型、范围、功能点和具体修改。服务端接收检查需要管理员按真实 GitLab 能力另行接线，CI 复核整个新增提交范围，不只看最后一条。

本地 --no-verify 可绕过，因此不能把 Hook 成功当共享分支/部署放行证据。机械修复仅在本地明确确认后执行，不能在 Hook/CI 中静默执行 --fix。
