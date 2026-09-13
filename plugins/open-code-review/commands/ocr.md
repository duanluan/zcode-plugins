---
description: 任意 ocr 子命令全透传。示例：/ocr session list ｜ /ocr session show <id> ｜ /ocr llm test ｜ /ocr rules check <file> ｜ /ocr viewer
argument-hint: <子命令与参数> 如：session list ｜ llm test ｜ rules check <file> ｜ viewer
allowed-tools: Bash(ocr:*), Bash(npm i -g @alibaba-group/open-code-review:*)
---

把参数原样透传给 OpenCodeReview CLI，执行 `ocr $ARGUMENTS`。适用于本插件三个专用命令（/ocr-review、/ocr-delegate-review、/ocr-scan）没覆盖的所有子命令。**参数不做任何筛选或改写。**

## 执行规则

```bash
ocr $ARGUMENTS
```

- 若 `$ARGUMENTS` 为空：展示简要用法说明（上面的示例 + `ocr --help` 的子命令清单），不执行任何命令
- 若 `ocr` 未安装：`npm i -g @alibaba-group/open-code-review`
- **交互式界面会挂起**：`ocr config provider`、`ocr config model` 这类交互式 TUI 不要直接执行，告诉用户去终端里跑；配置项改动用非交互方式代替：`ocr config set llm.url <url>` 等
- `ocr viewer` 会启动 WebUI 会话查看器（长驻进程）：放后台运行，把访问地址（如 http://127.0.0.1:端口）作为链接返给用户

## 常用子命令速查

| 子命令 | 作用 |
|---|---|
| `session list [--json]` | 列出当前仓库的历史评审会话（可拿 session-id 做 `--resume`） |
| `session show <id>` | 看某次会话的元数据与逐文件条目 |
| `session comments <id>` | 看某次会话记录的全部评审意见 |
| `session compare <id1> <id2>` | 对比两次会话的发现（如修复前后） |
| `rules check <file>` | 查看某路径会匹配到哪组评审规则 |
| `llm test` | 测试 ocr 配置的 LLM 连通性 |
| `config set <key> <value>` | 非交互式改配置（如 `llm.url`、`llm.model`） |
| `delegate preview` / `delegate rule <file...>` | 委托模式（详见 /ocr-delegate-review） |
| `review` / `scan` | 评审与扫描（详见 /ocr-review、/ocr-scan） |
| `viewer` | 启动 WebUI 会话查看器 |

## 结果处理

如果透传执行的命令产生了评审结果（比如直接跑了 `ocr review ...` 或 `ocr session comments <id>`），按 /ocr-review 的同一标准处理：按 高/中/低 分级过滤评审意见（低置信度静默丢弃），高、中问题展示，边界清晰的自动修复并验证。
