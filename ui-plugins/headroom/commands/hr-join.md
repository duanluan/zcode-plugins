---
description: 多供应商压缩路由管理：把任意自定义供应商（中转站/官方）接入 headroom 压缩，统一 baseUrl 为 127.0.0.1:8787，按 API key 自动路由。示例：/hr-join ｜ /hr-join list ｜ /hr-join off <供应商名>
argument-hint: [list | off <供应商名>]
allowed-tools: Bash(node:*), Bash(python3:*), Bash(curl:*), Read(~/.zcode/*), Read(~/.headroom/*)
---

管理 headroom 多供应商压缩路由（ZCode ≥ 3.15 桌面端与本命令无关联，纯配置层）。

**架构**：所有接入的供应商 baseUrl 统一改成 `http://127.0.0.1:8787`（本地路由器）。路由器按请求头里的 API key 哈希识别供应商 → 转给该供应商对应的 headroom 实例（内部按"格式+上游"分组共享）→ headroom 压缩后把鉴权**原样透传**给真实上游。key 明文不落插件配置，只存 sha256。

**兼容性约束（先读再动）**：
- `format=anthropic` 的上游：任意 URL 形态都兼容（请求打到 `<上游>/v1/messages`）
- `format=openai` 的上游：必须是 **/v1 形态**（请求打到 `<上游>/v1/chat/completions`，baseURL 以 `/v1` 结尾或等价）。GLM 官方 openai 接口是 `/api/paas/v4`（/v4 形态）**不兼容**——GLM 供应商请用其 anthropic 地址 `https://open.bigmodel.cn/api/anthropic` 接入
- 同一 API key 不能接入两个不同上游（路由按 key 区分），命令会做冲突检查

## /hr-join（无参）：列出可接入的供应商并引导接入

1. **读当前状态**：

```bash
node ~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/headroom/*/hooks/hr-multi.mjs status
```
（输出 `legacy` = 还没接入过任何供应商，走旧单实例代理。）

2. **读 ZCode 供应商配置（两个文件都要读）**：
   - `~/.zcode/v2/config.json` 的 `provider` 映射：普通自定义供应商（id 不以 `builtin:` 开头）的定义——名称、`options.baseURL`、`options.apiKey`、models
   - `~/.zcode/v2/provider_config.json`：`config.providerOrder` 是**界面上实际可见的供应商 id 名单**；`config.providerConfigRules.providerRules` 是各供应商的密钥与地址覆盖。**模板供应商（带 templateId，如 Xiaomi MiMo）只在这里有定义，config.json 的 provider 映射里没有**
   - **供应商是否还活着以 providerOrder 为准**：id 不在 providerOrder 里的（界面早已删除、定义残留在 config.json）不列入接入清单、不做任何改动，汇报时提一句"发现 N 个残留定义，要清理可删 config.json 对应键"即可
   - key 与真实 baseUrl 优先取 providerRules 里该供应商的 `config.access.apiKey` / `config.api.baseUrl`，取不到再回退 config.json 的 options
   - 逐个列出可接入供应商：名称、id、真实 baseUrl、key 长度（不显示明文）、模型数。跳过已接入的（id 出现在 ~/.zcode/headroom.json 的 providers 里）

3. **判定每个供应商的接入格式**（展示给用户）：
   - baseURL 含 `anthropic` → `anthropic`
   - baseURL 以 `/v1` 结尾（标准中转站）→ `openai`
   - GLM 官方 `/api/paas/v4` → 标注"openai 不兼容，建议用 anthropic 地址接入"，需用户确认
   - 拿不准 → 问用户该上游是 Anthropic Messages 还是 OpenAI Chat Completions 协议

4. **用户选定后**，用 python3 做三件事（对每个选中的供应商）：
   - 冲突检查：`sha256(apiKey)` 不得与 `~/.zcode/headroom.json` providers 里已有的 keyHash 重复，重复则停止并说明
   - 改动前备份到**被改文件的同目录**：`~/.zcode/v2/config.json.hr-join.bak`、`~/.zcode/v2/provider_config.json.hr-join.bak`（每次接入刷新；改哪个文件就必须有哪个文件的备份，改完用 `ls` 确认备份真的写出来了）
   - `~/.zcode/headroom.json` 追加：`{"id": 供应商id, "name": 名称, "upstream": 原 baseURL, "format": 判定格式, "keyHash": sha256(apiKey), "origBaseURL": 原 baseURL}`（保留该文件其他键）
     （providers 的字段结构被 zcode-pro 的 helper.mjs 与 zcode-vision 的 vision-lib.mjs（各有一份 headroomFormatOf）按本表读取来判定协议，改结构时三处同改）
   - 把该供应商的 baseUrl 改为 `http://127.0.0.1:8787`，**落点按类型**：普通自定义供应商改 config.json 的 `options.baseURL`；模板供应商改 provider_config.json 里对应 providerRules 条目的 `config.api.baseUrl`（其余字段一律不动）
   - 模板供应商的 providerRules 条目**同时补写 `config.api.type`**（format 为 anthropic → anthropic-messages，format 为 openai → openai-chat-completions）：地址改成 127.0.0.1:8787 后不再带协议线索，下游按地址推断协议的代码（zcode-pro 面板的供应商列表、视觉代理的请求端点等）会失效，必须有显式类型

5. **若是首次接入（此前 status 输出 legacy）**：先停旧单实例再让路由器接管 8787：

```bash
node <插件目录>/hooks/ensure-proxy.mjs stop
node <插件目录>/hooks/hr-multi.mjs ensure
```

（非首次直接 `hr-multi.mjs ensure`：路由器按请求读配置，追加供应商无需重启即可路由。）

6. **验证**（key 用该供应商的真实 key，证明"路由 → 实例 → 真实上游"全通）：
   - anthropic 格式：`curl -sS -m 30 -X POST http://127.0.0.1:8787/v1/messages -H "x-api-key: <key>" -H "Content-Type: application/json" -d '{"model":"<该供应商任一模型>","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'`
   - openai 格式：同上打 `/v1/chat/completions`，鉴权头用 `Authorization: Bearer <key>`
   - 期望：上游真实应答（200 或上游自身报错均可，说明已到达上游）；502 + "未接入 headroom 压缩路由" = key 路由没配上，检查 keyHash
7. **告知用户**：重启 ZCode（或新开会话）后该供应商走压缩；`/hr-join off <名称>` 随时还原。

## 自动创建供应商（想接入的上游还没有对应供应商时）

适用：从未建过 bigmodel 自定义供应商、或想为某个上游新建一个走压缩的供应商。结构模板（与真实自定义供应商逐字段一致）：

```json
{ "name": "<显示名>", "kind": "anthropic|openai-compatible（按 format 映射：anthropic→anthropic、openai→openai-compatible；kind=openai 是 Responses 协议，chat/completions 上游必须 openai-compatible）", "source": "custom",
  "options": { "apiKey": "<key>", "baseURL": "http://127.0.0.1:8787", "apiKeyRequired": true },
  "models": { "<模型id>": { "name": "<显示名>" } } }
```

步骤（python3 改 `~/.zcode/v2/config.json`，先备份为 config.json.hr-join.bak，id 用 uuid4）：
1. 向用户确认：显示名、上游 URL、协议格式、API key、要添加的模型 id 清单
2. **GLM 一键场景**（用户说"接 GLM/智谱压缩"）：上游 `https://open.bigmodel.cn/api/anthropic`、kind=anthropic、模型清单**整体复制 `provider["builtin:bigmodel"].models`**（自带 reasoning/limit 卡片），只让用户给 key 和名称
3. 其他上游：模型按用户给的 id 清单建最小卡 `{ "name": id }`（limits 等卡片可后续界面补全）
4. 注册映射到 ~/.zcode/headroom.json：`upstream` = 真实上游、`origBaseURL` = 真实上游（这样 `/hr-join off` 会把它还原成**直连供应商**而不是删除；用户想删供应商去界面删）
5. 让新供应商在界面可见（改 `~/.zcode/v2/provider_config.json`，先备份）：把新 id 追加进 `config.providerOrder`，并在 `providerConfigRules.providerRules` 补一条——providerId、providerName、`config.access.apiKey`、`config.api.baseUrl` = http://127.0.0.1:8787、`config.api.type` 按 kind 映射（anthropic → anthropic-messages，openai-compatible → openai-chat-completions）、personalModelIds / modelOrder 填模型清单。改完用户界面仍看不到的话，回退界面手建
6. `hr-multi.mjs ensure`（首次接入先 `ensure-proxy.mjs stop`）→ 按无参流程第 6 步的验证方式实测一条消息 → 告知重启 ZCode 生效

## /hr-join list

`hr-multi.mjs status` + headroom.json providers 汇总成表：供应商、上游（截断）、格式、实例端口、运行状态。

## /hr-join off <供应商名>

1. python3：从 headroom.json providers 移除该条目；把该供应商的 baseUrl 还原为 `origBaseURL`——普通自定义供应商改 config.json 的 `options.baseURL`，模板供应商改 provider_config.json 里对应 providerRules 条目的 `config.api.baseUrl`
2. `hr-multi.mjs restart`（释放对应实例；仍被其他供应商共享的实例不受影响）
3. 若移除后 providers 为空：`hr-multi.mjs stop` + `ensure-proxy.mjs ensure` 回到旧单实例代理
4. 告知用户重启 ZCode 生效

## 旧 GLM 单实例迁移（首次使用时必须一次做全）

检测 config.json 中 `baseURL` 含 `127.0.0.1:8787` 但不在 headroom.json providers 里的供应商（旧代理时代：baseUrl 指 8787、上游固定 GLM anthropic）。

**硬性约束：指 8787 的供应商必须一次性全部注册映射，路由器才能接管 8787。** 漏掉任何一个，它的 key 路由器不认识，所有请求 502 断流（用户会看到"该 API key 未接入 headroom 压缩路由"）。步骤：

1. 列出**全部**指 8787 的未注册供应商，向用户展示清单并确认（默认 upstream=`https://open.bigmodel.cn/api/anthropic`、format=anthropic；若某个的 key 其实是别家中转的，向用户核实真实上游）
2. 一次性把清单全部写入 headroom.json（此时路由器尚未接管，旧实例继续服务，无中断）
3. 切换前若旧实例由 systemd 单元托管（hr-setup 曾建过 headroom-proxy.service）：先
   `systemctl --user disable --now headroom-proxy`——多实例模式下 8787 由路由器接管，
   单元的自动重启会反复抢端口；插座机自启的旧单元同理
4. 然后才执行 `ensure-proxy.mjs stop` → `hr-multi.mjs ensure` 完成切换
5. 提醒两点：切换瞬间正在流式输出的回答会断一次（旧实例被停）；挑空闲时刻做
6. 之后用户再把厂商 URL 直连的供应商逐个接入即可（互不影响）
