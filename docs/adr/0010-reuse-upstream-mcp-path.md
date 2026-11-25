# web-search 复用 dsh-free-search 的 MCP 路径，不搬 dsh 插件路径

DDDMUC/dsh-free-search（MIT，0.9.86）分两套代码：dsh 插件路径依赖 `ctx.inject(["web"])` 与 dsh 的设置、工具、UI 包，共约 9k 行（`lib/index.js` 4,132 行 + `lib/client.js` 4,819 行），在 ZCode 上无法运行；MCP 路径（`bin/mcp.js` 到 `lib/mcp_server.js` 的 63 个文件、10,358 行）只有 `node:*` 引用，`package.json` 没有 dependencies，实测 `node bin/mcp.js` 直接可跑。决策：vendored 引擎层原样使用，自己写一层薄启动器，把 `~/.zcode/web-search.json` 翻译成环境变量后拉起上游 MCP 进程。

## Considered Options

- 直接 `npx -y -p dsh-free-search dsh-free-search-mcp`：可行（实测能起、能搜），但上游 MCP 路径没有任何代理配置字段，只有环境变量，而本机访问 DuckDuckGo 必须走代理；改用 npx 还得解决代理注入，等于外面再包一层，不如自己做。且跟 `latest` 会随上游改动静默变化。
- 移植 `lib/index.js` 的完整能力（冷却、多 key 轮换、multi 池、缓存键）：那 4,132 行里约 1.5~2k 是真正的逻辑，其余是 dsh 的桥接路由与提示词注入。MCP 路径已有简化版调度（`lib/mcp_engines.js:114` `runMcpEngine`，`auto` 只含 bing/ddg/ddg-lite），对这个插件的用途够用。
- 参考思路重写引擎层：39 个引擎 3,523 行，重写没有收益。

## Consequences

- 上游升级要手动改版本号并跑一次测试；锁 `0.9.86`，不跟随 latest。
- 上游 MCP 路径没有工具过滤，12 个工具的完整 schema 约 9.5k 字节会全部进工具列表。缓解方式是让用户自己把 ZCode 的“工具搜索”设为本地（实测只发名称与描述时降到 1.8k 字节，省 81%），插件不去改这个全局设置——它影响所有 MCP 工具，包括本该常驻的 serena。
- 上游只有 MIT 许可证，没有任何服务条款或抓取合法性声明，只记录了事实性风险（HTML 搜索结果页抓取触发验证码时按出口 IP 冷却）。分发时需要自行补一句声明。
