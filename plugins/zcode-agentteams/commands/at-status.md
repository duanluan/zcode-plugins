---
description: 在对话里输出 AgentTeams 活动摘要卡：项目进度、成员状态、待办任务。示例：/at-status ｜ /at-status attachment-overhaul
argument-hint: [项目 ID]（缺省取第一个 active 项目）
allowed-tools: Bash(curl:*), Bash(node:*), Bash(agt:*), Read(*)
---

拉取 AgentTeams 当前状态，在**对话里**输出一张 markdown 摘要卡（这是插件在 ZCode 界面内的展示形式；完整图形界面用 `/at-dashboard`）。

## 数据获取

面板服务在线就优先复用（免配置鉴权）：

```bash
curl -s --max-time 4 "http://127.0.0.1:${AGENTTEAMS_DASHBOARD_PORT:-8712}/api/state$( [ -n "$PROJECT" ] && printf '?project=%s' "$PROJECT" )"
```

不在线则回退 CLI：

```bash
agt get projects -o json                      # 项目列表
agt get projects <项目ID> -o json             # workflow：nodes/edges/tasks_detail
```

都没有就提示 `/at-setup` 或 `/at-dashboard start`。

## 输出格式（markdown 卡片）

```
### AgentTeams · <项目名>（<active/paused>）

**进度**：已完成 x/y（运行中 a · 已派发 b · 待领取 c · 待复核 d · 已阻塞 e）
**成员**：N 名，K 人执行中

| 成员 | 状态 | 任务 | 进度 |
|---|---|---|---|
| w1 | 工作中 | t2 | 0/4 |

**接下来**：t3、t4 等 N 项等待布置（依赖 t1、t2 完成）
**提示**：<interrupts 或错误信息，没有则省略>
```

- 任务列只列任务 ID（空格分隔），别贴长名字
- 数据取不到的字段直接省略行，不要编造
- 末尾附一句：完整界面 → `/at-dashboard --float`
