---
description: web-search 连通性验证：/web-search-test [查询词] 跑一次真实搜索，确认默认引擎有结果。
argument-hint: [查询词]
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*)
---

跑通整条搜索链，确认当前配置下能真的搜到东西。默认查询词 `zcode 插件`。

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

2. 发起一次搜索：

```sh
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"<查询词>","max_results":3}}}' \
 | node "$LAUNCH" 2>&1 | tail -2
```

输出可能很长。如果结果被输出压缩工具截断，把原始输出写到 `/var/tmp` 下的文件再读，不要基于残缺输出下判断。

3. 判断结果并转述“用的哪个引擎、几条结果”。

## 成功的标志

输出里有 `Search results for "…" via <引擎>`，且下面是 `[标题](链接)` 行。

## 失败时按报错判断

| 报错 | 含义与下一步 |
|---|---|
| `bing: no results` | Bing 返回了空结果页（HTTP 200 但 `b_algo` 块为 0）。换引擎：`/web-search-config engine=anysearch` |
| `DuckDuckGo is rate-limited` | DDG 反爬限流，换引擎 |
| `requires XXX_API_KEY` | 默认引擎需要 key 但没配，用 `/web-search-setup` 配 |
| `抓取失败：目标站点返回了浏览器错误页（ERR_xxx）` | 这是 `web_fetch` 的报错，不是搜索；该站点拒绝本地出口，换源 |
| 完全没有输出 | 启动器找不到上游，检查 `/web-search-doctor` |
| 输出里的 `via <引擎>` 和配置的 `engine` 不一致 | key 没生效或引擎回落，跑 `/web-search-doctor` 看该引擎状态 |
