# zcode-plugins 开发规则

## 源码在 ui-plugins/，产物在 plugins/，改完必须构建并安装到本地

仓库结构对齐上游 zai-org/zcode-plugins：`ui-plugins/<名>/` 是插件源码（含页面源码），`plugins/<名>/` 是构建产物（安装与市场分发的就是它，不手改）。改完插件源码（新命令、技能、钩子、页面、配置等）后，必须构建、安装到本地 ZCode 并验证，才算开发完成：

```bash
pnpm build                                      # 组装全部插件：ui-plugins/* → plugins/*（含三处版本号校验）
scripts/install-plugin-local.sh <插件名>          # 同步指定插件
scripts/install-plugin-local.sh --all            # 同步 plugins/ 下全部插件
```

然后**开新会话**验证功能可用（当前会话可能还缓存着旧的命令/技能/工具清单）。

- 机制：ZCode 加载的是已安装目录 `~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/<插件名>/<版本>/` 的拷贝，改源码不会自动生效；脚本用 rsync 把 `plugins/<插件名>/` 镜像同步到该目录，不改源码版本号、不发市场。升版后重跑脚本即可：自动建新版本目录并把本地安装记录指过去。
- 版本号三处必须一致：根 `marketplace.json` 条目、`ui-plugins/<名>/.zcode-plugin/plugin.json`、`ui-plugins/<名>/package.json`，不一致 `pnpm build` 直接失败。
- 脚本报「本地还没装过该插件」时：先在 ZCode 插件市场装一次该插件（版本不一致没关系）。
- 本地安装只对本机生效。正式发布走：推送 GitHub → 插件市场源面板刷新 → 重装插件（见 README 安装节，由用户操作）。发布后本地那份会被市场版本覆盖，要保留开发中的改动就重新跑一次脚本。

## 插件配置里禁止 `${VAR:-}` 这类花括号默认值写法

ZCode 加载插件 `.mcp.json`/`hooks.json` 时会先对 `${...}` 做模板展开（实现在 `/opt/ZCode/resources/glm/zcode.cjs`）：只认精确名（如 `${ZCODE_PLUGIN_ROOT}`）；变量名带 `:-` 等后缀且以 `ZCODE_` 开头时直接抛「Missing environment variable」，**整个服务器/钩子条目被丢弃**（headroom 桥曾因此整体消失：进程不启动、工具报 Tool not found）。需要 shell 展开的变量一律写 `$VAR`（无花括号），模板正则匹配不到、会原样传给 sh 自己展开。
