# 搜索能力只能做成自有 MCP 工具，接不到内置 WebSearch 上

ZCode 内置的 `WebSearch` 是 provider-native 实现（`tqr={kind:"provider_native",logicalName:"WebSearch",providerToolName:"web_search",fallback:"disabled"}`），必须由供应商或模型在服务端支持搜索；不支持时工具直接不出现，报 `Current model does not support native WebSearch`，没有回退。插件清单里没有 `tools` 字段，`ToolRegistryImpl.register` 只由内部代码调用，插件注册不了内置工具、也覆盖不了同名工具；插件给出的工具名固定是 `mcp__<server>__<tool>`。钩子侧同样走不通：`PreToolUse` 能 deny、能改入参（`updatedInput`），`PostToolUse` 只接受 `additionalContext`，全包里没有任何改写工具输出的字段，而且 `WebSearch` 不存在时 `PreToolUse` 根本不会触发。因此 web-search 的目标只能定为“新增一套自有搜索 MCP 工具”，不是替换内置搜索。

## Considered Options

- 注册搜索 provider（dsh 的 `ctx.web.registerSearchProvider` 那样）：ZCode 没有这个接缝。`ProviderRegistry` 只管模型供应商，与搜索无关；`ZCODE_EMBEDDED_SEARCH_COMMAND` 是给 Glob/Grep 换后端用的，不涉及网络搜索。
- 用 `PreToolUse(WebSearch)` 改写入参：供应商不支持原生搜索时工具不存在，钩子不触发；就算存在，改入参也换不了实际请求方。
- 用 `PostToolUse` 换掉结果：协议里没有这个字段，只有 `additionalContext`。

## Consequences

- 模型看到的是第二个搜索工具，需要技能说明“什么时候用自有工具、什么时候用内置的”；默认让自有工具补位，内置的可用时不必抢。
- 内置 WebFetch 与上游 `web_fetch` 语义不同：前者抓取后用小模型针对 `prompt` 作答并缓存 15 分钟，后者返回整页可读文本。接管前者会让上下文变大，所以不接管，只用技能引导。
- 若将来官方开放工具注册或搜索后端接缝，可重新评估。
