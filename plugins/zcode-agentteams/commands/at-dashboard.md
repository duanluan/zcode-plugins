---
description: 管理 AgentTeams 活动面板（本地 Web 界面：项目/队长/成员/任务依赖 DAG）。示例：/at-dashboard status ｜ /at-dashboard start ｜ /at-dashboard --float ｜ /at-dashboard demo ｜ /at-dashboard stop
argument-hint: <start|stop|status|restart|demo> [--port <端口>] [--float]
allowed-tools: Bash(node:*), Bash(curl:*), Bash(nohup:*), Bash(pgrep:*), Bash(pkill:*), Bash(mkdir:*), Bash(command -v:*), Bash(wmctrl:*), Bash(xdotool:*), Bash(chromium:*), Bash(chrome:*), Bash(google-chrome:*), Bash(microsoft-edge:*), Read(*)
---

管理 AgentTeams 本地可视化活动面板进程。第一个位置参数是动作（`start|stop|status|restart|demo`，缺省视为 `status`）。

## 通用约定

- 端口：`${AGENTTEAMS_DASHBOARD_PORT:-8712}`（`--port` 可覆盖）
- 服务脚本：`<插件目录>/dashboard/server.mjs`（Node ≥ 18，零依赖）
- 日志：`~/.zcode-agentteams/dashboard.log`；配置：`~/.zcode-agentteams/config.json`

## 动作

### status

```bash
curl -s --max-time 2 http://127.0.0.1:<port>/healthz
curl -s --max-time 2 http://127.0.0.1:<port>/api/config
pgrep -af "dashboard/server.mjs" || true
```

汇报：是否在线、数据源模式（controller / hiclaw / agt / demo / none）、面板地址。`mode` 为 `none` 时提示先跑 `/at-setup`。**模式与配置不符要提醒重启**：`~/.zcode-agentteams/config.json` 里 controllerUrl 非空但 `/api/config` 的 mode 是 demo/none，说明在跑的是旧实例（比如装完平台后没重启面板）——`stop` 后 `start` 即接上真实数据。

### start

先探测端口，**已有服务在线则告知并跳过**；否则后台启动：

```bash
nohup node <插件目录>/dashboard/server.mjs --port <port> >> ~/.zcode-agentteams/dashboard.log 2>&1 &
```

`sleep 1` 后探测 `/healthz` 确认在线；失败展示日志最后 15 行。成功后输出面板地址 [http://127.0.0.1:8712](http://127.0.0.1:8712)。

### demo

用 `--demo` 参数启动（演示数据，复刻面板示例场景，无需 Controller）：先确认 8712 上是否已有真实数据服务，有则换端口（如 8713）再启，避免顶掉真实数据。

### stop

```bash
pkill -f "dashboard/server.mjs" && echo 已停止 || echo 没有在运行的面板
```

之后探测端口确认已下线。

### restart

依次 stop、start。

### `--float`：悬浮小窗（配合 start）

面板完整界面在浏览器里，`--float` 把它开成无边框小窗并尽量置顶，效果近似"悬浮在 ZCode 旁边"：

```bash
# 1) 选一个浏览器（chromium/chrome/edge 任一）
BROWSER=$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v microsoft-edge)
"$BROWSER" --app=http://127.0.0.1:<port> --window-size=440,960 --window-position=40,60 >/dev/null 2>&1 &
# 2) X11 下置顶（Wayland 上 wmctrl 无效，改用桌面环境的窗口规则）
sleep 2 && command -v wmctrl >/dev/null 2>&1 && wmctrl -r "AgentTeams" -b add,above
```

注意：`--app` 模式是独立无标签页窗口；Wayland 会话置顶可能不生效，告知用户可用系统窗口规则（如 KDE 窗口规则）替代。
