# OpenCodeReview：代码评审

[← 返回插件总览](../../README.md#-插件一览)

**装后必做：`/ocr-setup`**——安装 ocr 命令（npm 全局包，缺 bin 链接时自动修复），并把二进制路径记录到 `~/.zcode/open-code-review.json`。委托模式由 ZCode 自身模型完成评审，**不需要为 ocr 配置任何 LLM**，装完即可用 `/ocr-delegate-review`。

### 🌟 委托模式（推荐）`/ocr-delegate-review`

ocr 用确定性工程解决"评审哪些文件、按什么规则"两个问题：文件覆盖完整、位置定位精准，评审本身由 ZCode 用自身模型完成。

```
/ocr-delegate-review                          # 工作区改动（暂存+未暂存+未跟踪）
/ocr-delegate-review --from main --to feat-x  # 分支范围（merge-base 模式）
/ocr-delegate-review --commit abc123          # 单个提交
/ocr-delegate-review -b "这次改的是登录限流"    # 带业务背景
```

流程：`ocr delegate preview`（选文件）→ `ocr delegate rule`（出规则）→ ZCode 逐文件取 diff 评审 → 高/中问题展示并自动修复（低置信度静默丢弃）→ 跑测试验证。命令内置"第 0 步：确定评审目标"——当前目录不是 git 仓库时，会结合会话上下文推断目标项目，不明确时先行确认，不擅自切换评审目标。

### ⚙️ ocr 自带流水线 `/ocr-review`（需先配置 ocr 的 LLM，见下文）

多文件并发评审，token 消耗约为通用 Agent 的 1/9。常用参数全部原样传给 ocr：`--effort high`（评审力度）、`--exclude '**/generated/*'`（追加排除）、`--resume <session-id>`（恢复中断的评审，id 由 `/ocr session list` 查）、`-f json -o result.json`（机器可读输出）。

### 🔍 全量扫描 `/ocr-scan`（需 ocr LLM；不看 diff，审计陌生代码库）

```
/ocr-scan                    # 整个仓库（大仓库先 -p 干跑看范围）
/ocr-scan --path src/,internal/
```

### 🧰 任意子命令 `/ocr`

`session list/show/comments/compare`（历史会话与对比）、`rules check <file>`（看文件命中的评审规则）、`llm test`、`config set`、`viewer`（WebUI 会话查看器）等都可原样传入。

### 🔑 ocr 的 LLM 配置（可选，仅 /ocr-review 与 /ocr-scan 需要）

**GLM 会员（Coding Plan）额度只能走 coding 专用端点**：`/api/v1` 无权限（403）、`paas/v4` 走按量余额（429 余额不足）。已验证可用的配置：

```bash
ocr config set llm.url https://open.bigmodel.cn/api/coding/paas/v4
ocr config set llm.auth_token <你的 GLM API Key>
ocr config set llm.model glm-5.3-flash    # 或 glm-5.3
ocr config set llm.use_anthropic false
ocr llm test
```
