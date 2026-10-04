# zcode-plugins 术语表

ZCode 插件集（zcode-vision、headroom、rtk 等）的领域词汇。只收本项目特有概念，通用编程词汇不收。

## 视觉识别（zcode-vision）

**视觉代理（vision agent）**：
主模型不支持图片输入时代它「看图」、并把识别文字注入对话的组件。
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
支持图片输入的模型，界面以「视觉」徽标标示。
_Avoid_: 看图模型

**首选视觉模型（preferred vision model）**：
跟随供应商时优先选用的该供应商视觉小模型，由插件内置的「供应商 → 视觉模型」映射表给出；映射未命中时用识别代理条目自己的模型。
_Avoid_: 优先模型、小模型

**赠送额度级（trust-build）**：
执行链里排在最前、专门优先消耗 ZCode 每日赠送额度的识别代理条目；失败或额度用尽时自动转到链里后面的条目。
_Avoid_: 免费级
