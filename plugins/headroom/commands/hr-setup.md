---
description: 一键接入 Headroom 压缩代理：检查/安装 headroom、启动代理（上游默认 GLM）、给出 ZCode 模型设置要填的地址并验证。示例：/hr-setup ｜ /hr-setup --port 8787 ｜ /hr-setup --skip-install
argument-hint: [--port <端口>] [--skip-install] [--upstream-anthropic <url>] [--upstream-openai <url>]
allowed-tools: Bash(headroom:*), Bash(node:*), Bash(curl:*), Bash(command -v:*), Bash(nohup:*), Bash(pgrep:*), Bash(uv:*), Bash(pipx:*), Bash(pip install*), Bash(pip:*), Bash(pip3:*), Bash(py:*)
---

一键把 Headroom（本地 LLM 压缩代理，官方支持 ZCode）接到当前 ZCode：装好 → 起代理 → 给出要在 ZCode 界面里填的地址 → 验证。**`$ARGUMENTS` 原样作为参数来源**（`--port`、`--skip-install`、`--upstream-*`），各步骤按下方约定使用，不做改写。

## 背景（照此向用户解释）

- Headroom 是本地运行的压缩代理：ZCode → headroom(127.0.0.1:8787) → 智谱 GLM。请求先被压缩（工具输出、日志、大 JSON 等），再转发给模型，token 消耗显著下降；凭据原样转发，GLM 会员额度照常用。
- ZCode 是桌面应用，从设置界面读 API 配置，所以**最后一步必须用户在界面里填一次**，Agent 只能代劳其余全部。

## 第 1 步：确认 headroom 已安装

```bash
command -v headroom && headroom --version
```

未安装时按顺序尝试（任一成功即止）：
1. `uv tool install --python 3.13 "headroom-ai[all]"`
2. `pipx install "headroom-ai[all]"`
3. `pip install --user "headroom-ai[all]"`（要求 Python ≥ 3.10）

Windows 上没有 `command -v`/`uv`/`pipx` 时：`where headroom` 确认，未装则用 `py -m pip install "headroom-ai[all]"`（或 `python -m pip install …`）。

## 第 2 步：启动代理（上游指向 GLM，开机自启优先）

**Windows：没有 systemd，直接用插件脚本**（经插件启动器拉起，无需预装 node，自动带上 CPU/省电配置与电源监视器）：

```powershell
cmd /c "<插件目录>\hooks\runtime.cmd" "<插件目录>\hooks\ensure-proxy.mjs" start
# 插件目录形如 C:\Users\<用户>\.zcode\cli\plugins\cache\duanluan-zcode-plugins\headroom\<版本>
```

**Linux/macOS 优先：systemd 用户服务**（开机自启、随登录拉起、崩溃自动重启——`nohup` 起的进程重启电脑后会丢失，导致 ZCode 提示"重新连接中"）：

```bash
HR=$(command -v headroom || echo "$HOME/.local/bin/headroom")
mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/headroom-proxy.service <<UNIT
[Unit]
Description=Headroom compression proxy (127.0.0.1:8787 -> GLM)
After=network-online.target

[Service]
ExecStart=$HR proxy --port 8787
Environment=ANTHROPIC_TARGET_API_URL=https://open.bigmodel.cn/api/anthropic
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload && systemctl --user enable --now headroom-proxy
```

用户配置了 CPU 压缩时（`~/.zcode/headroom.json` 的 `kompressBackend` 非 `"auto"`），在 `[Service]` 段再加一行 `Environment=HEADROOM_KOMPRESS_BACKEND=<该值>` 后重跑 `daemon-reload && restart headroom-proxy`。**省电自动切换（`powerSaveCpu` 为 `battery`/`saver`）无需写进单元**：插件的电源监视器会在需要时经 `systemctl --user set-environment` + `restart` 切换（若单元里手写了 `HEADROOM_KOMPRESS_BACKEND`，请把配置文件的 `kompressBackend` 设成同值，避免监视器反复改写）。

