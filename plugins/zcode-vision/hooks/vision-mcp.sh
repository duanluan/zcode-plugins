#!/bin/sh
# MCP server 引导：定位可用的 node 后执行 vision-mcp.mjs（与 vision-proxy.sh 同一套定位逻辑）。
# 桌面启动的 ZCode 环境往往不含用户级 PATH（nvm、miniforge 等），
# 因此按常见位置主动查找 node；最后用 ZCode 自带 Node（ELECTRON_RUN_AS_NODE）兜底。
MCP="$1"
[ -n "$MCP" ] && [ -f "$MCP" ] || exit 1

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
else
  for nvm_node in "${HOME:-}"/.nvm/versions/node/*/bin/node; do
    if [ -x "$nvm_node" ]; then NODE_BIN="$nvm_node"; break; fi
  done
  if [ -z "$NODE_BIN" ]; then
    for c in /usr/local/bin/node /usr/bin/node \
             "${HOME:-}/.local/bin/node" "${HOME:-}/miniforge3/bin/node" \
             "${HOME:-}/.volta/bin/node"; do
      if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
    done
  fi
fi

if [ -n "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$MCP"
fi

# 兜底：ZCode/Electron 自带 Node
for z in /opt/ZCode/zcode /usr/lib/zcode/zcode /usr/share/zcode/zcode \
         "${HOME:-}/.local/share/ZCode/zcode"; do
  if [ -x "$z" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$z" "$MCP"
  fi
done

exit 1
