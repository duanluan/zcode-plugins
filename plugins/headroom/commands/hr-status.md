---
description: 查看 Headroom 代理状态、健康检查与 token 节省报告。示例：/hr-status ｜ /hr-status --no-doctor ｜ /hr-status --dashboard
argument-hint: [--no-doctor] [--dashboard]
allowed-tools: Bash(sh:*), Bash(headroom:*), Bash(curl:*), Bash(pgrep:*), Bash(command -v:*), Bash(ls:*)
---

检查 Headroom 压缩代理与本机接入状态，汇报 token 节省情况。**`$ARGUMENTS` 原样作为参数来源**（`--no-doctor`、`--dashboard`），按下方约定使用。

## 检查项（依次执行，汇总成一张小表）

1. **已安装**：`command -v headroom && headroom --version`
2. **代理在跑**：`curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8787/livez`（**不要探测根路径 `/`，会挂起**；未响应再 `pgrep -af "headroom proxy"` 看进程是否在但端口不同）
3. **后端与电源**（有插件脚本时一条命令出全）：

```bash
HR_HOOK=$(ls ~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/headroom/*/hooks/ensure-proxy.sh 2>/dev/null | tail -1)
[ -n "$HR_HOOK" ] && sh "$HR_HOOK" status
```

4. **健康检查**：`headroom doctor`（用户传 `--no-doctor` 时跳过）
5. **节省报告**：`headroom agent-savings`（或报错时改试 `headroom savings` / `headroom perf`，以本机版本实际支持的子命令为准）
6. **实时报表**：`headroom dashboard` 会用浏览器打开（用户传 `--dashboard` 或主动要求时才执行）

## 输出格式

| 检查项 | 状态 | 备注 |
|---|---|---|
| headroom 版本 | ✓ 0.37.0 | |
| 代理 127.0.0.1:8787 | ✓ 在线 | 日志 ~/.zcode-headroom-proxy.log |
| 压缩后端 | auto（显卡）/ cpu | 电源状态 + 省电自动切换开关 + 监视器 |
| doctor | ✓ 通过 / ✗ 原因 | |
| 累计节省 | … token（…%） | 来自 agent-savings |

末尾给一句结论：代理是否可用、ZCode 是否已接入（若 doctor 提示客户端路由未配置，提醒用户按 `/hr-setup` 第 4 步在模型设置里添加指向 `http://127.0.0.1:8787` 的供应商）。
