---
description: 管理 Headroom 本地代理进程：启动（上游默认 GLM）/停止/状态/重启。示例：/hr-proxy status ｜ /hr-proxy start --port 8787 ｜ /hr-proxy stop ｜ /hr-proxy restart
argument-hint: <start|stop|status|restart> [--port <端口>] [--upstream-anthropic <url>] [--upstream-openai <url>]
allowed-tools: Bash(headroom:*), Bash(curl:*), Bash(nohup:*), Bash(pgrep:*), Bash(pkill:*)
---

管理本机 Headroom 压缩代理进程。**`$ARGUMENTS` 原样作为参数来源**：第一个位置参数是动作（`start|stop|status|restart`，缺省视为 `status`），`--port`、`--upstream-*` 等其余参数按下方约定使用，不做改写。

## 通用约定

- 端口：`${HEADROOM_PROXY_PORT:-8787}`（`--port` 可覆盖）
- 上游默认：Anthropic → `https://open.bigmodel.cn/api/anthropic`，OpenAI → `https://open.bigmodel.cn/api/paas/v4`（`--upstream-*` 可覆盖）
- 日志：`~/.zcode-headroom-proxy.log`

## 动作

### status

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 http://127.0.0.1:<port>/
pgrep -af "headroom proxy" || true
```

汇报：端口是否有响应、进程 PID、日志最后 5 行（出错时）。

### start

先探测端口，**已有服务在线则告知并跳过（不重复拉起）**；否则后台启动：

```bash
ANTHROPIC_TARGET_API_URL=<anthropic上游> \
OPENAI_TARGET_API_URL=<openai上游> \
nohup headroom proxy --port <port> >> ~/.zcode-headroom-proxy.log 2>&1 &
```

启动后 `sleep 2` 再探测一次，确认在线；失败则展示日志最后 15 行定位原因。

### stop

```bash
pkill -f "headroom proxy" && echo 已停止 || echo 没有在运行的代理
```

之后探测端口确认已下线。**注意**：停止代理后，ZCode 里指向 `http://127.0.0.1:<port>` 的供应商会断连——提醒用户切回直连供应商，或尽快重新 start。

### restart

依次执行 stop、start，并汇报新旧端口状态。
