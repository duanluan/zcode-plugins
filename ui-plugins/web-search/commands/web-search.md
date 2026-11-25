---
description: web-search 状态查看：/web-search 显示当前配置与已配的 key。改配置用 /web-search-config，首次安装或配置混乱用 /web-search-setup，验证用 /web-search-test，诊断引擎用 /web-search-doctor。
allowed-tools: Bash(python3:*), Bash(cat:*)
---

查看 web-search 的当前配置状态。**只读，不修改任何东西。**

## 步骤

1. 读配置：

```sh
cat ~/.zcode/web-search.json 2>&1
```

2. 向用户汇总：

- **常用项**：`engine`（未设置时默认 anysearch）、`maxResults`（默认 8）、`safeSearch`（默认 off）、`lang`（默认 zh）、`proxy`（未设置时跟随系统 `http_proxy`/`https_proxy`）
- **已配的 API key**：只报“已配 / 未配”和它对应的引擎，**绝不显示 key 的值**
- **其他已设置的项**：如有 `maxResponseChars`、`bingMarket`、`browserFetch`、`searxngInstances`、`degoogInstances`、`allowFakeIpCidrs`、`cacheDir` 等，逐项列出
- 配置文件不存在时说明“还没配置过，用的是默认值：免 key 引擎都可用”

3. 结尾给出下一步可用命令：

- 改单项：`/web-search-config`（不带参数看全部项）
- 首次安装或配置混乱：`/web-search-setup`
- 验证能否搜到：`/web-search-test`
- 看各引擎可用状态：`/web-search-doctor`

## 注意

- 配置改完要**开新会话**才生效（MCP 服务在会话启动时按旧配置拉起）。用户如果刚改过，提醒一句。
- 内置 `WebSearch` 可用时优先用内置的；本插件的工具在模型侧叫 `mcp__plugin_web-search_search__*`。
