---
name: ocr-code-review
description: 用 OpenCodeReview (ocr) 对 Git 变更做行级 AI 代码评审。当用户要求"评审代码 / code review / 看看我的改动 / 审查这次修改 / 提交前检查"或会话结束时需要审查工作区变更时使用。默认走委托模式：ocr 负责文件筛选与规则解析，由当前 Agent 用自己的模型执行评审，无需为 ocr 配置 LLM。
---

# OpenCodeReview 代码评审（委托模式）

对 Git 变更做专业代码评审时，优先使用 `ocr` CLI 的委托模式。ocr 用确定性工程解决"评审哪些文件、按什么规则评审"（覆盖全、不偷懒、位置精准），你用自身模型完成实际评审。

## 流程

0. **先定目标**：确认用户要评审的是哪个 git 仓库——优先用会话上下文（用户提及的、近期编辑过的项目），不明确就问，不要自行换仓库。目标不是 git 仓库时：告知依赖 git 历史，可 `git init` 提交后用 `--commit HEAD` 评审全部，或全量扫描。当前目录 0 个可评审文件时如实说明排除原因，不硬凑。

1. **预览**（在仓库根目录执行）：

   ```bash
   ocr delegate preview
   ```

   输出 mode/ref 元数据与可评审文件列表。分支范围用 `--from <base> --to <branch>`，单提交用 `--commit <sha>`，业务背景用 `-b "背景"`。

2. **取规则**：把全部可评审文件路径一次性传入：

   ```bash
   ocr delegate rule <path1> <path2> ...
   ```

3. **取 diff 并逐文件评审**（按第 1 步的 mode）：
   - 工作区：`git diff HEAD -- <path>`；未跟踪文件直接读全文
   - 范围：`git diff <merge_base>..<to> -- <path>`
   - 单提交：`git show <commit> -- <path>`

   遵循该文件匹配到的规则清单，只评论 + 行，给出精确路径与行号。

4. **分级处理**：高（明显 bug/安全/数据丢失）→ 展示并修复；中（合理担忧/性能/需人工的修复）→ 展示，边界清晰的顺手修；低（误报/吹毛求疵）→ 静默丢弃。修复后运行相关测试验证。

## 注意

- 前置要求：Git ≥ 2.41，`ocr` CLI 已安装（`npm i -g @alibaba-group/open-code-review`）
- 委托模式不需要 ocr 的 LLM 配置；若用户明确要求用 ocr 自带流水线（`ocr review` / `ocr scan`），则依赖 `~/.opencodereview/config.json` 中的模型配置
- 变更非常大时也必须评审 preview 列出的全部文件——这正是用 ocr 而不是裸眼扫 diff 的意义
