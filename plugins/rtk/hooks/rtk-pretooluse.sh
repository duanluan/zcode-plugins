#!/bin/sh
# PreToolUse(Bash) 钩子：把"是否值得改写"完全交给 rtk 自己判断（rtk rewrite 是官方
# 声明的 hooks 唯一事实来源），本脚本只负责把改写结果以 deny 提示的形式递给模型
# （ZCode 钩子 schema 不支持 updatedInput 改写，deny-with-suggestion 与 rtk 官方
# 对 Copilot CLI 的做法一致）。
# 契约：stdin 收到 hook JSON；exit 0 = 放行；exit 2 = 拦截，stderr 作为提示传给模型。
# 同一会话同一条命令最多提醒（拦截）一次：首次拦截给出 rtk 改写建议，原样重跑即放行，
# 兑现"仅是提醒"的承诺。提醒记录存 ${RTK_DIR:-~/.zcode-rtk}/reminded/<hash>，超 128 条清最旧一半。
# fail-open：rtk 未装、解析失败、模式 off、已套 rtk、命令已限量（管道接 head/tail/
# wc/grep/awk/sed -n，或单独使用 head/tail/wc/sed -n）、输出进文件/变量、
# 下载到文件（wget 恒如此；curl 带 -o/-O/--output）、输出已丢弃（裸 >/dev/null）、
# 低价值命令（纯副作用或输出极小，如 git add/commit/push、mkdir/cp 等，整条命令
# 逐段全命中才放行）时一律放行。
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

# 低价值命令白名单 + 自带限量的读取命令：整条命令每段（按 &&/||/;/换行
# 切分，引号内不切）都命中才放行——拦它们没有任何压缩收益，deny 反而会误导模型把
# 正常命令拆散重跑，或逼它绕路 rtk proxy 重跑。两类命中条件：
# ① 自带限量读取：head/tail/wc、sed -n 段首使用（head -12、sed -n '1,10p' 等），
#    模型已自限输出规模，改写成 rtk read 反而可能丢行；du 带 -s/--summarize
#    时每个对象只出一行，同此；
# ② 低价值命令：git 变更类子命令（add/commit/push/branch 新建删除等，兼容
#    -C/-c/--opt=val 全局前缀）与 mkdir/cp/sleep 等纯副作用命令；git 的列举形态
#    （branch -a、config --list、tag、stash list 等，输出可能很长）除外。
# 用户可在 ${RTK_DIR:-~/.zcode-rtk}/whitelist 追加自定义条目（每行 name 或
# git:name，# 注释，非法行忽略；git:name 不做形态检查，直接放行该子命令）。
# python 崩溃或不识别 → 不放行，落回 rtk 判断，行为与之前一致。
if CMD="$cmd" WL_FILE="$state_dir/whitelist" python3 - 2>/dev/null <<'PY'
import os, re, shlex

GIT_MUTATIONS = {'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch',
                 'restore', 'stash', 'reset', 'merge', 'rebase', 'cherry-pick',
                 'apply', 'am', 'clean', 'init'}
PLAIN_MUTATIONS = {'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod', 'chown',
                   'kill', 'cd', 'export', 'sleep', 'true', 'false', 'unset'}
USER_GIT = set()

def split_top(cmd):
    segs, buf, q, i = [], [], None, 0
    n = len(cmd)
    while i < n:
        ch = cmd[i]
        if q:
            buf.append(ch)
            if ch == q:
                q = None
            elif ch == '\\' and q == '"' and i + 1 < n:
                buf.append(cmd[i + 1]); i += 1
            i += 1
        elif ch in '"\'':
            q = ch; buf.append(ch); i += 1
        elif ch == '\\':
            buf.append(ch)
            if i + 1 < n:
                buf.append(cmd[i + 1]); i += 1
            i += 1
        elif cmd[i:i + 2] in ('&&', '||'):
            segs.append(''.join(buf)); buf = []; i += 2
        elif ch in ';\n\r':
            segs.append(''.join(buf)); buf = []; i += 1
        else:
            buf.append(ch); i += 1
    segs.append(''.join(buf))
    return segs