**已接入或计划接入多供应商路由（/hr-join）的机器不要建这个 systemd 服务**：路由器接管 8787 后，systemd 的自动重启会反复拉起旧单实例、和路由器抢 8787 端口。多供应商模式由插件每次会话自动拉起路由器与实例（SessionStart 钩子），不需要 systemd。

systemd 不可用（无 systemd 用户会话）时退回插件脚本（自动带上 CPU/省电配置与电源监视器）：

```bash
<插件目录>/hooks/runtime.cmd <插件目录>/hooks/ensure-proxy.mjs start    # 旧版插件只有 .sh 时改用 sh …/ensure-proxy.sh start
# 都找不到脚本时退回：
ANTHROPIC_TARGET_API_URL=https://open.bigmodel.cn/api/anthropic \
nohup headroom proxy --port 8787 >> ~/.zcode-headroom-proxy.log 2>&1 &
```

- 端口被占用时：`curl -s http://127.0.0.1:8787/livez` 有响应就复用现有代理，**不要重复拉起**（SessionStart 钩子也会做同样的事；不要探测根路径 `/`，会挂起）
- 用户给了 `--upstream-anthropic` 时替换 env；给了 `--port` 时同步替换
- 也可用官方命令起代理并打印 ZCode 配置（不重复起代理）：`headroom wrap zcode --no-proxy --port 8787`

## 第 3 步：验证代理

```bash
sleep 2; headroom doctor
```

- `doctor` 会检查代理与客户端路由状态；有报错先看 `~/.zcode-headroom-proxy.log`
- 多供应商路由模式下 `doctor` 可能报 "proxy not reachable"——它按单实例方式探测 8787，而 8787 已被路由器接管。此时以 `hr-multi.mjs status` 或 `curl -s http://127.0.0.1:8787/livez`（应回 `hr-multi-router`）为准，不要据此回退
- 连通性抽查：`curl -s http://127.0.0.1:8787/livez | head -c 200`

## 第 4 步：供应商接入（经 /hr-join；"已指向 8787"不等于"已接入"）

> headroom 官方支持 ZCode，但 ZCode 自带的「智谱」供应商走内部 OAuth、接入地址写死，**无法改指代理**——压缩流量必须走自定义供应商。rtk/headroom 的全局提示词管"怎么压"，这一步管"流量从哪走"，缺它压缩为零。

**判定"已接入"的唯一标准：`~/.zcode/headroom.json` 的 providers 里注册了该供应商的映射。** baseURL 已经是 127.0.0.1:8787 不算——那可能只是旧单实例代理时代的存量配置，路由器接管 8787 后没有注册映射的 key 一律 502 断流。

先读 `~/.zcode/v2/config.json` 的 provider 映射、`~/.zcode/v2/provider_config.json`（`config.providerOrder` 是界面可见名单、`providerConfigRules.providerRules` 存各供应商的密钥与地址覆盖——**模板供应商如 Xiaomi MiMo 只在这里有定义**）与 `~/.zcode/headroom.json`，对照后按三种情形处理（**供应商是否还活着以 providerOrder 为准**：不在其中的残留定义不列入、不动；**可并存，逐一走完才算本步完成**）：

