---
description: 查看 rtk 状态：版本、改写提醒状态、全局提示词同步、token 节省统计。示例：/rtk-status ｜ /rtk-status --json（参数原样传给 rtk gain）
argument-hint: [--json]
allowed-tools: Bash(rtk:*), Bash(cat:*), Bash(command -v:*), Bash(grep:*), Bash(ls:*), Bash(readlink:*)
---

检查真 rtk（<https://github.com/rtk-ai/rtk>）在本机 ZCode 的接入状态。`$ARGUMENTS` 原样透传给节省统计命令（如 `--json`）。

## 检查项（依次执行，汇总成一张小表）

```bash
rtk --version 2>/dev/null || echo 未安装
command -v rtk
cat ~/.zcode-rtk/mode 2>/dev/null || echo hint
grep -c 'rtk:start' ~/.zcode/AGENTS.md 2>/dev/null || echo 0
cat ~/.zcode-rtk/whitelist 2>/dev/null || echo 空
rtk gain $ARGUMENTS 2>/dev/null | tail -8 || rtk stats $ARGUMENTS 2>/dev/null | tail -8 || true
```

## 输出格式

| 检查项 | 状态 | 备注 |
|---|---|---|
| rtk 版本 | ✓ 0.49.0 | 路径 ~/.local/bin/rtk |
| 改写提醒状态 | 开启（hint）/ 关闭（off） | off 时一切命令都不提醒，手动 `rtk <命令>` 不受影响 |
| 全局提示词 | 已同步 / 未同步 | `~/.zcode/AGENTS.md` 中 `<!-- rtk:start/end -->` 块 |
| 白名单 | N 条自定义 / 未自定义 | `~/.zcode-rtk/whitelist`（低价值命令直接放行不提醒，`/rtk whitelist` 管理） |
| 累计节省 | … tokens（…%） | rtk 自身统计（gain），最近命令可见时一并列出 |

## 结论与引导

- 全部 ✓：一句"rtk 接入正常"即可，不啰嗦
- **未安装** → 引导 `/rtk-setup`
- **提示词未同步** → 引导 `/rtk-setup`（或说明下次会话启动时会自动同步）
- **模式关闭** → 提示 `/rtk on` 可恢复改写提醒
