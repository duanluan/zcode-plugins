---
description: 配置 AgentTeams 接入：Controller 地址与凭据写入 ~/.zcode-agentteams/config.json，检查 node/agt，启动活动面板。示例：/at-setup ｜ /at-setup http://127.0.0.1:8080
argument-hint: [Controller 地址]（可留空，仅检查/改配置）
allowed-tools: Bash(curl:*), Bash(node:*), Bash(mkdir:*), Bash(cat:*), Bash(command -v:*), Bash(nohup:*), Bash(read:*), Read(*), Write(*)
---

配置 AgentTeams（github.com/agentscope-ai/AgentTeams）接入并启动本地可视化活动面板。配置持久化在 `~/.zcode-agentteams/config.json`。

## 执行步骤

### 第 1 步：检查环境

```bash
command -v node && node --version    # 面板服务需要 Node ≥ 18
command -v agt || echo "agt 未安装（可选，Controller API 可直接用）"
```

- `agt` 未装不算阻塞：面板走 Controller HTTP API；`agt` 只是 CLI 透传的加分项。
  安装方式以 AgentTeams 仓库 README 为准（通常 `go install github.com/agentscope-ai/AgentTeams/cmd/agt@latest` 或发布包）。
- **本机还没部署 AgentTeams 平台本身**：先走 `/at-install` 一键部署（前置 Docker + 一个 LLM API Key），装完拿到 Controller 地址与 token 再回到本命令。

### 第 2 步：收集配置（缺什么问什么，别重复问）

1. **Controller 地址**：`$ARGUMENTS` 给了就用它；否则读现有配置；再没有才问用户（例如 `http://127.0.0.1:8080`，端口以部署为准）
2. **访问凭据**：Bearer token（K8s ServiceAccount token 或 Matrix access token），任选其一：
   - 直接存进 config（`token` 字段）
   - 只存文件路径（`tokenFile` 字段，更安全，推荐）
   - 或不落盘，用环境变量 `AGENTTEAMS_AUTH_TOKEN`（面板服务启动时读取）
3. **可选**：`team`（多团队时指定）、`port`（面板端口，默认 8712）、`refreshSeconds`（刷新间隔，默认 5）

写入配置（已存在则合并，别覆盖用户其他字段）：

```bash
mkdir -p ~/.zcode-agentteams
cat > ~/.zcode-agentteams/config.json <<'EOF'
{"controllerUrl": "<地址>", "tokenFile": "<token文件路径>", "team": null, "port": 8712, "refreshSeconds": 5}
EOF
```

**本机 Docker 部署**（`/at-install` 装的那种；旧品牌容器叫 `hiclaw-*`，官方新装为 `agentteams-*`）有现成组合，别让用户手填（`<controller>` 按实际容器名）：

```json
{"controllerUrl": "docker://<controller>", "tokenFile": "~/.zcode-agentteams/controller-token", "port": 8712, "refreshSeconds": 5}
```

`docker://容器名` 由面板服务自动 docker inspect 解析容器 IP（HiClaw controller 不映射宿主端口，且重启会换 IP）；token 用 controller 的 **cli-token**（容器内 `/var/run/hiclaw/cli-token`），**不是** Matrix access token。连通验证用 `GET /api/v1/managers`（200 即通）。

### 第 3 步：验证连通性并启动面板

```bash
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 -H "Authorization: Bearer $(cat <token文件>)" <controller>/api/v1/projects
node <插件目录>/dashboard/server.mjs --port 8712 >> ~/.zcode-agentteams/dashboard.log 2>&1 &
sleep 1 && curl -s --max-time 3 http://127.0.0.1:8712/healthz
```

- 200/401 都说明地址可达（401 = token 不对，提示检查凭据）
- 面板在线后打开 `http://127.0.0.1:8712`（浏览器小窗悬浮方案见 `/at-dashboard --float`）
- 无 Controller 也想先看界面效果：`node <插件目录>/dashboard/server.mjs --demo`

### 第 4 步（可选）：常驻

参照 headroom 的做法配 systemd 用户服务（开机自启、崩溃自重启）；`nohup` 起的进程重启电脑后会丢。SessionStart 钩子会在每次会话启动时兜底拉起（配置文件存在才启动；`AGENTTEAMS_DASHBOARD_AUTOSTART=0` 关闭）。

## 汇报

结束时给出：面板地址、数据源模式（controller / agt / demo）、连通性结果、日志位置 `~/.zcode-agentteams/dashboard.log`。