- **情形 A：一个自定义供应商都没有** → 按 `/hr-join` 的"自动创建供应商"一节新建（GLM 一键场景：kind=anthropic、上游 `https://open.bigmodel.cn/api/anthropic`、模型清单整体复制 builtin:bigmodel 的 models 映射，用户只给名称和 key）。自动创建失败（结构不符/被应用改写）才走下面的界面手建。
- **情形 B：自定义供应商已指向 8787、但 headroom.json 里没有它的映射**（旧单实例代理时代的存量）→ 按 `/hr-join` 的"旧 GLM 单实例迁移"一节**一次性全部注册**（默认上游 `https://open.bigmodel.cn/api/anthropic`，需向用户逐个核实），然后 `ensure-proxy.mjs stop` → `hr-multi.mjs ensure` 让路由器接管 8787。**硬性约束：指 8787 的必须一次全部注册，漏一个它的所有请求就 502。**
- **情形 C：自定义供应商直连厂商 URL**（mimo、中转站等，完全没经过压缩）→ **逐个询问用户要不要接入，不许静默跳过**；要接的按 `/hr-join` 无参流程做：判定格式（anthropic 任意形态可用；openai 须 /v1 形态）、注册映射（记录 origBaseURL 以便还原）、改 baseURL 为 8787、`hr-multi.mjs ensure`、用真实 key 实测一条消息。

处理完在汇报里列出三张清单：已接入 / 待接入（用户暂缓）/ 用户放弃。

界面手建回退（仅情形 A 自动创建失败时），在 ZCode 中：**设置 → 模型设置 → 供应商列表底部「+ 添加供应商」**，逐项填写（与已验证可用的配置一致）：

1. **名称**：`BigModel`（自定义供应商区内，随意，如 `BigModel-Headroom`）
2. **API 格式**：选 **Anthropic Messages (/v1/messages)** ——不要选 Chat Completions（经 headroom 转发保留 `/v1` 前缀，bigmodel 无该路径，必 404）
3. **Base URL**：`http://127.0.0.1:8787`
4. **API Key**：粘贴你现有的 GLM API Key（代理原样转发鉴权头，会员额度照常）
5. **模型列表 →「+ 添加模型」**：`glm-5.3`，再添加 `glm-5.3-flash`（与直连时相同的模型 ID）
6. 保存，点 **「已启用」**；聊天界面的模型选择器里选该供应商下的模型
7. 自带的「智谱」供应商**保留不动**——它就是回退开关，切回即"关闭"压缩

## 第 5 步：验证

- `headroom doctor`：应看到 ZCode 相关流量；`headroom agent-savings` / `headroom dashboard` 看节省
- 插件已通过 `.mcp.json` 注册官方 `headroom mcp serve` 服务器（MCP 名称 `plugin:headroom:headroom`）——这是 headroom 官方的代理侧集成：CCR 压缩标记可按需取回原文，无需额外配置。取回时必须用 MCP 全名 `mcp__plugin_headroom_headroom__headroom_retrieve`；裸名 `headroom_retrieve` 是代理注入给模型的别名，ZCode 无法执行（报 Tool not found），模型用裸名失败时提醒它换全名重试

## 第 6 步：汇报

- 当前代理端口与上游地址、日志位置（`~/.zcode-headroom-proxy.log`）
- 供应商接入状态三张清单（已接入 / 待接入 / 用户放弃）；直连厂商未接入的供应商（如 mimo、中转站）要点名提示"可用 /hr-join 接入压缩"
- 节省查看：`/hr-status` 或 `headroom dashboard`（浏览器实时报表）
- 回退方式：在 ZCode 模型设置里切回自带「智谱」供应商即可；彻底停代理用 `/hr-proxy stop`

## 常见问题

- **404 Not Found（上游返回 path=/v4/v1/... 之类）**：ZCode 供应商的 API 格式选成了 Chat Completions——改成 Anthropic（Messages）即可
- **看不到节省数据**：检查聊天时选的模型是否属于自定义供应商（Base URL 127.0.0.1:8787），而不是自带「智谱」——自带供应商走内部直连，不经过代理
- **起代理后 401/模型不存在**：检查 ZCode 供应商里 API Key 与模型 ID 是否和直连时一致；确认代理启动命令带了 `ANTHROPIC_TARGET_API_URL` 指向 `https://open.bigmodel.cn/api/anthropic`
- **想让 ZCode 不经过代理**：模型设置里切回自带「智谱」供应商（或用 `headroom unwrap zcode` 清理官方 wrap 的持久化配置）
