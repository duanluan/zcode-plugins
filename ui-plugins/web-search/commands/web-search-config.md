---
description: web-search 配置查看与修改：/web-search-config（列出全部配置项） ｜ /web-search-config <键>（查单项） ｜ /web-search-config <键>=<值>（改单项）。
argument-hint: [键[=值]]
allowed-tools: Bash(python3:*), Bash(cat:*), Bash(ls:*)
---

改 web-search 的配置。配置文件是 `~/.zcode/web-search.json`，没有参数时列出全部配置项。

## 三种用法

| 输入 | 行为 |
|---|---|
| `/web-search-config` | **列出全部配置项**，每项显示当前值与默认值（文件里没写的标“默认”） |
| `/web-search-config <键>` | 显示该键当前值、默认值、含义和取值范围 |
| `/web-search-config <键>=<值>` | 校验后写入配置文件，cat 确认 |

不带参数时必须把下表全部 13 个键都列出来，不能只列文件里已有的——用户要知道有哪些项可配。

## 配置项

| 键 | 含义 | 默认 | 范围 |
|---|---|---|---|
| `engine` | 默认搜索引擎 | anysearch | 任意引擎名，见下 |
| `maxResults` | 每次搜索的默认结果条数 | 8 | 1–20 |
| `safeSearch` | 安全搜索 | off | off / moderate / strict |
| `lang` | 结果语言偏好 | zh | zh / en / ru / ja / de / fr / es / ko |
| `proxy` | 搜索走的代理；空 = 跟随 `http_proxy`/`https_proxy` | 空 | 形如 `http://127.0.0.1:7897` |
| `maxResponseChars` | 单个工具结果返回给模型的字符上限 | 48000 | 正整数，越大越占上下文 |
| `bingMarket` | Bing 市场（仅 `engine` 为 bing 时生效） | 空 | 如 `zh-CN` |
| `browserFetch` | 抓取时是否用无头浏览器（抓 JS 渲染页、过挑战） | true | true / false |
| `searxngInstances` | 自建 SearXNG 实例地址，可多个 | 空 | 逗号分隔 URL |
| `searxngBearerToken` | 自建 SearXNG 的鉴权令牌 | 空 | 字符串 |
| `degoogInstances` | 自建 Degoog 实例地址，可多个 | 空 | 逗号分隔 URL |
| `allowFakeIpCidrs` | 允许抓取的私有网段（Clash fake-ip 场景才需要） | 空 | 逗号分隔 CIDR |
| `cacheDir` | research 文档缓存目录 | `~/.cache/dsh-free-search` | 绝对路径 |

**引擎名**：免 key 的 `anysearch`、`searxng`、`exa`、`tavily`、`keenable`、`firecrawl`、`parallel`、`you`、`bing`、`ddg`、`ddg-lite`；要 key 的 `brave`、`zhipu`、`perplexity`、`google`、`baidu`、`metaso`、`yandex`、`yuanbao`、`serper`、`jina`、`kimi`、`aliyun`、`doubao` 等。`auto` 是上游的 Bing → DDG → DDG-Lite 回退链，**实测这三者经常同时失败**，不建议用。完整清单和实时可用状态跑 `/web-search-doctor`。

## 校验规则

- 拼错的引擎名（如 `engine=anyshearch`）要拒绝，给出相近的合法名
- 越界数值（如 `maxResults=30`）要拒绝并说明范围
- `safeSearch` 只接受 off / moderate / strict；`browserFetch` 只接受 true / false；`lang` 只接受上面列的 8 种
- 写入后用 python3 校验 JSON 合法，再 cat 确认
- **不收 key 类字段**（`keys` 里的 API key 走 `/web-search-setup` 或手动编辑文件）

## 收尾

**必须提醒用户开新会话**：MCP 服务在会话启动时按旧配置拉起，当前会话读不到新值。
