---
description: 全量扫描文件/目录（不依赖 git 历史），审计陌生代码库（需已配置 ocr LLM）。示例：/ocr-scan ｜ --path src/,internal/ ｜ -p（干跑先看范围） ｜ --exclude '**/generated/*' ｜ --resume <session-id> ｜ -f json -o result.json
argument-hint: [--path <目录或文件>] [--resume <id>] [-f json -o result.json] [任意 ocr scan 参数]
allowed-tools: Bash(ocr scan:*), Bash(ocr session:*), Bash(npm i -g @alibaba-group/open-code-review:*)
---

调用 OpenCodeReview (ocr) 的全量扫描模式：审查整个文件而非 diff，无需 git 历史。适用于审计不熟悉的代码库，或没有有意义 diff 的目录。**用户传入的参数原样透传给 CLI。**

> 注意：此模式使用 ocr 已配置的 LLM（默认模式）。若 ocr 的 LLM 未配置好，此命令会报错——此时请改用 `/ocr-delegate-review`，或按插件 README 修好 ocr 的模型配置。

## 工作流

### 第 0 步：确定扫描目标（必做）

先确认用户要扫描哪个目录：当前目录符合预期就直接执行；否则从**会话上下文**推断（用户提及的、近期编辑过的项目），不明确就先问，**不要自行挑一个目录开扫**。目标不在当前目录时先 cd 进去，或用 `--repo <路径>` 指定仓库根。

### 第 1 步：执行扫描

```bash
ocr scan --audience agent $ARGUMENTS
```

- 无参数：扫描整个仓库
- `--path internal/agent`：扫描指定目录；**多个目标用逗号分隔**（如 `--path 'src/,internal/agent'`），均为仓库相对路径
- `-p` / `--preview`：只列出将扫描哪些文件，不调用 LLM（干跑，大仓库先跑这个确认范围）
- 捕获完整 stdout，超时设为 10 分钟（全量扫描较慢，`--timeout` 单位为分钟可加大）
- 若 `ocr` 未安装：`npm i -g @alibaba-group/open-code-review`
- 若报 LLM 鉴权 / 余额 / 连接错误：告知用户 ocr 的模型配置有问题，并给出 README 中的 GLM coding 端点修复方法

### 第 2 步：过滤与汇报

- **高**：明显 bug、安全问题、数据丢失风险 → 重点展示
- **中**：合理的担忧、性能/可维护性建议 → 列表展示
- **低**：疑似误报、吹毛求疵 → 静默丢弃

全量扫描的意见数量通常远多于 diff 评审：先按文件聚类、按严重程度排序输出摘要，再展开高优先级问题的细节与修复建议。除非用户明确要求，扫描模式下**不要自动修改代码**——只汇报。

## 常用参数速查（全部可透传）

| 参数 | 作用 |
|---|---|
| `--path <a>,<b>` | 限定扫描范围（逗号分隔，仓库相对路径；缺省全仓库） |
| `--resume <session-id>` | 恢复中断的扫描（session-id 用 `ocr session list` 查询） |
| `-b "..."` | 业务背景，让扫描更贴合上下文 |
| `--exclude '<glob>,...'` | 追加 gitignore 风格排除 |
| `--batch by-language\|by-directory\|none` | 分批策略 |
| `-f json` / `-f sarif` / `-o <file>` | 输出格式与落盘 |
| `--max-tokens-budget <n>` | 限制本次扫描总 token 预算 |
| `--no-plan` / `--no-dedup` / `--no-summary` | 跳过对应阶段，省 token 加速 |
