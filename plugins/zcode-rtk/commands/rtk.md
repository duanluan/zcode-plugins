---
description: rtk 管理动作：/rtk on|off ｜ /rtk gain ｜ /rtk whitelist ｜ /rtk uninstall（状态看 /rtk-status，安装看 /rtk-install）。rtk（github.com/rtk-ai/rtk）把常见开发命令输出压缩 60-90%
argument-hint: <on|off|gain|whitelist|uninstall> [参数]
allowed-tools: Bash(rtk:*), Bash(cat:*), Bash(printf:*), Bash(python3:*), Bash(ls:*), Bash(command -v:*), Bash(rm:*)
---

管理真 rtk（Rust Token Killer，<https://github.com/rtk-ai/rtk>）在 ZCode 的接入。`$ARGUMENTS` 原样作为参数来源：第一个位置参数是动作。

> **状态查看请用 `/rtk-status`，安装/重装请用 `/rtk-install`**（本命令仍兼容接受 `status` / `install` 动作，转到同样流程）。

## 设计原则

"何时压缩、怎么压缩"完全由 rtk 自己的全局提示词（RTK.md）和 `rtk rewrite` 决定，本插件不自己发明压缩规则；PreToolUse 钩子按 `rtk rewrite` 的判断递改写建议，仅额外放行一层白名单——纯副作用或输出极小的命令（如 `git add`/`git commit`/`mkdir`，整条命令逐段全命中才放行），拦它们没有压缩收益，deny 提示反而会误导模型把正常命令拆散重跑。

## 动作

### on / off

`printf <hint|off> > ~/.zcode-rtk/mode`——控制 PreToolUse 钩子的改写提醒（`on` 写入 hint；`off` 后钩子放行一切，仍可手动 `rtk <命令>` 享受压缩，RTK.md 提示词也不受影响）。写完 `cat` 确认并告诉用户当前模式（hint 显示为"开启（hint）"）。

### gain

`rtk gain $ARGUMENTS 2>/dev/null || rtk stats $ARGUMENTS 2>/dev/null`——展示 rtk 自己统计的 token 节省（以实际支持的子命令为准，`rtk --help` 可查）。

### whitelist

管理钩子的低价值命令白名单（文件 `${RTK_DIR:-~/.zcode-rtk}/whitelist`，不存在视为空，改动即时生效——钩子每次执行都重读）。内置清单（git 变更类子命令 add/commit/push/branch 新建删除/merge 等、mkdir/cp/mv/rm/chmod/sleep 等纯副作用命令）不可增删，此处只管理用户追加条目，每行一条：

- `name`：匹配每段命令的首个词（如 `docker`、`terraform`，该命令全家都放行）
- `git:name`：匹配 git 子命令（如 `git:clone`），优先于内置形态检查（会跳过 branch/tag 等的列举形态检查）
- `#` 开头为注释，空行忽略；不符合 `name` / `git:name` 格式的行会被钩子静默忽略

动作：缺省 = show（列内置清单摘要、用户条目与文件路径）；`add <条目>…`（校验格式、去重追加，目录不存在先建）；`remove <条目>…`（只删用户条目，提示内置条目不可删）；`reset`（清空用户条目）。增删改用 python3 读写文件（保留注释与原有顺序），完成后 `cat` 确认并告知改动即时生效。

### uninstall

1. `printf off > ~/.zcode-rtk/mode`（停钩子提醒）
2. 用 python3 从 `~/.zcode/AGENTS.md` 删除 `<!-- rtk:start -->` 到 `<!-- rtk:end -->` 块（含标记行）
3. `rm ~/.local/bin/rtk`（可选，用户确认后）；`rm -rf ~/.zcode-rtk`

### status / install（兼容入口）

分别与 `/rtk-status`、`/rtk-install` 相同：缺省动作视为 status；status 汇总 rtk 版本与路径、钩子模式、AGENTS.md 提示词块、`rtk gain` 节省；install 按官方 install.sh（失败则 tar 包重试）装 rtk → `rtk init -g` → python3 幂等同步 RTK.md 进 AGENTS.md → `rtk rewrite "git status"` 验证。
