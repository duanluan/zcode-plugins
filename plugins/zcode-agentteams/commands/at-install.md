---
description: 部署/卸载 AgentTeams 本体（封装官方 install.sh 非交互模式）：Docker 前置检查、LLM Key 配置、后台安装。示例：/at-install --key sk-xxx ｜ /at-install --key sk-xxx --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-5.3-flash ｜ /at-install --interactive ｜ /at-install uninstall
argument-hint: [uninstall] [--key <LLM API Key>] [--base-url <OpenAI兼容地址>] [--model <默认模型>] [--admin-password <密码>] [--interactive]
allowed-tools: Bash(docker:*), Bash(curl:*), Bash(nohup:*), Bash(mkdir:*), Bash(chmod:*), Bash(tail:*), Bash(sleep:*), Bash(grep:*), Bash(docker compose:*), Bash(command -v:*), Read(*)
---

部署 AgentTeams 本体。**它不是单文件 CLI，而是一套 Docker 容器栈**（AI 网关、Matrix 服务器、对象存储、Element Web、Manager Agent），本命令封装官方一条命令安装器（agentteams-install.sh）的非交互模式；Docker 与 LLM API Key 是仅有的两个插件无法代办的前置。

## 执行流程

### 第 0 步：参数解析

`$ARGUMENTS` 第一个位置参数若是 `uninstall` 直接跳到卸载；`--interactive` 表示想逐步自定义，跳到交互说明。**裸跑（无参数）时第一件事就是用选择题问「LLM Key 用哪种」**，三个选项：

1. **复用 ZCode 已存的 GLM Key（推荐，零输入）** → 走方式 A（`--use-zcode-key`）
2. **粘贴 GLM Key** → 走方式 B：只要求粘 Key；url/model 有默认（见第 2 步），不追问
3. **其他家的 Key** → 方式 B 变体：要求同时提供 base-url 与模型（给百炼等示例）

其余已给出的 `--key`、`--use-zcode-key`、`--base-url`、`--model`、`--admin-password` 参数照收，缺什么才问什么，一次问全（Key 建议让用户粘贴而非写入文件历史）。

### 第 1 步：前置检查（插件不代办的部分如实交还用户）

```bash
docker info && docker compose version
```

- Docker 未装：给出指引让用户自己执行（需要 sudo，**不要擅自安装**）。Manjaro：`sudo pacman -S docker && sudo systemctl enable --now docker && sudo usermod -aG docker $USER`（重新登录生效）。通用：Docker Desktop 或 Docker Engine
- `docker compose` 子命令缺失：提示安装 docker compose 插件
- 用户不在 docker 组且不想加组：后续安装命令前缀 `sudo`（env 也要一起带上去）

### 第 2 步：下载安装器并配置

> 品牌背景：**HiClaw 是 AgentTeams 更名前的旧名**（v1.2.0-beta.1 起公开更名，前代已停用）。不要再用旧入口 `higress.ai/hiclaw/install.sh`——装出来的容器/变量都是 HICLAW_* 旧品牌栈。本命令一律用官方新安装器。

```bash
mkdir -p ~/.zcode-agentteams && chmod 700 ~/.zcode-agentteams
curl -sSL https://raw.githubusercontent.com/agentscope-ai/AgentTeams/main/install/agentteams-install.sh -o ~/.zcode-agentteams/agentteams-install.sh
```

LLM 配置写入 `~/.zcode-agentteams/install.env`（权限 600，避免 Key 进 shell 历史），默认值可省略：

```bash
AGENTTEAMS_NON_INTERACTIVE=1
AGENTTEAMS_LLM_PROVIDER=openai-compat
AGENTTEAMS_OPENAI_BASE_URL=<地址，缺省用官方 Token 计划端点>
AGENTTEAMS_DEFAULT_MODEL=<模型，缺省 qwen3.6-plus>
AGENTTEAMS_LLM_API_KEY=<必填>
# AGENTTEAMS_ADMIN_PASSWORD=<不填则安装器自动生成，从日志取>
# AGENTTEAMS_VERSION=<稳定版默认 v1.1.x；更名后的 beta 需显式 opt-in（如 v1.2.0-beta.1）>
```

