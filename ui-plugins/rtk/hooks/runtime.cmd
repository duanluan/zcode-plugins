#!/bin/sh
# POSIX 侧运行时启动器（Windows 侧用同目录 runtime-win.cmd——两个原生文件各管
# 一个平台；曾经的单文件两栖方案在 LF/CRLF 行尾上两头翻车，弃用。保留 .cmd 后缀
# 是为了兼容旧会话启动时缓存的钩子配置（/bin/sh runtime.cmd …））。
# 用法：runtime.cmd <目标脚本> [额外参数…]
# 运行时查找顺序：PATH 里的 node → 常见安装位置（nvm/volta/conda 等）→
# ZCode 自带运行时（ELECTRON_RUN_AS_NODE=1）。全部找不到时退出 127（钩子侧静默放行）。
TARGET="$1"
[ -n "$TARGET" ] || exit 127
shift
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  for nvm_node in "${HOME:-}"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nvm_node" ]; then NODE_BIN="$nvm_node"; break; fi
  done
  if [ -z "$NODE_BIN" ]; then
    for c in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node \
             "${HOME:-}/.local/bin/node" "${HOME:-}/miniforge3/bin/node" \
             "${HOME:-}/miniconda3/bin/node" "${HOME:-}/.volta/bin/node"; do
      if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
    done
  fi
fi
if [ -n "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$TARGET" "$@"
fi
for z in /opt/ZCode/zcode /usr/lib/zcode/zcode /usr/share/zcode/zcode \
         "${HOME:-}/.local/share/ZCode/zcode" \
         "/Applications/ZCode.app/Contents/MacOS/ZCode"; do
  if [ -x "$z" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$z" "$TARGET" "$@"
  fi
done
exit 127
