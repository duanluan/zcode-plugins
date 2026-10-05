#!/usr/bin/env bash
# 把开发中的插件源码安装到本地 ZCode：同步进已安装目录，新会话立即加载。
# 不改源码版本号、不动插件市场；正式发布走「推送 GitHub → 市场刷新 → 重装」。
#
# 用法：
#   scripts/install-plugin-local.sh <插件名> [插件名...]   同步指定插件
#   scripts/install-plugin-local.sh --all                  同步 plugins/ 下全部插件
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKET="duanluan-zcode-plugins"
CACHE_ROOT="$HOME/.zcode/cli/plugins/cache/$MARKET"
INSTALLED_JSON="$HOME/.zcode/cli/plugins/installed_plugins.json"

manifest_version() {
  python3 - "$1" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
}

# 已安装记录里有没有这个插件（只有市场装过一次才会有记录）
has_install_record() {
  python3 - "$1" "$2" <<'PY'
import json, os, sys
p = os.path.expanduser("~/.zcode/cli/plugins/installed_plugins.json")
data = json.load(open(p)) if os.path.exists(p) else {"plugins": []}
hit = any(x.get("name") == sys.argv[1] and x.get("marketplace") == sys.argv[2] for x in data.get("plugins", []))
sys.exit(0 if hit else 1)
PY
}

# 把本地安装记录的版本与安装路径指向本次同步的目录（配合升版使用）
update_install_record() {
  python3 - "$1" "$2" "$3" "$INSTALLED_JSON" <<'PY'
import datetime, json, os, sys
name, ver, dst, p = sys.argv[1:5]
market = os.environ["MARKET"]
data = json.load(open(p))
for x in data.get("plugins", []):
    if x.get("name") == name and x.get("marketplace") == market:
        x["version"] = ver
        x["installPath"] = dst
        x["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
tmp = p + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
os.replace(tmp, p)
PY
}

sync_plugin() {
  local name="$1"
  local src="$REPO_ROOT/plugins/$name"
  local manifest="$src/.zcode-plugin/plugin.json"
  if [ ! -f "$manifest" ]; then
    echo "✗ $name：缺少 $manifest" >&2
    return 1
  fi
  if ! has_install_record "$name" "$MARKET"; then
    echo "✗ $name：本地还没装过该插件，先在 ZCode 插件市场装一次（版本不一致没关系）" >&2
    return 1
  fi
  local ver
  ver="$(manifest_version "$manifest")"
  local dst="$CACHE_ROOT/$name/$ver"
  mkdir -p "$dst"
  rsync -a --delete --exclude '.git' "$src/" "$dst/"
  MARKET="$MARKET" update_install_record "$name" "$ver" "$dst"
  echo "✓ $name $ver 已安装到本地：$dst"
}

[ $# -ge 1 ] || { echo "用法：$0 <插件名> [插件名...] | --all" >&2; exit 1; }

if [ "$1" = "--all" ]; then
  names=()
  for dir in "$REPO_ROOT"/plugins/*/; do
    names+=("$(basename "$dir")")
  done
else
  names=("$@")
fi

# 单个失败不中断整批（其余插件照常同步），最后汇总退出码
failed=0
for name in "${names[@]}"; do
  sync_plugin "$name" || failed=$((failed+1))
done

echo "提示：改动对新会话生效；当前会话可能还缓存着旧的命令/技能清单。"
if [ "$failed" -gt 0 ]; then
  echo "✗ ${failed} 个插件同步失败" >&2
  exit 1
fi