**Key 的两种方式**（AgentTeams 的 Worker 是常驻容器自己调模型，端点+Key 不可省，但可以不买新的）：

- **方式 A：复用 ZCode 同款 GLM Key（`--use-zcode-key`，推荐，零新购）**。ZCode 的 Key 存在 `~/.zcode/cli/config.json` 的 `provider` 节点（自定义供应商的 `options.apiKey`，按 `baseURL` 含 `bigmodel` 识别）。注意两点：① ZCode 走的是 **Anthropic 格式**端点（`/api/anthropic`），而 AgentTeams 网关要 **OpenAI 兼容**格式，所以 base-url 必须换 **Coding Plan 的 OpenAI 兼容端点** `https://open.bigmodel.cn/api/coding/paas/v4`（会员额度照常，与 ocr 委托模式复用 Key 同理）；按量用户用 `https://open.bigmodel.cn/api/paas/v4`。② 模型填会员可用的如 `glm-5.3-flash`。取 Key：
  ```bash
  jq -r '[.provider | to_entries[] | select(.value.options.baseURL // "" | test("bigmodel")) | .value.options.apiKey] | first' ~/.zcode/cli/config.json
  ```
  提取后同样只写进 600 权限的 install.env，不回显。多 Worker 并发会加速消耗这份额度，提醒用户留意
- **方式 B：独立粘贴 Key**。**默认按 GLM 处理**（本市场用户群以 GLM 为主）：base-url 缺省 `https://open.bigmodel.cn/api/coding/paas/v4`（Coding Plan 会员额度）或 `https://open.bigmodel.cn/api/paas/v4`（按量余额），model 缺省 `glm-5.3-flash`，都不用用户提供。只有用户明说 Key 是别家的，才要求提供对应 base-url 与模型（如百炼 DashScope 兼容地址）；给 `--key` 但未给 `--base-url` 时同样按 GLM 默认处理

### 第 3 步：后台安装（拉镜像需几分钟，不要傻等）

```bash
set -a; . ~/.zcode-agentteams/install.env; set +a
nohup bash ~/.zcode-agentteams/agentteams-install.sh >> ~/.zcode-agentteams/install.log 2>&1 &
```

告知用户预计时长，`sleep 30 && tail -20 ~/.zcode-agentteams/install.log` 确认已开跑即可结束本轮；后续用 `tail -f ~/.zcode-agentteams/install.log` 跟进。拉镜像失败优先想代理（`ZCODE_HTTP_PROXY`、docker 自身代理配置）。

**`--interactive`（逐步自定义）**：前台交互脚本不要代跑，告诉用户在**自己的终端**执行 `bash ~/.zcode-agentteams/agentteams-install.sh`，装完回到本命令第 4 步接线。

### 第 4 步：装完验证与接线

```bash
tail -40 ~/.zcode-agentteams/install.log        # 访问地址、生成的 admin 密码都在末尾
docker ps --format '{{.Names}}\t{{.Status}}' | grep -iE 'agentteams|hiclaw'
curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:18088   # Element Web
```

默认端口：网关 18080、网关控制台 18001、Element Web 18088、Manager 控制台 18888（`--port` 类环境变量可改）。装完默认走第 5 步自动接线；拿不到凭据时再引导执行 `/at-setup <地址>` 手动配置。

### 第 5 步：自动接线（默认尝试，失败才回退 /at-setup）

> 实操校准（v1.1.x 稳定栈）：本地 Docker 部署的 Controller 不映射宿主机端口、**不认 Matrix token**（要用容器内的 cli-token）、**没有 /api/v1/projects**（面板会自动切 teams/workers 模式，无需额外配置）。

