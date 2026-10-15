#!/usr/bin/env sh
# wl-skills-prepush-hook-v1
# wl-skills-kit 自动管理：推送前全量类型检查（R14，error 阻断推送）
# 含 vue-tsc/tsc --noEmit，体积较大故放 pre-push 而非 pre-commit
# 如果 node_modules 不存在或 kit 未安装，优雅跳过，不阻断推送
if [ -f "node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js" ]; then
  node node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js validate --typecheck
  if [ $? -ne 0 ]; then
    echo ""
    echo "  ✖ 类型检查/规范检测未通过，推送已阻断（R14 类型错误零容忍）"
    echo "  → 修复后重新 git push，或单独 commit 后用 --no-verify 跳过（CI 仍会拦截）"
    exit 1
  fi
else
  echo "  ⚠ wl-skills-kit 未安装，跳过推送前类型检查"
fi
