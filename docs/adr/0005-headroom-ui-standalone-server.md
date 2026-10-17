# ADR-0005：headroom 的 UI 走独立服务，不改 bridge.mjs

- 状态：已采纳（2026-10-14）
- 影响范围：plugins/headroom（新增 mcp/ui-server.mjs 与 .mcp.json 服务条目）

## 背景

headroom 插件的 MCP 工具由外部 Python 包 headroom 提供，插件侧经 bridge.mjs 单例桥复用一个服务进程（多客户端共享、initialize 应答缓存、取消通知改写、通知广播）。UI Plugin 要求提供 `ui://` 资源的 MCP 服务，但桥的设计是原样转发，headroom 本体不认识 `ui://` 资源请求。桥在近期提交（6a79bfc）刚修复过握手竞争、取消路由与通知去重失效，属于刚稳定下来的核心路径。

改桥（拦截 resources/list、resources/read 自应答）可以让所有走桥的插件共享资源服务，但要动核心转发逻辑，回归风险高、测试面大。

## 决策

headroom 的 UI 走插件内新增的独立 MCP 服务（`headroom-ui`）：自己提供 `ui://` 资源与页面工具；需要取回压缩原文等已有能力时，作为桥的另一个客户端连接复用，或调用 headroom CLI。bridge.mjs 一行不改。

## 后果

- 桥的稳定性不受影响，回归面缩小为新增服务自身。
- 插件在桌面端会多一个常驻 stdio 服务进程（仅启用插件时加载）。
- 页面的 `callServerTool` 只能调自己服务的工具：headroom 本体工具（如 headroom_retrieve）不能被页面直接调，必须经 headroom-ui 包装转发——这是宿主的安全边界，不是缺陷。
- 若将来多个走桥的插件都需要 UI，再评估把资源应答下沉进桥（届时另立 ADR，并补桥的回归测试）。
