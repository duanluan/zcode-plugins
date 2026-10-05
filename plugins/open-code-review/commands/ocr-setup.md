---
description: 安装/修复 ocr 命令并接入 ZCode（装后必做）：安装 OpenCodeReview CLI → 修复 bin 链接缺失 → 记录二进制路径到 ~/.zcode/open-code-review.json → 验证。示例：/ocr-setup ｜ /ocr-setup --force
argument-hint: [--force 重装]
allowed-tools: Bash(ocr:*), Bash(command -v:*), Bash(npm:*), Bash(node:*), Bash(uname:*), Bash(python3:*), Bash(cat:*), Bash(ls:*), Bash(mkdir:*), Bash(ln:*)
---

安装 OpenCodeReview CLI（`ocr` 命令，npm 全局包 `@alibaba-group/open-code-review`）并把二进制路径记录到配置文件 `~/.zcode/open-code-review.json`（本插件自用，其他配置不读它）。已安装时本命令只做校验与路径刷新，快速无害。`$ARGUMENTS` 原样作为参数来源（`--force` 表示重装）。

## 第 1 步：看现状

```bash
command -v ocr && ocr --version
cat ~/.zcode/open-code-review.json   # 不存在或 JSON 非法都按未初始化处理
```

## 第 2 步：安装/修复（未安装、`--force`、或第 1 步找不到 ocr 时执行）

```bash
npm i -g @alibaba-group/open-code-review
```

**已知坑（2026-10 排查过一次，别再从头查）**：装完偶尔缺 npm 全局 bin 软链接——包其实已装好，但 `command -v ocr` 找不到。**原命令重跑一次安装即修复**，不要去查 `scripts/platform.js`：直接跑 `bin/ocr.js` 会报 `OpenCodeReview binary not found`，那是同一个问题的表象，不是另一个故障。

**nvm 提示**：npm 全局包按 Node 版本隔离，`nvm use` 切版本后 `ocr` 会再次找不到。同样重装即可；或用第 4 步记录的 `nativeBinary` 绝对路径直接执行，它不受 Node 版本切换影响。

## 第 3 步：定位原生二进制（第 4 步记录、第 3 步兜底都要用）

```bash
ls "$(npm root -g)/@alibaba-group/open-code-review/node_modules/@alibaba-group/"
```

目录里的 `ocr-<平台>` 子包就是原生二进制所在（如 `ocr-linux-x64`），二进制为它的 `bin/opencodereview`。平台按 `uname -s` / `uname -m` 对应：linux-x64、linux-arm64、darwin-x64、darwin-arm64、win32-x64，**以 ls 实际输出为准**。

若第 2 步之后 `command -v ocr` 仍找不到，把软链接指向该二进制（`~/.local/bin` 在 PATH 里，且跨 Node 版本稳定）：

```bash
mkdir -p ~/.local/bin && ln -sf <上面找到的 opencodereview 绝对路径> ~/.local/bin/ocr
```

## 第 4 步：写入配置 `~/.zcode/open-code-review.json`

python3 写入（保持键顺序，2 空格缩进）后 `cat` 确认。字段说明：

| 字段 | 含义 |
| --- | --- |
| `version` | `ocr --version` 的版本号 |
| `binPath` | `command -v ocr` 的结果，找不到则空字符串 |
| `nativeBinary` | 原生二进制（opencodereview）绝对路径，命令找不到 ocr 时的兜底执行入口 |
| `fallbackLink` | 第 3 步建的软链接路径，没建则空字符串 |
| `nodeVersion` | `node -v`，排查 nvm 切换导致的失效用 |
| `installedAt` | 本次安装/刷新时间（ISO 8601） |

模板（值按实际探测结果填）：

```json
{
  "version": "1.12.12",
  "binPath": "/home/z/.nvm/versions/node/v24.20.0/bin/ocr",
  "nativeBinary": "/home/z/.nvm/versions/node/v24.20.0/lib/node_modules/@alibaba-group/open-code-review/node_modules/@alibaba-group/ocr-linux-x64/bin/opencodereview",
  "fallbackLink": "",
  "nodeVersion": "v24.20.0",
  "installedAt": "2026-10-06T12:00:00+08:00"
}
```

## 第 5 步：验证

```bash
ocr --version    # 输出 open-code-review v1.x 即正常
```

`command -v ocr` 仍不行时，用 `fallbackLink` 或 `nativeBinary` 的绝对路径跑 `--version` 验证。

## 第 6 步：汇报

- 安装/修复结果、ocr 版本、记录进 `~/.zcode/open-code-review.json` 的路径
- 后续命令（/ocr-delegate-review 等）找不到 ocr 时会读配置里的 `nativeBinary` 兜底，平时无需重跑本命令
- 可选：仅 /ocr-review、/ocr-scan 需要给 ocr 配 LLM（`ocr config set`，见 README「ocr 的 LLM 配置」）；委托模式不需要
