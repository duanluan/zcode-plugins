---
description: 委托模式评审（推荐，无需给 ocr 配 LLM）：ocr 选文件出规则，ZCode 用自身模型评审并修复。示例：/ocr-delegate-review ｜ --from main --to feat-x ｜ --commit abc123 ｜ -b "业务背景" ｜ --commit abc123 -b "修复登录 bug"
argument-hint: [--commit <sha> | --from <base> --to <branch>] [-b "业务背景"] [任意 ocr delegate preview 支持的参数]
allowed-tools: Bash(ocr delegate:*), Bash(ocr session:*), Bash(git diff:*), Bash(git show:*), Bash(git merge-base:*), Bash(git status:*), Bash(git log:*), Bash(npm i -g @alibaba-group/open-code-review:*)
---

以委托模式调用 OpenCodeReview (ocr)：ocr 负责确定"评审哪些文件"和"按什么规则评审"，而实际评审由你（当前 Agent）用自身模型完成。这是默认推荐方式——不需要为 ocr 配置任何 LLM。**用户传入的参数原样透传给 CLI，不要自行筛选或改写。**

## 工作流

### 第 0 步：确定评审目标（必做，不要跳过）

ocr 基于 git 仓库工作。先确认"用户到底要评审哪个仓库"，**禁止不确认就自行换仓库开评**：

1. **当前目录是 git 仓库**且有可评审内容（有改动，或用户给 `--commit`/`--from`/`--to`）→ 就用它，进入第 1 步。
2. **当前目录不是 git 仓库、或没有改动** → 从**会话上下文**推断候选目标，按优先级：
   - 本会话中用户提及的、或你近期创建/编辑过文件的项目目录
   - 这些目录的上级目录下、存在未提交改动（`git status --porcelain` 非空）的兄弟仓库
   把候选连同各自改动数列出来让用户选定；候选不明确时直接问用户"要评审哪个项目？"。
3. **用户指名的项目不是 git 仓库**：告知委托模式依赖 git 历史，给出选项：`git init` 并完成首次提交后用 `--commit HEAD` 评审全部内容；或改用 `/ocr-scan` 做全量文件评审。
4. **preview 显示 0 个可评审文件**：如实说明排除原因（如 `.md` 不支持、`.idea/` 被忽略），不要硬找别的仓库凑数。

### 第 1 步：预览待评审文件

```bash
ocr delegate preview $ARGUMENTS
```

- 无参数：工作区模式（暂存 + 未暂存 + 未跟踪）
- 常用参数（与 `ocr review` 同名参数语义一致）：
  - `--commit <sha>` / `-c <sha>`：单提交模式
  - `--from <base> --to <branch>`：分支范围（merge-base）模式
  - `--background "业务背景"` / `-b "..."`：业务上下文，评审时参考
- 若 `ocr` 未安装：`npm i -g @alibaba-group/open-code-review`

该命令输出模式（mode）、ref 元数据和可评审文件列表（含排除项及原因）。

### 第 2 步：获取评审规则

把第 1 步列出的所有可评审文件路径一次性传入：

```bash
ocr delegate rule <path1> <path2> ...
```

规则按内容分组输出，评审对应文件时遵循其规则清单。

### 第 3 步：取 diff 并逐文件评审

根据第 1 步得到的 mode/ref，为每个可评审文件获取 diff：

- 范围模式：`git merge-base <from> <to>` 求基点，再 `git diff <merge_base>..<to> -- <path>`
- 单提交模式：`git show <commit> -- <path>`
- 工作区模式：`git diff HEAD -- <path>`；未跟踪文件直接读取全文

然后以该文件的规则清单为焦点进行评审，重点关注：正确性、安全、性能、错误处理、并发、可维护性。**只评论变更的代码（+ 行）**，并引用精确的文件路径和行号。

### 第 4 步：汇报并修复

按严重程度分级：

- **高**：明显 bug、安全问题、数据丢失风险，或附有明确修复方案的错误 → 展示并修复
- **中**：合理的担忧、性能建议，或需要人工介入的修复 → 展示，安全且边界清晰的自动修复
- **低**：疑似误报、吹毛求疵、上下文不足 → 静默丢弃，不展示

修复完成后运行相关的测试或构建进行验证，最后给出评审总结。

## 补充场景

- **上次评审被中断**（会话超时、用户按了 Esc 等）：`ocr session list` 找到 session-id。委托模式没有 `--resume`，但可以从会话记录里知道上次的范围/提交参数，重新走一遍上述流程即可；如果是 `ocr review`/`ocr scan` 的会话，则直接用各自的 `--resume <session-id>`。
- **用户只想知道会评审哪些文件、不想真评审**：第 1 步的 preview 输出就是答案，直接整理给用户，跳过后续步骤。
