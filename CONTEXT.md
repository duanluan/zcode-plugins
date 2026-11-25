# zcode-plugins 术语表

ZCode 插件集（zcode-vision、headroom、rtk、open-code-review）的领域词汇。只收本项目特有概念，通用编程词汇不收。

## UI 插件（通用，ZCode ≥ 3.15.1 桌面本地工作区）

**交互页面（page）**：
插件提供的 HTML 页面，作为 `ui://` 资源由插件的 MCP 服务返回，在 ZCode 桌面端会话里渲染；经 `@modelcontextprotocol/ext-apps` 页面 SDK 与宿主通信。
_Avoid_: 面板组件、webview

**侧栏面板（surface）**：
清单 `ui.surfaces` 声明的、会话侧栏里的常驻页面入口（如 rtk 输出查看器、headroom 压缩记录）。
_Avoid_: 侧边栏、dock

**内嵌卡片（inline card）**：
附着在 MCP 工具结果上、随对话流展示的页面（如 vision_ask 的图片卡片），由工具 `_meta.ui.resourceUri` 指定。
_Avoid_: 消息卡片、气泡

**UI 服务（UI server）**：
插件里为页面提供 `ui://` 资源与页面工具的 MCP 服务端（如 rtk-ui、headroom-ui、ocr-ui）。
_Avoid_: UI 后台、页面服务进程

**页面工具（app-only tool）**：
只给交互页面调用、不进模型工具列表的工具，声明 `_meta.ui.visibility: ["app"]`。
_Avoid_: 内部工具、私有工具

**评审条目（finding）**：
ocr 评审结果的一条结构化意见（文件、行号、严重级、摘要、详情），由 ocr_render_review 工具写入、评审面板展示。
_Avoid_: 评审点、问题项

## 网页搜索（web-search）

**引擎（engine）**：
一个具体的搜索来源（Bing、DuckDuckGo Lite 等），接收查询、返回标题、链接与摘要。
_Avoid_: 渠道、搜索源

**免 key 引擎（keyless engine）**：
不需要 API key、直接请求公开页面的引擎，如 Bing、DuckDuckGo 的 html 与 lite 版本。
_Avoid_: 免费引擎（“免费”容易与额度免费混在一起）

**引擎回退（engine fallback）**：
一个引擎失败时依次换下一个，直到拿到结果或全部失败；失败分为额度、鉴权、反爬、网络、响应异常几类，反爬会让整个引擎家族按出口 IP 冷却一段时间。
_Avoid_: 轮询、故障转移

**自有搜索工具（own search tool）**：
插件通过 MCP 提供、名字形如 `mcp__plugin_web-search_search__web_search` 的搜索工具，与内置 WebSearch 并存。
_Avoid_: 替代搜索（内置工具无法被替代，见 ADR-0009）

**薄启动器（thin launcher）**：
插件里读取配置文件、设置环境变量、再拉起上游 MCP 服务进程的脚本。上游只认环境变量，这一层负责把配置文件翻译过去。
_Avoid_: 代理、桥（bridge 在 headroom 语境另有含义）

**工具搜索（tool search）**：
ZCode 官方设置 `toolSearchMode`，控制 MCP 工具是先只发送名称与描述、用到时再取完整 schema，还是一次性发全。开关是全局的，新建会话才生效。
_Avoid_: 延迟加载（指机制时可用，指这个设置时用“工具搜索”）

## 视觉识别（zcode-vision）

**视觉代理（vision agent）**：
主模型不支持图片输入时代它“看图”、并把识别文字注入对话的组件。
_Avoid_: 识图器、图像模块

**识别代理条目（proxy）**：
一条识别端点配置：名称、模型、接口地址、API Key、请求格式、识别提示词。
_Avoid_: 通道、节点、源

**执行链（chain）**：
识别代理条目的执行顺序与编排模式：fallback=依次尝试到成功，pipeline=逐级加工。
_Avoid_: 流水线（专指 pipeline 模式时不避）

**跟随供应商（useProvider）**：
识别代理条目不自填连接信息，改为引用某个供应商（特殊值 session=当前会话供应商）解析出接口地址、API Key 与请求格式。
_Avoid_: 跟随模式、代理跟随

**供应商（provider）**：
ZCode 里配置的模型服务来源，带接口地址、API Key 与模型清单。
_Avoid_: 厂商（厂商指公司主体，不指配置条目）

**请求格式（format）**：
识别端点的 API 协议形状：anthropic（Anthropic Messages）或 openai（OpenAI Chat Completions）。
_Avoid_: 协议、接口类型（api.type 是配置字段名，不是术语）

**视觉模型（vision model）**：
支持图片输入的模型，界面以“视觉”徽标标示。
_Avoid_: 看图模型

**首选视觉模型（preferred vision model）**：
跟随供应商时优先选用的该供应商视觉小模型，由插件内置的“供应商 → 视觉模型”映射表给出；映射未命中时用识别代理条目自己的模型。
_Avoid_: 优先模型、小模型

**赠送额度级（trust-build）**：
执行链里排在最前、专门优先消耗 ZCode 每日赠送额度的识别代理条目；失败或额度用尽时自动转到链里后面的条目。
_Avoid_: 免费级
