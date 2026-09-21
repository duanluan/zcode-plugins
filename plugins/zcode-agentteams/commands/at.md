---
description: 任意 agt 子命令全透传（AgentTeams CLI）。示例：/at get projects ｜ /at get projects <id> -o json --mermaid ｜ /at project pause <id> ｜ /at spawn messages <sessionId>
argument-hint: <agt 子命令与参数> 如：get projects ｜ project pause <id> ｜ get projects <id> --mermaid
allowed-tools: Bash(agt:*), Bash(command -v:*)
---

把参数原样透传给 AgentTeams CLI，执行 `agt $ARGUMENTS`。**参数不做任何筛选或改写。**

## 执行规则

```bash
agt $ARGUMENTS
```

- `$ARGUMENTS` 为空：展示下表 + 提示 `agt --help`，不执行
- `agt` 未安装：给出安装指引（以 AgentTeams 仓库 README 为准），不擅自安装

## 常用子命令速查

| 子命令 | 作用 |
|---|---|
| `get projects` | 项目列表（`-o json` 机器可读） |
| `get projects <id> -o json` | 项目 workflow：节点/边/任务详情 |
| `get projects <id> --mermaid` | 依赖图 mermaid 文本 |
| `project pause / resume <id>` | 暂停 / 恢复项目 |
| `project replan <id>` | 触发重新规划 |
| `project cancel / complete <id>` | 取消 / 标记完成 |
| `spawn messages <sessionId>` | 查看成员会话消息流 |

## 结果处理

- 输出 JSON 时可直接解读给用户：节点状态 pending（待领取）/ delegated（已派发）/ in-progress（工作中）/ completed（已交付）/ revision（待复核）/ blocked（已阻塞）
- 报 401/403：token 失效，引导 `/at-setup` 重新配置
- 想看图形化依赖图：`/at-dashboard`（Web 面板带可交互 DAG）