1. **Controller token（cli-token，不是 Matrix token）**：controller 容器内置凭据文件，取出到本地（600 权限）。容器名以 `docker ps` 实际为准：官方新安装器装出 `agentteams-controller`，旧 HiClaw 栈是 `hiclaw-controller`，下面以 `<controller>` 代指：
   ```bash
   docker exec <controller> cat /var/run/hiclaw/cli-token > ~/.zcode-agentteams/controller-token
   chmod 600 ~/.zcode-agentteams/controller-token
   ```
   （旧 HiClaw 栈路径如上；官方新栈若取不到，依次试 `/var/run/agentteams/cli-token`）
2. **Controller 地址**：`docker ps --format '{{.Names}}\t{{.Ports}}' | grep -iE 'agentteams|hiclaw'`。controller 通常**无宿主端口映射**，config 直接写 `docker://<controller>`（面板服务每次请求前用 docker inspect 解析容器 IP，Docker 重启 IP 漂移也不怕）。有宿主映射时写 `http://127.0.0.1:<映射端口>`
3. **验证**（只输出状态码与数量，不回显内容）：
   ```bash
   _ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' hiclaw-controller)
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat ~/.zcode-agentteams/controller-token)" http://$_ip:8090/api/v1/managers
   curl -s -H "Authorization: Bearer $(cat ~/.zcode-agentteams/controller-token)" http://$_ip:8090/api/v1/managers | jq '.total'
   ```
   期望 200 + managers 数（通常 1）。**Matrix access token**（网关 `http://127.0.0.1:18080/_matrix/client/v3/login` 可换到，容器内 6167 宿主机不通）只在需要操作 Matrix 房间时用，**不写进面板配置**
4. **写配置并重启面板**（`<controller>` 换成第 1 步实际容器名）：
   ```bash
   cat > ~/.zcode-agentteams/config.json <<EOF
   {"controllerUrl": "docker://<controller>", "tokenFile": "~/.zcode-agentteams/controller-token", "port": 8712, "refreshSeconds": 5}
   EOF
   pkill -f "[s]erver.mjs"; sleep 0.5   # 旧实例（很可能是 demo）必须重启才会读新配置
   ```
   再按 `/at-dashboard` 的 start 后台拉起，`curl -s http://127.0.0.1:8712/api/state | jq '{mode: .config.mode, error, teams: (.projects|length), workers: (.members|length)}'` 确认 mode=hiclaw 且 error 为 null。成功就告诉用户：面板已接真实数据（http://127.0.0.1:8712），暂无 Worker 时去 Element Web（18088）让 Manager 建团队
5. 任一步失败（容器不在、token 取不到、验证非 200）：如实报告卡点，回退引导 `/at-setup` 手动填

## 密钥回显纪律（全程有效）

凡涉及密钥/token 的命令：输出重定向到文件或只取元信息（长度、HTTP 码、字段存在性），**禁止整体 cat/回显** env 文件、token 文件、登录响应；凭据经环境变量或 `docker exec` 传入，不要拼进命令行可见参数。此前实操曾把 `HICLAW_LLM_API_KEY`、admin 密码、access_token 泄进会话记录，务必避免重演。

### 卸载 uninstall

```bash
bash ~/.zcode-agentteams/agentteams-install.sh uninstall
```

停止并移除 Manager 与全部 Worker 容器；数据卷 `agentteams-data`（旧 HiClaw 栈为 `hiclaw-data`，用旧脚本 `hiclaw-install.sh uninstall`）按日志提示决定是否保留。提醒：卸载后 `/at-setup` 配置的面板会失去数据源，可切 demo 或停用。

## 结果处理

- 安装中断/失败：`tail -60 install.log` 定位（常见：Docker 没起、Key 无效 401、镜像拉取超时），修复后重跑即幂等继续
- 一切以官方文档为准：github.com/agentscope-ai/AgentTeams 的 README 快速开始
