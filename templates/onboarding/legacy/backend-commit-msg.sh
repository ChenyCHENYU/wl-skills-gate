#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"
message_file="$1"

if command -v wl-skills-bd >/dev/null 2>&1; then
  exec wl-skills-bd commit validate --file "$message_file" --target "$repo_root"
fi

package_cli="$repo_root/node_modules/@agile-team/wl-skills-bd/bin/wl-skills-bd.js"
source_cli="$repo_root/bin/wl-skills-bd.js"
if [ -f "$package_cli" ]; then
  exec node "$package_cli" commit validate --file "$message_file" --target "$repo_root"
fi
if [ -f "$source_cli" ] && [ -f "$repo_root/package.json" ]; then
  exec node "$source_cli" commit validate --file "$message_file" --target "$repo_root"
fi

echo "wl-skills-bd commit 校验器不可用；请先安装 @agile-team/wl-skills-bd。" >&2
exit 1
