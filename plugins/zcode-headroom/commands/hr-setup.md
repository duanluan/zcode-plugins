---
description: 一键接入 Headroom 压缩代理：检查/安装 headroom、启动代理（上游默认 GLM）、给出 ZCode 模型设置要填的地址并验证。示例：/hr-setup ｜ /hr-setup --port 8787 ｜ /hr-setup --skip-install
argument-hint: [--port <端口>] [--skip-install] [--upstream-anthropic <url>] [--upstream-openai <url>]
allowed-tools: Bash(headroom:*), Bash(curl:*), Bash(command -v:*), Bash(nohup:*), Bash(pgrep:*), Bash(uv:*), Bash(pipx:*), Bash(pip install*)
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

## 第 2 步：启动代理（后台、上游指向 GLM）

```bash
ANTHROPIC_TARGET_API_URL=https://open.bigmodel.cn/api/anthropic \
nohup headroom proxy --port 8787 >> ~/.zcode-headroom-proxy.log 2>&1 &
```

- **只设 Anthropic 上游**：ZCode 侧必须用 Anthropic（Messages）格式；OpenAI/Chat Completions 格式无法用于 bigmodel——headroom 转发保留客户端 `/v1` 前缀，bigmodel 无该路径（必 404）
- 端口被占用时：`curl -s http://127.0.0.1:8787/` 有响应就复用现有代理，**不要重复拉起**（SessionStart 钩子也会做同样的事）
- 用户给了 `--upstream-anthropic` 时替换对应 env；给了 `--port` 时同步替换
- 也可用官方命令起代理并打印 ZCode 配置（不重复起代理）：`headroom wrap zcode --no-proxy --port 8787`

## 第 3 步：验证代理

```bash
sleep 2; headroom doctor
```

- `doctor` 会检查代理与客户端路由状态；有报错先看 `~/.zcode-headroom-proxy.log`
- 连通性抽查：`curl -s http://127.0.0.1:8787/ | head -c 200`

## 第 4 步：新建自定义供应商（必须用户在界面操作，逐步给出）

> headroom 官方支持 ZCode，但 ZCode 自带的「智谱」供应商走内部 OAuth、接入地址写死，**无法改指代理**——所以必须新建一个自定义供应商。rtk/headroom 的全局提示词管"怎么压"，这一步管"流量从哪走"，缺它压缩为零。

在 ZCode 中：**设置 → 模型设置 → 供应商列表底部「+ 添加供应商」**，逐项填写（与已验证可用的配置一致）：

1. **名称**：`BigModel`（自定义供应商区内，随意，如 `BigModel-Headroom`）
2. **API 格式**：选 **Anthropic Messages (/v1/messages)** ——不要选 Chat Completions（经 headroom 转发保留 `/v1` 前缀，bigmodel 无该路径，必 404）
3. **Base URL**：`http://127.0.0.1:8787`
4. **API Key**：粘贴你现有的 GLM API Key（代理原样转发鉴权头，会员额度照常）
5. **模型列表 →「+ 添加模型」**：`glm-5.3`，再添加 `glm-5.3-flash`（与直连时相同的模型 ID）
6. 保存，点 **「已启用」**；聊天界面的模型选择器里选该供应商下的模型
7. 自带的「智谱」供应商**保留不动**——它就是回退开关，切回即"关闭"压缩

## 第 5 步：验证

- `headroom doctor`：应看到 ZCode 相关流量；`headroom agent-savings` / `headroom dashboard` 看节省
- 插件已通过 `.mcp.json` 注册官方 `headroom mcp serve` 服务器（MCP 名称 `plugin:zcode-headroom:headroom`）——这是 headroom 官方的代理侧集成：CCR 压缩标记可通过 `headroom_retrieve` 工具按需取回原文，无需额外配置

## 第 6 步：汇报

- 当前代理端口与上游地址、日志位置（`~/.zcode-headroom-proxy.log`）
- 节省查看：`/hr-status` 或 `headroom dashboard`（浏览器实时报表）
- 回退方式：在 ZCode 模型设置里切回自带「智谱」供应商即可；彻底停代理用 `/hr-proxy stop`

## 常见问题

- **404 Not Found（上游返回 path=/v4/v1/... 之类）**：ZCode 供应商的 API 格式选成了 Chat Completions——改成 Anthropic（Messages）即可
- **看不到节省数据**：检查聊天时选的模型是否属于自定义供应商（Base URL 127.0.0.1:8787），而不是自带「智谱」——自带供应商走内部直连，不经过代理
- **起代理后 401/模型不存在**：检查 ZCode 供应商里 API Key 与模型 ID 是否和直连时一致；确认代理启动命令带了 `ANTHROPIC_TARGET_API_URL` 指向 `https://open.bigmodel.cn/api/anthropic`
- **想让 ZCode 不经过代理**：模型设置里切回自带「智谱」供应商（或用 `headroom unwrap zcode` 清理官方 wrap 的持久化配置）
