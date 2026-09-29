---
description: 任意 headroom 子命令全透传。示例：/hr doctor ｜ /hr dashboard ｜ /hr savings ｜ /hr wrap zcode ｜ /hr inspect ｜ /hr mcp serve
argument-hint: <子命令与参数> 如：doctor ｜ dashboard ｜ wrap zcode ｜ inspect ｜ memory stats
allowed-tools: Bash(headroom:*), Bash(command -v:*), Bash(uv:*), Bash(pipx:*), Bash(pip install*)
---

把参数原样透传给 Headroom CLI，执行 `headroom $ARGUMENTS`。覆盖 /hr-setup、/hr-status、/hr-proxy 之外的所有子命令。**参数不做任何筛选或改写。**

## 执行规则

```bash
headroom $ARGUMENTS
```

- 若 `$ARGUMENTS` 为空：展示常用子命令清单（下表 + `headroom --help`），不执行
- 若 `headroom` 未安装：按 `/hr-setup` 第 1 步的顺序安装（uv → pipx → pip）
- 前台常驻类命令（`proxy`、`dashboard`、`mcp serve`、`wrap <tool>` 等）会阻塞：放到**后台**执行（`nohup … &`）并把访问地址/日志位置告诉用户，不要傻等
- `wrap zcode` 的职责是"起代理 + 打印 ZCode 设置"；代理已由本插件管理时加 `--no-proxy` 只打印配置

## 常用子命令速查

| 子命令 | 作用 |
|---|---|
| `doctor` | 健康检查：代理与客户端路由是否正常 |
| `dashboard` | 浏览器打开实时节省报表 |
| `agent-savings` | 渲染编码代理的 token 节省报告 |
| `inspect` | 查看最近经过代理的请求：原文 vs 压缩后对比 |
| `savings` / `perf` | 节省与性能统计（以 `--help` 实际支持为准） |
| `proxy` | 前台启动代理（本插件的 /hr-proxy 已封装后台管理） |
| `wrap zcode` | 起代理并打印 ZCode 模型设置要填的地址（`--no-proxy` 只打印） |
| `unwrap zcode` | 清理对 ZCode 的持久化 wrap 配置 |
| `deploy` | 常驻部署代理（systemd/launchd 级别，进阶用法） |
| `init` | 为支持的 agent 安装持久化集成（`-g` 全局） |
| `memory list/stats` | 跨会话记忆（需 `--memory` 开启） |
| `mcp serve` / `mcp install` | 以 MCP 服务器运行 / 注册到 MCP 客户端 |
| `update` | 更新 Headroom 到最新版 |

## 结果处理

输出里若出现"代理未运行 / 路由未配置"类提示，引导用户：代理管理用 `/hr-proxy`，ZCode 界面配置步骤见 `/hr-setup` 第 4 步。
