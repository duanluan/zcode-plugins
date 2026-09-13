#!/bin/sh
# PreToolUse(Bash) 钩子：把"是否值得改写"完全交给 rtk 自己判断（rtk rewrite 是官方
# 声明的 hooks 唯一事实来源），本脚本只负责把改写结果以 deny 提示的形式递给模型
# （ZCode 钩子 schema 不支持 updatedInput 改写，deny-with-suggestion 与 rtk 官方
# 对 Copilot CLI 的做法一致）。
# 契约：stdin 收到 hook JSON；exit 0 = 放行；exit 2 = 拦截，stderr 作为提示传给模型。
# fail-open：rtk 未装、解析失败、模式 off、已套 rtk 时一律放行。
set -u

input=$(cat 2>/dev/null) || input=""
[ -n "$input" ] || exit 0
command -v rtk >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

cmd=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(str(d.get("tool_input", {}).get("command", "")))
except Exception:
    sys.exit(1)
' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# 模式开关：hint（默认）= 改写建议；off = 完全放行
state_dir="${RTK_DIR:-$HOME/.zcode-rtk}"
state="$state_dir/mode"
if [ ! -f "$state" ]; then
  mkdir -p "$state_dir" 2>/dev/null
  printf hint >"$state" 2>/dev/null
fi
mode=$(cat "$state" 2>/dev/null)
[ "$mode" = "off" ] && exit 0

# 已套 rtk（含完整路径）或已管道限量的命令放行
printf '%s' "$cmd" | grep -qE '(^|[[:space:];&|/])rtk([[:space:]]|$)|\|[[:space:]]*(head|tail|wc|grep|awk|sed -n)\b' && exit 0

# 输出被当作数据使用时不改写（压缩摘要写进文件/变量会损坏数据）：
# 先剔除 >/dev/null 类丢弃重定向，剩余命令仍含重定向、$( ) 或反引号替换则放行
no_sink=$(printf '%s' "$cmd" | sed -E 's/[012]?>+[[:space:]]*\/dev\/null//g')
case "$no_sink" in
  *'>'*|*'$('*|*'`'*) exit 0 ;;
esac

# 由 rtk 判断：rc=3 且输出非空 = 有等价改写；rc=1 / 无输出 = rtk 认为不必改写
rewritten=$(rtk rewrite "$cmd" 2>/dev/null)
rc=$?
[ "$rc" -eq 3 ] || exit 0
[ -n "$rewritten" ] || exit 0
[ "$rewritten" != "$cmd" ] || exit 0

{
  echo "[rtk] 改用以下等价命令（输出自动压缩 60-90%，信号不丢）："
  echo "  $rewritten"
  echo "如确需未经压缩的原始输出，请原样重跑原命令（本次仅是提醒）。/rtk off 可关闭提醒。"
} >&2
exit 2
