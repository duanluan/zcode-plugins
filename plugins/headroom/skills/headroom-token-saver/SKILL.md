---
name: headroom-token-saver
description: 通过 Headroom 本地压缩代理减少 ZCode 的 token 消耗。当用户提到"省 token / token 太贵 / 消耗太快 / headroom / 压缩代理 / 给请求加代理"或想查看节省报表时使用。代理在本机 127.0.0.1:8787，上游默认智谱 GLM open.bigmodel.cn，凭据原样转发。
---

# Headroom 压缩代理接入

Headroom 是本地运行的 LLM 压缩代理：ZCode → headroom(127.0.0.1:8787) → 智谱 GLM。工具输出、日志、大 JSON 会被压缩后再发给模型，token 消耗显著下降；鉴权头原样转发，GLM 会员额度照常使用。本插件已带 SessionStart 钩子自动拉起代理。

## 快速判断与动作

1. **代理是否在跑**：`curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8787/`；未监听且装了 headroom 时手动拉起：`ANTHROPIC_TARGET_API_URL=https://open.bigmodel.cn/api/anthropic OPENAI_TARGET_API_URL=https://open.bigmodel.cn/api/paas/v4 nohup headroom proxy --port 8787 >> ~/.zcode-headroom-proxy.log 2>&1 &`
2. **健康与节省**：`headroom doctor`、`headroom agent-savings`；实时报表 `headroom dashboard`
3. **完整接入**（含在 ZCode 界面添加供应商的步骤）：走 `/hr-setup`
4. **代理管理**：`/hr-proxy start|stop|status|restart`；任意子命令：`/hr <...>`

## ZCode 侧接入（只能用户在界面操作：新建自定义供应商）

自带的「智谱」供应商走内部 OAuth、地址写死，无法改指代理，**必须新建自定义供应商**：设置 → 模型设置 → 「+ 添加供应商」→ API 格式选 **Anthropic Messages (/v1/messages)** → Base URL `http://127.0.0.1:8787` → API Key 填原 GLM Key → 模型列表添加 `glm-5.3`、`glm-5.3-flash` → 保存并启用，聊天时选该供应商。自带「智谱」保留为回退。插件同时注册了官方 `headroom mcp serve`（CCR 取回工具 headroom_retrieve）。

## 注意

- headroom 未安装时按 `uv tool install --python 3.13 "headroom-ai[all]"` → pipx → pip 顺序安装
- 停代理会导致指向 127.0.0.1:8787 的供应商断连，提醒用户切回直连
- 压缩默认保守（cache 模式优先保 prefix-cache 命中率）；`headroom inspect` 可对比原文与压缩结果
