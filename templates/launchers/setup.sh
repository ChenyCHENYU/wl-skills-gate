#!/bin/sh
set -eu
wl_setup_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '需要技术经理先提供 Node.js 22.13+ 或 24+ 执行环境；本入口不安装系统软件。' >&2
  exit 2
fi
exec node "$wl_setup_directory/../../bin/wl-quality-setup.js" "$@"
