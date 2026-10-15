pnpm exec lint-staged

# wl-skills-hook-v2
# wl-skills-kit 自动管理：提交前规范检测（error 阻断提交）
# 如果 node_modules 不存在或 kit 未安装，优雅跳过，不阻断提交
if [ -f "node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js" ]; then
  node node_modules/@agile-team/wl-skills-kit/bin/wl-skills.js validate --pre-commit
  if [ $? -ne 0 ]; then
    echo ""
    echo "  ✖ 规范检测未通过，提交已阻断。修复后重新 git add + git commit"
    exit 1
  fi
else
  echo "  ⚠ wl-skills-kit 未安装（node_modules 中未找到），跳过提交前检测"
fi
