---
description: rtk 管理动作：/rtk on|off ｜ /rtk gain ｜ /rtk uninstall（状态看 /rtk-status，安装看 /rtk-install）。rtk（github.com/rtk-ai/rtk）把常见开发命令输出压缩 60-90%
argument-hint: <on|off|gain|uninstall> [参数]
allowed-tools: Bash(rtk:*), Bash(cat:*), Bash(printf:*), Bash(python3:*), Bash(ls:*), Bash(command -v:*), Bash(rm:*)
---

管理真 rtk（Rust Token Killer，<https://github.com/rtk-ai/rtk>）在 ZCode 的接入。`$ARGUMENTS` 原样作为参数来源：第一个位置参数是动作。

> **状态查看请用 `/rtk-status`，安装/重装请用 `/rtk-install`**（本命令仍兼容接受 `status` / `install` 动作，转到同样流程）。

## 设计原则

"何时压缩、怎么压缩"完全由 rtk 自己的全局提示词（RTK.md）和 `rtk rewrite` 决定，本插件不自己发明规则；PreToolUse 钩子按 `rtk rewrite` 的判断递改写建议。

## 动作

### on / off

`printf <hint|off> > ~/.zcode-rtk/mode`——控制 PreToolUse 钩子的改写提醒（`on` 写入 hint；`off` 后钩子放行一切，仍可手动 `rtk <命令>` 享受压缩，RTK.md 提示词也不受影响）。写完 `cat` 确认并告诉用户当前模式（hint 显示为"开启（hint）"）。

### gain

`rtk gain $ARGUMENTS 2>/dev/null || rtk stats $ARGUMENTS 2>/dev/null`——展示 rtk 自己统计的 token 节省（以实际支持的子命令为准，`rtk --help` 可查）。

### uninstall

1. `printf off > ~/.zcode-rtk/mode`（停钩子提醒）
2. 用 python3 从 `~/.zcode/AGENTS.md` 删除 `<!-- rtk:start -->` 到 `<!-- rtk:end -->` 块（含标记行）
3. `rm ~/.local/bin/rtk`（可选，用户确认后）；`rm -rf ~/.zcode-rtk`

### status / install（兼容入口）

分别与 `/rtk-status`、`/rtk-install` 相同：缺省动作视为 status；status 汇总 rtk 版本与路径、钩子模式、AGENTS.md 提示词块、`rtk gain` 节省；install 按官方 install.sh（失败则 tar 包重试）装 rtk → `rtk init -g` → python3 幂等同步 RTK.md 进 AGENTS.md → `rtk rewrite "git status"` 验证。
