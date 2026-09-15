#!/bin/sh
# SessionStart 钩子：确保 Headroom 压缩代理在本机运行（静默、尽力而为，失败不打扰会话）。
# 可用环境变量覆盖：
#   HEADROOM_PROXY_PORT          代理端口（默认 8787）
#   HEADROOM_PROXY_AUTOSTART=0   关闭自动拉起
#   HEADROOM_UPSTREAM_ANTHROPIC  Anthropic 上游（默认 GLM open.bigmodel.cn/api/anthropic）
#
# 注意：
# - ZCode 侧供应商的 API 格式必须选 Anthropic（Messages）。OpenAI/Chat Completions
#   格式无法用于 bigmodel 上游——headroom 转发保留客户端 /v1 路径前缀，必然 404。
# - 桌面启动的 ZCode 环境往往不含用户级 PATH（~/.local/bin、miniforge 等），
#   因此这里按常见位置主动查找 headroom，不依赖 PATH。
# - 本机若已配置 systemd 用户服务（headroom-proxy），代理由 systemd 管理，
#   本钩子探测到端口在线即静默退出，与服务不冲突。
PORT="${HEADROOM_PROXY_PORT:-8787}"
LOG="${HOME:-/tmp}/.zcode-headroom-proxy.log"

# 端口上已有服务在监听则不重复拉起
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  exit 0
fi

[ "${HEADROOM_PROXY_AUTOSTART:-1}" = "1" ] || exit 0

# 定位 headroom：PATH 找不到时扫描常见用户/系统安装位置
HR=""
if command -v headroom >/dev/null 2>&1; then
  HR=$(command -v headroom)
else
  for c in "${HOME:-}/.local/bin/headroom" "${HOME:-}/miniforge3/bin/headroom" \
           "${HOME:-}/.cargo/bin/headroom" /usr/local/bin/headroom /usr/bin/headroom; do
    if [ -x "$c" ]; then HR="$c"; break; fi
  done
fi
[ -n "$HR" ] || exit 0

ANTHROPIC_TARGET_API_URL="${HEADROOM_UPSTREAM_ANTHROPIC:-https://open.bigmodel.cn/api/anthropic}" \
  nohup "$HR" proxy --port "$PORT" >>"$LOG" 2>&1 &

exit 0
