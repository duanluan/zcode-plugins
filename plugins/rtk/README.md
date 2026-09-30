# rtk：命令输出源头压缩

[← 返回插件总览](../../README.md#插件一览)

**装后必做：`/rtk-setup`**（原名 `/rtk-install`）。装 rtk 二进制（官方 install.sh，断流自动转 tar 包）→ 生成官方全局提示词 → 同步进 `~/.zcode/AGENTS.md` → 验证改写，一条命令完成。

**原理**：rtk（Rust 单二进制，100+ 命令过滤器）在命令输出**进入对话之前**压缩 60-90%，与 headroom（请求层）互补。"何时压缩、怎么压缩"完全由 rtk 官方机制决定，插件只负责安装与接线：

1. **官方全局提示词**：`rtk init -g` 生成的 `RTK.md` 同步进 `~/.zcode/AGENTS.md`（带 `<!-- rtk:start/end -->` 标记）；SessionStart 钩子每次会话自动比对，rtk 升级后跟随更新
2. **官方改写判断**：PreToolUse(Bash) 钩子调用 `rtk rewrite`（rtk 官方声明的 hooks 唯一事实来源）——有等价改写才拦一次，stderr 直接给出改写后的命令，照做即可
3. **安全护栏**：输出重定向进文件（`>/dev/null` 除外）、命令替换 `$()`、已套 rtk、已管道限量（`| head`）的命令一律放行不改写；rtk 未装或 `/rtk off` 时完全静默

### 使用

```
/rtk-setup        # 装后必做：装 rtk + 同步提示词 + 验证
/rtk-status       # 版本、钩子模式、提示词同步、节省统计
/rtk off          # 关闭改写提醒（手动 rtk <命令> 不受影响）
/rtk gain         # rtk 自身统计的节省明细
```

日常无需任何操作：正常跑命令，钩子给出"[rtk] 改用以下等价命令"时照做即可。主动压缩就给命令加 `rtk ` 前缀（如 `rtk git status`）；被压缩的输出结果不可用时按提示 `rtk proxy <原命令>` 取原文。
