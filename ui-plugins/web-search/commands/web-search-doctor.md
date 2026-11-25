---
description: web-search 引擎诊断：/web-search-doctor 列出全部引擎的可用状态（ready / 需要哪个 key），并指出当前默认引擎是否可用。
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*)
---

查各引擎在**当前环境**下能不能用。只读配置与环境，不修改任何配置。

## 步骤

1. 定位启动器：

```sh
LAUNCH="$(python3 -c "
import json, os
p = os.path.expanduser('~/.zcode/cli/plugins/installed_plugins.json')
try:
    rec = json.load(open(p))
except Exception:
    rec = {}
for x in rec.get('plugins', []):
    if x.get('name') == 'web-search' and x.get('installPath'):
        print(os.path.join(x['installPath'], 'mcp', 'launch.mjs'))
        break
" 2>/dev/null)"
# 安装记录读不到时退回扫缓存目录（取版本号最大的）
[ -n "$LAUNCH" ] || LAUNCH="$(ls -d ~/.zcode/cli/plugins/cache/*/web-search/*/mcp/launch.mjs 2>/dev/null | sort -V | tail -1)"
```

找不到时用源码仓库 `/home/njcm/workspaces/my/projects/zcode/zcode-plugins/ui-plugins/web-search/mcp/launch.mjs`。

2. 跑 doctor 工具：

```sh
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"doctor","arguments":{}}}' \
 | node "$LAUNCH" 2>&1 | tail -2
```

## 转述要求

- 分两组列出：**ready**（可以直接用）和 **needs key**（缺哪个 key）。不要把 43 个引擎原样贴给用户，按 ready / 缺 key 归类后给数量与名单。
- 指出当前默认引擎是否在 ready 列表里。不在就直接说“当前默认引擎 X 不可用，缺 Y”，并给出改法：`/web-search-config engine=<可用的>`
- 结尾提示：需要 key 的引擎怎么配，见 `/web-search-setup`。
