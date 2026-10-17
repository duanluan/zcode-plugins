# ADR-0004：仓库结构对齐上游 zcode-plugins（ui-plugins/ 源码 + plugins/ 产物）

- 状态：已采纳（2026-10-14）
- 影响范围：仓库布局、构建脚本、安装流程（pnpm-workspace.yaml、scripts/build-plugins.mjs、marketplace.json）

## 背景

上游 zai-org/zcode-plugins 已把带 UI 的插件改为两层结构：`ui-plugins/<名>/` 放源码，`plugins/<名>/` 放构建产物，`pnpm build` 组装并校验三处版本号（marketplace 条目、产物 plugin.json、源码 package.json）一致。本仓库原先是 `plugins/<名>/` 直接放源码、零构建。引入交互页面（TypeScript + `@modelcontextprotocol/ext-apps` 页面 SDK）后必须有构建步骤；同时希望以后能直接同步上游页面 SDK 升级，并把插件往官方仓库提 PR。

## 决策

- 目录对齐上游：源码（含页面 TS）在 `ui-plugins/<名>/`；`plugins/<名>/` 由 `scripts/build-plugins.mjs` 组装生成（复制源码资产、运行插件自带 `scripts/build.mjs` 打包页面、写 build-info.json 完成标记），从此是生成物，不再手改。
- 市场清单 `source` 与本地安装脚本继续指向 `plugins/`，用户安装路径不变。
- 根 pnpm workspace 只收 `ui-plugins/*`；devDependencies（esbuild、页面 SDK、typescript）放根。
- 服务端不跟上游技术栈：上游用 `@modelcontextprotocol/sdk` + TS + 全量打包，本仓库服务端保持手写 stdio JSON-RPC 零依赖（vision-mcp.mjs 同款），构建只用于页面。对齐的是目录与产物关系，不是实现方式。

## 后果

- 开发循环多一步 `pnpm build`（AGENTS.md 开发规则已同步更新）；忘记构建时安装的是旧产物，构建脚本的版本一致性校验能拦住版本号漏改。
- 与上游分叉点明确：目录结构可同步，服务端实现不同；将来往官方仓库提 PR 时，涉及服务端的代码需要按上游技术栈重写。
- `plugins/` 里历史遗留的源码文件语义变化（变成生成物），对 git 而言是复制不改名， blame 历史可延续。
