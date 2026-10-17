---
name: rtk-source-compression
description: rtk（github.com/rtk-ai/rtk）命令输出压缩：常见开发命令（git/ls/cat/grep/find/cargo/npm 等 100+）输出压缩 60-90%。当 PreToolUse 钩子给出 "[rtk] 改用以下等价命令" 提示时照做；或用户提到 "rtk / 输出太长 / 省 token" 时使用。
---

# rtk —— 命令输出压缩（rtk 官方集成）

rtk 是单二进制 CLI 代理：`rtk <命令>` 对 100+ 常见开发命令的输出做 60-90% 压缩，保留全部信号、去掉噪音；压缩结果自带恢复路径（尾部标注被隐藏行数与 hash，`rtk recall <hash>` 可按需取回被隐藏的行，`rtk proxy <原命令>` 可取完整原始输出）。退出码语义保留（rtk 有约定时以压缩输出内说明为准）。

## 行为准则

1. **全局提示词已生效**：rtk 的 RTK.md 已同步进 `~/.zcode/AGENTS.md`（由 `/rtk-setup` 完成），以那段官方提示为准——正常跑命令即可，被钩子拦到再改。
2. **钩子给出 "[rtk] 改用以下等价命令" 提示时，直接执行提示里的命令**（它由 `rtk rewrite` 生成，是官方改写）。同一条命令本次会话记住前缀 `rtk`，避免反复被拦。
3. 主动使用：对已知支持的命令（`git status/diff/log/add/commit/push`、`ls`、`cat`、`grep`、`rg`、`find`、`cargo test/build`、`npm/pnpm test` 等）可直接加 `rtk ` 前缀。
4. **结果不可用时才取原文**：输出为空但明显应有内容、与退出码矛盾、乱码、或压缩后缺所需关键行时，先按压缩输出尾部提示 `rtk recall <hash> --grep <关键字>` 取回被隐藏的行（不重跑命令）；确需完整原文再 `rtk proxy <原命令>`（会真正重跑，非幂等命令慎用）。
5. 管理：`/rtk-setup`（安装/同步提示词）、`/rtk-status`（状态/节省统计）、`/rtk on|off`（开关）、`/rtk gain`（节省明细）。
