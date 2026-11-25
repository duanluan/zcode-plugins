---
description: web-search 初始化向导：生成 ~/.zcode/web-search.json，配置默认引擎与可选 API key，并用真实查询验证能搜到结果。
allowed-tools: Bash(python3:*), Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(head:*)
---

web-search 首次安装或搜索异常时运行本向导。目标产物是合法的 `~/.zcode/web-search.json`；配置改动对新会话生效（当前会话的 MCP 服务已按旧配置启动）。

日常改配置用 `/web-search-config <键>=<值>`，本向导只在首次安装或配置混乱时用。

## 步骤

1. **看现状**：`cat ~/.zcode/web-search.json`（不存在或 JSON 非法都按未初始化处理）。
   配置已存在且合法时同样要走第 3 步提问——把当前值作为默认答案标出来，用户全保持默认则零改动收尾。只有用户明确说“别问了直接保持现状”才跳过。

2. **未初始化则生成模板**（python3 写入，2 空格缩进）：

```json
{
  "engine": "anysearch",
  "maxResults": 8,
  "safeSearch": "off",
  "lang": "zh",
  "proxy": "",
  "keys": {}
}
```

字段含义见 `/web-search-config` 的表格。**`engine` 默认 `anysearch`，不要改回 `auto`**——`auto` 是 Bing → DDG → DDG-Lite 的回退链，实测这三者经常同时失败（Bing 返回空结果页、DDG 反爬限流），改回去会让搜索大面积零结果。

3. **问用户**（用 AskUserQuestion 一次问清三件事，再视需要追加第四件）。**选项文案按下面写，不要自己加评价性措辞。**

   **问题一：默认搜索引擎**
   - `anysearch（当前）` → “免 key，开箱可用。”
   - `bing` → “免 key。中文长查询偶尔返回空结果页。”
   - `ddg-lite` → “免 key。请求频繁时可能被限流。”
   - `brave / zhipu / perplexity 等（需要 key）` → “需要 API key，选这项后下一步会问你要 key。”

   写选项的三条硬规则：
   - 标签里已经标了“（当前）”的，描述里**不要**再写“当前配置就是这个”“当前值”这类话。
   - **不要写“实测最稳”“效果好”这类评价**。描述只说事实：免不免 key、有什么已知毛病。
   - 需要 key 的引擎可以列，但必须注明“需要 key”并说明下一步会索要 key，不要让用户以为选了就能用。

   **问题二：每次搜索返回多少条结果**
   - `8 条（当前）` → “信息量与上下文占用比较平衡。”
   - `3 条` → “更省上下文，适合只要一两条准确链接。”
   - `15 条` → “信息更全，但结果直接进上下文，占用明显变大。”

   **问题三：搜索请求走代理吗**
   - `空（当前，跟随系统）` → “跟随系统 http_proxy / https_proxy。”
   - `http://127.0.0.1:7897` → “固定走这个代理。系统环境变量没配代理、但访问境外引擎失败时选这个。”

   **问题四：仅当用户第一个问题选了需要 key 的引擎时才追问**
   - 先明确告知：**接下来需要你在对话里粘贴 API key**，它会以明文写进 `~/.zcode/web-search.json`，也会留在这条会话记录里；不想留痕就自己编辑该文件。
   - 用户同意后再收，按所选引擎要对应的键名（见文末键名表）。有的引擎要两个值（`google` 要 `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID`，`yandex` 要 `YANDEX_API_KEY` + `YANDEX_FOLDER_ID`），要分开问。
   - 拿到后**不要回显完整 key**，只说“已写入，末尾四位 XXXX”。
   - 用户拒绝粘贴时，把默认引擎保持原值，并告诉他稍后自己编辑文件再用 `/web-search-config engine=<名字>` 切换。

4. **写入**：只把用户真正改了的键写进文件（python3 读改写、保持 2 空格缩进），写后 `cat` 确认 JSON 合法。用户全部保持默认就明说“没有改动”，不要重写整个文件。写了 key 的配置文件权限设成 `600`。

5. **验证**：定位启动器后跑一次真实搜索：

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
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"zcode 插件","max_results":3}}}' \
 | node "$LAUNCH" 2>&1 | tail -2
```

有 `Search results for "…" via <引擎>` 且下面有 `[标题](链接)` 行即为成功。**如果用户刚配了需要 key 的引擎，确认输出里的 `via <引擎>` 就是他选的那个**——回落到别的引擎说明 key 没生效，按 `/web-search-test` 一节的报错表排查。

6. **收尾**：告诉用户下面这些。**分清楚哪些必需、哪些可选**，不要把可选项说成必须做。

   **必知（不这么做会出问题）**
   - 配置改完要**开新会话**才生效——MCP 服务在会话启动时按旧配置拉起，当前会话读不到新值。

   **命令一览**
   - 改单项：`/web-search-config <键>=<值>`；看全部配置项：`/web-search-config`
   - 看状态：`/web-search`；诊断引擎：`/web-search-doctor`；验证：`/web-search-test`

   **可选（不做也能正常用）**
   - **省 token**：ZCode 设置里的“工具搜索”改为“本地”后，这 12 个工具的 schema 从每轮约 9.5 KB 降到约 1.8 KB（只发名称和描述，用到时再取完整说明）。**这是可选项，不改也能用**；它是全局设置，会影响所有 MCP 工具的加载方式，新建会话生效。不要主动替用户改，把选择权留给用户。
   - **优先用内置的**：内置 `WebSearch` 可用时先用它（供应商原生实现，不占工具列表、不走 MCP 往返）。本插件是补位——内置不可用、或内置 `WebFetch` 抓不动页面时再用。这条是使用建议，不是安装要求。

## 键名表

`keys` 的键名直接写环境变量名。单值引擎：

`BRAVE_API_KEY`、`EXA_API_KEY`、`TAVILY_API_KEY`、`ZHIPU_API_KEY`、`PERPLEXITY_API_KEY`、`SERPER_API_KEY`、`SERPBASE_API_KEY`、`SERPLY_API_KEY`、`OUTCRAWL_API_KEY`、`TINYFISH_API_KEY`、`FIRECRAWL_API_KEY`、`JINA_API_KEY`、`KEENABLE_API_KEY`、`PARALLEL_API_KEY`、`YDC_API_KEY`、`MOONSHOT_API_KEY`、`DASHSCOPE_API_KEY`、`DOUBAO_SEARCH_API_KEY`、`METASO_API_KEY`、`ZHIHU_API_KEY`、`SPECSTREAM_API_KEY`、`BAIDU_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`。

两值引擎：`google` → `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_ID`；`yandex` → `YANDEX_API_KEY` + `YANDEX_FOLDER_ID`；`yuanbao` → `TENCENTCLOUD_WSA_APIKEY`。

自建服务：`MCP_SEARXNG_INSTANCES`（实例地址）、`MCP_SEARXNG_BEARER_TOKEN`（可选鉴权）、`MCP_DEGOOG_INSTANCES`。

## 安全提示

key 一旦粘贴到对话里，就进了会话记录（`~/.zcode/cli/db/db.sqlite`），删不掉也撤不回。收尾时要提醒用户：如果介意，可以在配完后去对应平台**重置这把 key**，再重新配一次，或者一开始就选择自己编辑文件。

