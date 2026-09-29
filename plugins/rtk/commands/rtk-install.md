---
description: 安装真 rtk 并接入 ZCode：装二进制 → rtk init -g 生成官方全局提示词 → 同步进 ~/.zcode/AGENTS.md → 验证改写。示例：/rtk-install
argument-hint: [--force 重装]
allowed-tools: Bash(rtk:*), Bash(curl:*), Bash(tar:*), Bash(install:*), Bash(mkdir:*), Bash(cat:*), Bash(printf:*), Bash(python3:*), Bash(ls:*), Bash(command -v:*)
---

安装真 rtk（Rust Token Killer，<https://github.com/rtk-ai/rtk>，常见开发命令输出压缩 60-90%）并接入 ZCode。已安装时本命令只做校验与提示词同步，快速无害。`$ARGUMENTS` 原样作为参数来源（`--force` 表示重装二进制）。

## 设计原则

"何时压缩、怎么压缩"完全由 rtk 自己的全局提示词（RTK.md）和 `rtk rewrite` 决定，插件不发明规则，只负责：装 rtk → `rtk init -g` → 把 rtk 生成的 RTK.md 同步进 ZCode 能读到的 `~/.zcode/AGENTS.md`（rtk 不认识 ZCode，只写 ~/.claude）。

## 第 1 步：安装 rtk 二进制（已装且无 --force 则跳过）

```bash
command -v rtk && rtk --version
```

未安装或 `--force` 时，官方脚本优先：

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

install.sh 下载失败时（GitHub release 偶发断流），直接重试下载 tar 包：

```bash
curl -fL --retry 3 -o /tmp/rtk.tar.gz https://github.com/rtk-ai/rtk/releases/latest/download/rtk-x86_64-unknown-linux-musl.tar.gz && tar -xzf /tmp/rtk.tar.gz -C /tmp && install -m755 /tmp/rtk ~/.local/bin/rtk
```

## 第 2 步：生成 rtk 官方全局提示词与钩子注册

```bash
mkdir -p ~/.claude && rtk init -g
```

（RTK.md 写在 ~/.claude/RTK.md；~/.claude 是 rtk 的 CC 集成目录，对 ZCode 无副作用，留着无害）

## 第 3 步：同步 RTK.md → ~/.zcode/AGENTS.md（幂等）

```bash
python3 - <<'PY'
import pathlib
src = pathlib.Path.home()/'.claude/RTK.md'
dst = pathlib.Path.home()/'.zcode/AGENTS.md'
body = src.read_text() if src.exists() else (pathlib.Path.home()/'.claude/CLAUDE.md').read_text()
start, end = '<!-- rtk:start -->', '<!-- rtk:end -->'
old = dst.read_text() if dst.exists() else ''
if start in old:
    pre, _, rest = old.partition(start)
    _, _, post = rest.partition(end)
    new = pre + start + '\n' + body.strip() + '\n' + end + post
else:
    new = (old.rstrip() + '\n\n' if old.strip() else '') + start + '\n' + body.strip() + '\n' + end + '\n'
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(new)
print('已同步 rtk 全局提示词 →', dst)
PY
```

> 同步是一次性的；此后插件 SessionStart 钩子会在每次会话启动时自动比对 RTK.md 与 AGENTS.md，rtk 升级后自动跟随更新，无需重跑 install。

## 第 4 步：验证

```bash
rtk --version
rtk rewrite "git status"    # 应输出 rtk git status（rc=3）
grep -c 'rtk:start' ~/.zcode/AGENTS.md
```

## 第 5 步：汇报

- rtk 版本与路径、提示词同步结果、改写验证结果
- 日常使用说明一句话：正常跑命令即可；钩子给出"[rtk] 改用以下等价命令"时照做；`/rtk-status` 随时查看状态与节省；`/rtk off` 关闭提醒
