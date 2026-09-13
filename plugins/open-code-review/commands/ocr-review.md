---
description: ocr 自带 LLM 流水线评审变更并自动修复（需已配置 ocr LLM）。示例：/ocr-review ｜ --from main --to feat-x ｜ --commit abc123 ｜ --effort high ｜ -b "需求背景" ｜ --resume <session-id> ｜ -f json -o result.json
argument-hint: [--commit <sha> | --from <base> --to <branch>] [-b "背景"] [--effort high] [--resume <id>] [任意 ocr review 参数]
allowed-tools: Bash(ocr review:*), Bash(ocr session:*), Bash(npm i -g @alibaba-group/open-code-review:*)
---

调用专业代码评审 CLI 工具 OpenCodeReview (ocr) 的默认模式（OCR 驱动，使用 ocr 已配置的 LLM）评审当前代码变更，然后由你自行判断是否修复。若 ocr 的 LLM 未配置好，改用 `/ocr-delegate-review`。**用户传入的参数原样透传给 CLI。**

## 工作流

### 第 0 步：确定评审目标（必做）

ocr 在 git 仓库内运行。当前目录是 git 仓库且用户没有指明其他目标 → 直接执行；否则从**会话上下文**推断目标项目（用户提及的、近期编辑过的目录），不明确就先问用户，**不要自行换仓库开评**。目标不在当前目录时用 `--repo <路径>` 指定，或先 cd 进该仓库。目标不是 git 仓库时告知用户 ocr 需要 git 历史（可 `git init` 提交后评审，或改用 `/ocr-scan`）。

### 第 1 步：执行评审

```bash
ocr review --audience agent $ARGUMENTS
```

- 无参数：工作区模式，评审暂存 + 未暂存 + 未跟踪的变更
- 捕获完整 stdout，超时设为 5 分钟（`--timeout` 默认 15 分钟，可加大）
- 若 `ocr` 未安装：`npm i -g @alibaba-group/open-code-review`
- 若报 LLM 鉴权 / 余额 / 连接错误：告知用户，并建议改用 `/ocr-delegate-review`（委托模式，无需 ocr LLM 配置）

### 第 2 步：过滤与评估

对每条评审意见评估其有效性和质量：

- **高**：明显 bug、安全问题、清晰错误，或附带精确修复方案的有据建议
- **中**：合理的担忧但依赖上下文、风格/性能建议，或需要人工实施的修复
- **低**：疑似误报、上下文不足、吹毛求疵或无意义意见

静默丢弃低置信度意见，仅展示其余意见。（ocr 已内置评论过滤；若用户传了 `--no-filter` 则低置信度会变多，需更严格地把关。）

### 第 3 步：修复

自动修复值得采纳的问题和建议；修复后运行相关测试或构建验证，最后给出评审总结。

## 常用参数速查（全部可透传）

| 参数 | 作用 |
|---|---|
| `--commit <sha>` / `-c` | 评审单个提交（对比其父提交） |
| `--from <base> --to <branch>` | 分支范围（merge-base）模式 |
| `--resume <session-id>` | 恢复中断的范围/单提交评审（session-id 用 `ocr session list` 查询） |
| `-b "..."` / `-B <file.md>` | 内联需求背景 / 从 Markdown 文件读取（限 8000 字符，优先级更高） |
| `--effort low\|medium\|high` | 评审力度档位 |
| `--exclude '<glob>,...'` | 追加 gitignore 风格排除（如 `'**/generated/*,**/testdata/*'`） |
| `-p` / `--preview` | 只列出将评审哪些文件，不调用 LLM（干跑） |
| `-f json` / `-f sarif` | 输出 JSON / SARIF 格式（进度走 stderr） |
| `-o <file>` | 结果写入文件；`-f json -o result.json` 适合后续程序处理 |
| `--max-tokens-budget <n>` | 限制本次评审总 token 预算 |
| `--provider X --model Y` | 仅本次运行临时换供应商/模型 |

## 中断恢复

评审被中断时：`ocr session list`（可加 `--json`）查 session-id → 用原范围参数加 `--resume <session-id>` 续跑，已完成的部分不会重复消耗 token。
