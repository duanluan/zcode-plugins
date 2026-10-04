---
description: 管理视觉代理：/vision-proxy list ｜ follow <名> <session|供应商|off> 切换跟随供应商 ｜ add/edit/remove 增删改。useProvider=session 即跟随当前会话供应商。
argument-hint: <list|follow|add|edit|remove> [名称] [字段=值 …]
allowed-tools: Bash(python3:*), Bash(cat:*)
---

管理 `~/.zcode/zcode-vision.json` 的 `proxies` 列表（与 zcode-pro 设置面板编辑同一文件）。`$ARGUMENTS`：动作、名称、若干 `字段=值`。字段名：`name`（仅 add）、`baseUrl`、`model`、`apiKey`、`format`（openai=OpenAI Chat Completions，缺省；anthropic=Anthropic Messages）、`useProvider`（`session`=跟随当前会话供应商；或供应商名/ID——设置后 baseUrl/apiKey 自动取该供应商配置；format 优先取该供应商的接口类型（api.type），该字段缺失时用本代理的 format 兜底、再按接口地址推断）、`timeoutMs`（本代理单次识别超时毫秒数，缺省用全局 apiTimeoutMs；赠送额度级这类易失败的代理适合设短一点快速降级）、`prompt`。所有修改用 python3 完成，改完 cat 确认。

## 动作

### list（缺省）

打印：每个代理的名称/baseUrl 或 useProvider（跟随谁）/model/apiKey 是否已配（不显示值）/prompt 前 40 字，以及当前 chain 和 chainMode，标注哪些链中名称没有对应代理。

### follow <代理名> <session|供应商名或ID|off>

切换该代理的识别端点来源，专门动作、无需 edit 字段写法：

- `follow <名> session`：跟随**当前会话所用供应商**（写入 `"useProvider": "session"`），baseUrl/apiKey 自动取该供应商配置（format 同取；供应商缺接口类型时用本代理的 format 兜底）；CLI 无会话记录的场合会报错说明。
- `follow <名> <供应商名或ID>`：固定跟随指定供应商（如 `BigModel`）。
- `follow <名> off`：清除跟随（删除 useProvider），恢复用该代理自己的 baseUrl/apiKey/format。
- 改完 cat 确认，并提示：跟随模式下识别模型优先用内置「首选视觉模型」映射表（Xiaomi MiMo → `mimo-v2.6-flash`、ZCode Trust Build 赠送额度 → `GLM-5.3-Flash`、智谱系 → `glm-5.3-flash`），映射未命中或该供应商列表里没有这个模型才用代理自己的 model 字段（换识别模型用 `edit <名> model=<模型>`）；建议跑 `/vision test` 验证。

### add <名称> 字段=值…

- 追加到 proxies；`baseUrl`、`model` 必填（缺了就停下问用户），`apiKey`、`prompt` 可选。
- 新代理自动追加到 chain 末尾（fallback=兜底备用；pipeline 用户可再调整顺序，见 /vision-chain）。
- prompt 里可写 `{prev}`：pipeline 模式下会被上一步识别结果替换；不含 `{prev}` 时上一步结果会拼接在其后。

### edit <名称> 字段=值…

按名称找代理逐字段更新；名称不存在时报错并列出现有名称。prompt 值里的换行让用户写 `\n`，python3 写入时替换为真实换行。

### remove <名称>

从 proxies 和 chain 里同时移除；chain 因此为空时提醒用户 `/vision-chain set` 重新配置。

## 注意

- apiKey 是敏感信息：展示时只报「已配/未配」。
- baseUrl 按代理的 `format` 给：`anthropic`（GLM 订阅同款，如 `https://open.bigmodel.cn/api/anthropic`，自动补 `/v1/messages`）或 `openai`（如 `https://open.bigmodel.cn/api/paas/v4`，自动补 `/chat/completions`）；走本地 headroom 用 `http://127.0.0.1:8787`。
- 链中代理连续失败满 `skipAfterFailures` 次（默认 4）会被暂时跳过 `skipMinutes` 分钟（默认 30），期间 fallback 直接走下一个；这两个是全局字段，用 /vision-setup 或 zcode-pro 设置面板改，不在这里。
- 建议改完跑 `/vision test` 验证识别。
