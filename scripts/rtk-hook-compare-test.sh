#!/bin/sh
# rtk 钩子行为对照：sh 版 vs node 版，同批命令比对退出码（0=放行 2=拦截）
cd "$(dirname -- "$0")/../ui-plugins/rtk/hooks" || exit 1
rm -rf "${RTK_DIR:-$HOME/.zcode-rtk}/reminded" 2>/dev/null

run_case() { # run_case <解释器> <脚本> <命令json>
  printf '%s' "$3" | "$1" "$2" >/dev/null 2>&1
  echo $?
}

i=0
fail=0
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  i=$((i+1))
  sh_json=$(printf '{"session_id":"cmp-sh-%d","tool_input":{"command":%s}}' "$i" "$cmd")
  mjs_json=$(printf '{"session_id":"cmp-mjs-%d","tool_input":{"command":%s}}' "$i" "$cmd")
  a=$(run_case /bin/sh ./rtk-pretooluse.sh "$sh_json")
  rm -rf "${RTK_DIR:-$HOME/.zcode-rtk}/reminded" 2>/dev/null
  b=$(run_case node ./rtk-pretooluse.mjs "$mjs_json")
  rm -rf "${RTK_DIR:-$HOME/.zcode-rtk}/reminded" 2>/dev/null
  if [ "$a" = "$b" ]; then
    printf 'OK   sh=%s mjs=%s  %s\n' "$a" "$b" "$cmd"
  else
    printf 'DIFF sh=%s mjs=%s  %s\n' "$a" "$b" "$cmd"
    fail=$((fail+1))
  fi
done <<'CASES'
"rtk git status"
"git add . && git commit -m x"
"git commit -m \"a && b\""
"git status"
"ls -la /usr"
"head -20 /etc/passwd"
"cat /etc/passwd | head -5"
"ls > /tmp/out.txt"
"ls >/dev/null"
"echo $(date)"
"wget http://example.com/f"
"curl -o /tmp/f http://example.com"
"curl -s http://example.com"
"mkdir -p a/b/c"
"cd /tmp && ls"
"git branch"
"git branch -a"
"git branch newbr"
"git config --list"
"git config user.name x"
"du -s /var"
"du -sh /var"
"sed -n '1,10p' /etc/passwd"
"tail -5 /etc/hosts"
"wc -l /etc/hosts"
"sleep 3"
"echo hi"
"node --check ./x.mjs"
"cat a b c d"
CASES
echo "----"
echo "total=$i diff=$fail"