def seg_is_pass(seg):
    try:
        toks = shlex.split(seg)
    except ValueError:
        return False
    if not toks:
        return False
    # 自带限量的读取：模型已自限输出规模，压缩无收益
    if toks[0] in ('head', 'tail', 'wc'):
        return True
    if toks[0] == 'sed' and len(toks) > 1 and toks[1].startswith('-n'):
        return True
    # du 带汇总旗标（-s / --summarize）时每个对象只出一行
    if toks[0] == 'du':
        return any(t == '--summarize' or (t.startswith('-') and not t.startswith('--')
                                          and 's' in t) for t in toks[1:])
    if toks[0] == 'git':
        i = 1
        while i < len(toks):
            t = toks[i]
            if t in ('-C', '-c') and i + 1 < len(toks):
                i += 2
            elif t.startswith('--') and '=' in t:
                i += 1
            else:
                break
        if i >= len(toks):
            return False
        sub, rest = toks[i], toks[i + 1:]
        if sub in USER_GIT:
            return True  # 用户显式指定的 git 子命令优先，跳过形态检查
        if sub == 'tag':
            listing = any(t in ('-l', '-n', '--list') or t.startswith('-n')
                          for t in rest)
            return not listing and any(not t.startswith('-') for t in rest)
        if sub == 'stash':
            return toks[i + 1:i + 2] not in (['list'], ['show'])
        if sub == 'branch':
            # 列表形态（裸 branch / -a / --list …）不算；新建（首参是名字）
            # 与删除/重命名（-d/-D/-m/-M）才算
            if any(t in ('-d', '-D', '-m', '-M', '--delete', '--move')
                   for t in rest):
                return True
            return bool(rest) and not rest[0].startswith('-')
        if sub == 'config':
            if any(t in ('-l', '--list') for t in rest):
                return False
            return any(not t.startswith('-') for t in rest)
        if sub == 'remote':
            return bool(rest) and rest[0] in (
                'add', 'remove', 'rm', 'rename', 'set-url', 'prune',
                'get-url', 'set-head')
        if sub == 'worktree':
            return bool(rest) and rest[0] in (
                'add', 'remove', 'prune', 'repair', 'move', 'lock', 'unlock')
        return sub in GIT_MUTATIONS
    return toks[0] in PLAIN_MUTATIONS

# 用户自定义白名单：每行 name（匹配段首命令）或 git:name（匹配 git 子命令，
# 优先于形态检查），# 开头注释；无法识别的行忽略
try:
    with open(os.environ.get('WL_FILE', ''), 'r', encoding='utf-8') as f:
        for line in f:
            entry = line.strip()
            if not entry or entry.startswith('#'):
                continue
            if re.fullmatch(r'git:[A-Za-z0-9._-]+', entry):
                USER_GIT.add(entry[4:])
                GIT_MUTATIONS.add(entry[4:])
            elif re.fullmatch(r'[A-Za-z0-9._-]+', entry):
                PLAIN_MUTATIONS.add(entry)
except OSError:
    pass

cmd = os.environ.get('CMD', '')
segs = [s for s in split_top(cmd) if s.strip()]
raise SystemExit(0 if segs and all(seg_is_pass(s) for s in segs) else 1)
PY
then
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
  echo "[rtk] 提醒（不是禁止执行）：这条命令的输出可压缩 60-90%，两种做法任选其一："
  echo "  1. 执行等价命令：$rewritten"
  echo "  2. 原样重跑本命令：直接放行"
  echo "同一命令仅提醒一次；/rtk off 可关闭提醒。"
  echo "压缩结果若缺关键行：先按输出尾部提示 rtk recall <hash> --grep <关键字> 取回（不重跑）；确需完整原文再 rtk proxy <原命令>（会真正重跑）。"
} >&2
exit 2
