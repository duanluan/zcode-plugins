#!/bin/sh
# SessionStart 钩子：静默拉起 AgentTeams 活动面板（尽力而为，失败不打扰会话）。
# 只有 ~/.zcode-agentteams/config.json 存在（即已跑过 /at-setup）才会启动；
# 端口已有服务在线则跳过。AGENTTEAMS_DASHBOARD_AUTOSTART=0 可关闭。
PORT="${AGENTTEAMS_DASHBOARD_PORT:-8712}"

[ "${AGENTTEAMS_DASHBOARD_AUTOSTART:-1}" = "1" ] || exit 0
[ -f "${HOME:-/tmp}/.zcode-agentteams/config.json" ] || exit 0

# 端口上已有服务在监听则不重复拉起
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
  exit 0
fi

# 定位 node：PATH 找不到时扫描常见安装位置（桌面启动的 ZCode 往往不含用户级 PATH）
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
else
  for c in "${HOME:-}/.local/bin/node" "${HOME:-}/.nvm/versions/node/$(ls "${HOME:-}/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node" \
           /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
[ -n "$NODE" ] || exit 0

# 定位插件目录内的 server.mjs
SERVER="$(cd "$(dirname "$0")/.." && pwd)/dashboard/server.mjs"
[ -f "$SERVER" ] || exit 0

mkdir -p "${HOME:-/tmp}/.zcode-agentteams"
nohup "$NODE" "$SERVER" --port "$PORT" >>"${HOME:-/tmp}/.zcode-agentteams/dashboard.log" 2>&1 &

exit 0
