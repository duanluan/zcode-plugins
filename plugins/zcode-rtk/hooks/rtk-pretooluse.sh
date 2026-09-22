#!/bin/sh
# PreToolUse(Bash) 钩子：把"是否值得改写"完全交给 rtk 自己判断（rtk rewrite 是官方
# 声明的 hooks 唯一事实来源），本脚本只负责把改写结果以 deny 提示的形式递给模型
# （ZCode 钩子 schema 不支持 updatedInput 改写，deny-with-suggestion 与 rtk 官方
# 对 Copilot CLI 的做法一致）。
# 契约：stdin 收到 hook JSON；exit 0 = 放行；exit 2 = 拦截，stderr 作为提示传给模型。
# 同一会话同一条命令最多提醒（拦截）一次：首次拦截给出 rtk 改写建议，原样重跑即放行，
# 兑现"仅是提醒"的承诺。提醒记录存 ${RTK_DIR:-~/.zcode-rtk}/reminded/<hash>，超 128 条清最旧一半。
# fail-open：rtk 未装、解析失败、模式 off、已套 rtk、管道限量、输出进文件/变量、
# 下载到文件（wget 恒如此；curl 带 -o/-O/--output）、输出已丢弃（裸 >/dev/null）时一律放行。
set -u

input=$(cat 2>/dev/null) || input=""
[ -n "$input" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# 定位 rtk：桌面启动的 ZCode 环境可能不含用户级 PATH（~/.local/bin 等），
# PATH 找不到时扫描常见安装位置；仍找不到则放行（fail-open）
RTK=""
if command -v rtk >/dev/null 2>&1; then
  RTK=$(command -v rtk)
else
  for c in "${HOME:-}/.local/bin/rtk" "${HOME:-}/miniforge3/bin/rtk" \
           /usr/local/bin/rtk /usr/bin/rtk; do
    if [ -x "$c" ]; then RTK="$c"; break; fi
  done
fi
[ -n "$RTK" ] || exit 0

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
# 剔除丢弃 stdout 的重定向（>/dev/null、1>/dev/null）后，剩余仍含重定向或命令替换
# （含 2>/dev/null——stderr 丢弃但 stdout 仍在，按数据用途处理以免误拦）则放行；
# 剔除过说明输出根本不会进上下文，压缩无意义，也放行
no_sink=$(printf '%s' "$cmd" | sed -E 's/[01]?>+[[:space:]]*\/dev\/null//g')
case "$no_sink" in
  *'>'*|*'$('*|*'`'*) exit 0 ;;
esac
if [ "$no_sink" != "$cmd" ]; then
  exit 0
fi

# 下载到文件的命令 stdout 为空，压缩无意义：wget 恒下载到文件，curl 仅在
# -o/--output/-O 指定输出文件时 → 放行
if printf '%s' "$cmd" | grep -qE '(^|[[:space:];&|])wget([[:space:]]|$)'; then
  exit 0
fi
if printf '%s' "$cmd" | grep -qE '(^|[[:space:];&|])curl([[:space:]]|$)' &&
   printf '%s' "$cmd" | grep -qE '(^|[[:space:]])--output([[:space:]=]|$)|(^|[[:space:]])-[a-zA-Z]*o[[:space:]]|(^|[[:space:]])-[a-zA-Z]*O([[:space:]]|$)'; then
  exit 0
fi

# 由 rtk 判断：rc=3 且输出非空 = 有等价改写；rc=1 / 无输出 = rtk 认为不必改写
rewritten=$("$RTK" rewrite "$cmd" 2>/dev/null)
rc=$?
[ "$rc" -eq 3 ] || exit 0
[ -n "$rewritten" ] || exit 0
[ "$rewritten" != "$cmd" ] || exit 0

# 一次性提醒：本会话同命令提醒过（记录存在）→ 放行；记录写不进去 → 也放行
# （拦一条无法兑现"重跑放行"承诺的命令没有意义）
session=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(str(d.get("session_id", "")))
except Exception:
    sys.exit(1)
' 2>/dev/null) || session=""
hash=$(printf '%s\n%s' "$session" "$cmd" | python3 -c '
import hashlib, sys
print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())
' 2>/dev/null) || exit 0
[ -n "$hash" ] || exit 0
reminded="$state_dir/reminded"
[ -f "$reminded/$hash" ] && exit 0
mkdir -p "$reminded" 2>/dev/null || exit 0
: >"$reminded/$hash" 2>/dev/null || exit 0

# 提醒记录防无限增长：超过 128 条时清掉最旧的一半
entries=$(( $(ls "$reminded" 2>/dev/null | wc -l) + 0 ))
if [ "$entries" -gt 128 ]; then
  ls -t "$reminded" 2>/dev/null | tail -n +65 |
    while IFS= read -r f; do rm -f "$reminded/$f" 2>/dev/null; done
fi

{
  echo "[rtk] 改用以下等价命令（输出自动压缩 60-90%，信号不丢）："
  echo "  $rewritten"
  echo "本次仅提醒一次：改用上面的命令可享压缩；原样重跑本命令将直接放行。/rtk off 可关闭提醒。"
} >&2
exit 2
