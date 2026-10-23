#!/bin/sh
# Pure-data bootstrap; never source/eval machine-local settings. CI ignores them.
set -eu
wl_quality_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 2
wl_quality_local=1
case "${CI:-}" in ''|0|false|FALSE|no|NO) ;; *) wl_quality_local=0 ;; esac
[ -z "${JENKINS_URL:-}${GITLAB_CI:-}${CI_PIPELINE_ID:-}${WL_GATE_DISPATCH_ID:-}${WL_REVIEW_SHA:-}" ] || wl_quality_local=0
case "${WL_GATE_STAGE:-}" in ci|target|promotion|promote|release|deployment|deploy|controller) wl_quality_local=0 ;; esac
wl_quality_node=${WL_QUALITY_NODE:-}
wl_quality_digest=
if [ -z "$wl_quality_node" ] && [ "$wl_quality_local" = 1 ]; then
  wl_quality_git=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 2
  wl_quality_record="$wl_quality_git/wl-quality/node-runtime"
  if [ -e "$wl_quality_record" ] || [ -L "$wl_quality_record" ]; then
    if [ ! -f "$wl_quality_record" ] || [ -L "$wl_quality_record" ]; then
      echo '[quality] 本机Node记录不是普通文件；重新运行项目初始化入口。' >&2; exit 2
    fi
    wl_quality_parent=$wl_quality_record
    while [ "$wl_quality_parent" != / ]; do
      [ ! -L "$wl_quality_parent" ] || { echo '[quality] 本机记录路径不接受符号链接。' >&2; exit 2; }
      wl_quality_parent=$(dirname "$wl_quality_parent")
    done
    { IFS= read -r wl_quality_digest; IFS= read -r wl_quality_node; } < "$wl_quality_record"
    case "$wl_quality_digest" in ''|*[!a-f0-9]*) echo '[quality] 本机Node摘要损坏；重新运行项目初始化入口。' >&2; exit 2 ;; esac
    [ "${#wl_quality_digest}" = 64 ] || exit 2
  fi
fi
if [ -z "$wl_quality_node" ]; then wl_quality_node=$(command -v node 2>/dev/null || true); fi
case "$wl_quality_node" in
  [A-Za-z]:\\*|[A-Za-z]:/*)
    if command -v cygpath >/dev/null 2>&1; then wl_quality_node=$(cygpath -u "$wl_quality_node")
    else echo '[quality] Windows Git Shell需要cygpath转换本机Node路径；请使用Git for Windows附带的Git Bash。' >&2; exit 2; fi ;;
esac
if [ -z "$wl_quality_node" ] || [ ! -f "$wl_quality_node" ] || [ ! -x "$wl_quality_node" ]; then
  echo '[quality] Node不可用；运行项目初始化入口一次以登记本机环境，检查不会跳过。' >&2; exit 2
fi
if [ -n "$wl_quality_digest" ]; then
  case "$wl_quality_node" in /*) ;; *) echo '[quality] 本机Node必须为绝对路径。' >&2; exit 2 ;; esac
  wl_quality_parent=$wl_quality_node
  while [ "$wl_quality_parent" != / ]; do
    [ ! -L "$wl_quality_parent" ] || { echo '[quality] 本机Node路径不接受符号链接。' >&2; exit 2; }
    wl_quality_parent=$(dirname "$wl_quality_parent")
  done
  if command -v sha256sum >/dev/null 2>&1; then wl_quality_actual=$(sha256sum "$wl_quality_node")
  elif command -v shasum >/dev/null 2>&1; then wl_quality_actual=$(shasum -a 256 "$wl_quality_node")
  else echo '[quality] 缺少系统SHA256校验工具；请运维准备sha256sum或shasum。' >&2; exit 2; fi
  [ "${wl_quality_actual%% *}" = "$wl_quality_digest" ] || { echo '[quality] 本机Node已变化；重新运行项目初始化入口确认新版本。' >&2; exit 2; }
fi
PATH="$(dirname "$wl_quality_node"):${PATH:-}"; export PATH
exec "$wl_quality_node" "$@"
