#!/bin/sh
# SessionStart 钩子：确保 Headroom 压缩代理在本机运行（静默、尽力而为，失败不打扰会话）。
# 可用环境变量覆盖：
#   HEADROOM_PROXY_PORT          代理端口（默认 8787）
#   HEADROOM_PROXY_AUTOSTART=0   关闭自动拉起
#   HEADROOM_UPSTREAM_ANTHROPIC  Anthropic 上游（默认 GLM open.bigmodel.cn/api/anthropic）
#
# 注意：ZCode 侧供应商的 API 格式必须选 Anthropic（Messages）。
# OpenAI/Chat Completions 格式无法用于 bigmodel 上游——headroom 转发时保留
# 客户端的 /v1 路径前缀，bigmodel 无 /v1/... 路径，必然 404。如确有兼容 /v1
# 路径的网关，可自行 export OPENAI_TARGET_API_URL 后在此脚本中恢复该 env。
command -v headroom >/dev/null 2>&1 || exit 0

PORT="${HEADROOM_PROXY_PORT:-8787}"
LOG="${HOME:-/tmp}/.zcode-headroom-proxy.log"

# 端口上已有服务在监听则不重复拉起
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  exit 0
fi

[ "${HEADROOM_PROXY_AUTOSTART:-1}" = "1" ] || exit 0

ANTHROPIC_TARGET_API_URL="${HEADROOM_UPSTREAM_ANTHROPIC:-https://open.bigmodel.cn/api/anthropic}" \
  nohup headroom proxy --port "$PORT" >>"$LOG" 2>&1 &

exit 0
