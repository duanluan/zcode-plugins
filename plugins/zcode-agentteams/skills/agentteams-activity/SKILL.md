---
name: agentteams-activity
description: AgentTeams 多智能体协作平台的活动可视化与 CLI 接入。当用户提到"AgentTeams / 多智能体团队 / 队长派任务 / 成员状态 / 项目进度 / 任务依赖图 / 活动面板"，或想看项目里各智能体在干什么、任务依赖进展时使用。面板在本地 127.0.0.1:8712，数据来自 Controller 只读 API 或 agt CLI。
---

# AgentTeams 活动面板

AgentTeams（github.com/agentscope-ai/AgentTeams）是 Manager-Workers 多智能体协作平台：队长把项目拆成任务 DAG 派发给成员，成员在 Matrix 房间协作。本插件提供它的**本地可视化活动面板**与 **agt CLI 透传**。

## 快速判断与动作

0. **还没部署 AgentTeams 本体**（本机没有 Controller、`docker ps` 里没有 agentteams/hiclaw 容器）：`/at-install --use-zcode-key` 一键部署（封装官方 agentteams-install.sh 非交互模式；前置 Docker + LLM Key），装完再 `/at-setup` 接线
1. **面板是否在跑**：`curl -s --max-time 2 http://127.0.0.1:8712/healthz`
   - 在线：让用户打开 [http://127.0.0.1:8712](http://127.0.0.1:8712)，或用 `/at-dashboard --float` 开悬浮小窗
   - 不在线：`/at-dashboard start`（演示效果用 `/at-dashboard demo`）
2. **没配置过**（`~/.zcode-agentteams/config.json` 不存在或面板 mode 为 none）：走 `/at-setup`，需要 Controller 地址与 Bearer token
3. **对话内看摘要**：`/at-status`（markdown 进度卡，不需要开浏览器）
4. **CLI 操作**：`/at <子命令>` 全透传——`get projects`、`get projects <id> -o json --mermaid`、`project pause/resume/replan/cancel/complete`

## 面板内容（对应 Controller API）

| 面板区块 | 数据来源 |
|---|---|
| 项目卡（成员数/完成度/消息数） | `GET /api/v1/projects` + workflow 节点统计 |
| 队长卡（派发数/执行中人数） | workflow 的 requester/team_id + 节点聚合 |
| 总进度条 | 节点状态计数：pending/delegated/in-progress/completed/revision/blocked |
| 成员卡（状态/进度/派发任务） | tasks_detail 按 assigned_to 聚合 + `GET .../spawns` 会话状态 |
| 任务依赖 DAG（悬停高亮依赖链/点击固定） | workflow 的 nodes + edges |
| 底部任务详情（负责人/等待依赖/解锁下游/工件） | 节点 + tasks_detail + 工件下载端点 |

数据获取优先级：AgentTeams Controller HTTP API（projects 模型，`AGENTTEAMS_CONTROLLER_URL` + Bearer token）→ **本地 Docker 控制面**（`/at-install` 装的稳定栈：teams/workers/managers 模型，面板展示队长/成员实时状态；config 写 `docker://<controller容器名>` + 容器内 cli-token）→ `agt get projects -o json` 兜底 → demo 演示数据。

## 注意

- 端口/刷新间隔在 `~/.zcode-agentteams/config.json`（port / refreshSeconds / team），环境变量 `AGENTTEAMS_DASHBOARD_PORT` 可覆盖端口
- 401/403 = token 失效，重跑 `/at-setup`；Controller 未启动时报错会显示在面板顶部横幅
- SessionStart 钩子只在已配置（config.json 存在）时静默拉起面板，`AGENTTEAMS_DASHBOARD_AUTOSTART=0` 关闭
- 面板只读；暂停/取消等写操作走 `/at`（agt CLI）或 Controller 写端点
