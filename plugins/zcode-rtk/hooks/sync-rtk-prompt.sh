#!/bin/sh
# SessionStart：rtk 升级后官方提示词（~/.claude/RTK.md）可能变化，
# 与 ~/.zcode/AGENTS.md 中同步块不一致时自动重同步。静默、幂等、fail-open。
command -v python3 >/dev/null 2>&1 || exit 0
[ -f "$HOME/.claude/RTK.md" ] || exit 0
python3 - <<'PY' 2>/dev/null || exit 0
import pathlib
src = pathlib.Path.home() / '.claude/RTK.md'
dst = pathlib.Path.home() / '.zcode/AGENTS.md'
body = src.read_text().strip()
start, end = '<!-- rtk:start -->', '<!-- rtk:end -->'
old = dst.read_text() if dst.exists() else ''
if start in old:
    pre, _, rest = old.partition(start)
    inner, _, post = rest.partition(end)
    if inner.strip() == body:
        raise SystemExit(0)  # 已一致，不写盘
    new = pre + start + '\n' + body + '\n' + end + post
else:
    new = (old.rstrip() + '\n\n' if old.strip() else '') + start + '\n' + body + '\n' + end + '\n'
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(new)
PY
exit 0
