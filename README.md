# zcode-plugins

ZCode 插件市场，市场名 `duanluan-zcode-plugins`。围绕 token 效率与代码质量构建：rtk 在源头压缩命令输出，Headroom 在请求层压缩对话历史，zcode-vision 让纯文本模型也能读懂图片，GLM Coding Plan 提供模型额度；OpenCodeReview 提供 Git 变更的行级代码评审。

## 插件一览

| 插件 | 作用 | 命令 |
|---|---|---|
| **open-code-review** | 集成 [OpenCodeReview (ocr)](https://github.com/alibaba/open-code-review)：Git 变更行级 AI 评审。委托模式由 ZCode 自身模型评审，**无需为 ocr 配置 LLM** | `/ocr-delegate-review`、`/ocr-review`、`/ocr-scan`、`/ocr <任意子命令>` |
| **headroom** | 接入 [Headroom](https://github.com/headroomlabs-ai/headroom) 本地压缩代理：ZCode 的 LLM 请求先压缩再转发 GLM；SessionStart 自动拉起代理；注册官方 CCR 取回工具 | `/hr-setup`、`/hr-status`、`/hr-proxy`、`/hr <任意子命令>` |
| **rtk** | 接入 [rtk](https://github.com/rtk-ai/rtk)（Rust 单二进制）：常见开发命令输出压缩 60-90%；何时压缩完全由 rtk 官方提示词与 `rtk rewrite` 决定 | `/rtk-install`、`/rtk-status`、`/rtk <on\|off\|gain\|uninstall>` |
| **zcode-vision** | 图片视觉代理：主模型不支持图片输入时（如 glm-5.3），自动把图片交给视觉模型识别并把描述注入对话 | `/vision-setup`、`/vision-proxy`、`/vision-chain`、`/vision <on\|off\|status\|test>` |

所有命令的菜单简介里都带用法示例；大部分参数原样透传给底层 CLI。

## 安装

前置：Git ≥ 2.41。命令行工具按需自动安装（ocr 缺失时自动 `npm i -g`，headroom/rtk 缺失时由各自的 install 命令安装）。

1. ZCode → 插件市场 → 右上角「添加」→ 添加插件市场，填写：
   `duanluan/zcode-plugins`
2. 找到 **duanluan-zcode-plugins** 市场，安装需要的插件并启用

更新：仓库内容变更后，市场源面板（搜索框上方齿轮）刷新 → 重装对应插件 → 新会话生效。（本地克隆目录仅作开发测试用，改动后推送 GitHub 即发布。）

---

## open-code-review：代码评审

### 委托模式（推荐）`/ocr-delegate-review`

ocr 用确定性工程解决"评审哪些文件、按什么规则"两个问题：文件覆盖完整、位置定位精准，ZCode 用自身模型完成评审——**不需要为 ocr 配置任何 LLM**。

```
/ocr-delegate-review                          # 工作区改动（暂存+未暂存+未跟踪）
/ocr-delegate-review --from main --to feat-x  # 分支范围（merge-base 模式）
/ocr-delegate-review --commit abc123          # 单个提交
/ocr-delegate-review -b "这次改的是登录限流"    # 带业务背景
```

流程：`ocr delegate preview`（选文件）→ `ocr delegate rule`（出规则）→ ZCode 逐文件取 diff 评审 → 高/中问题展示并自动修复（低置信度静默丢弃）→ 跑测试验证。命令内置"第 0 步：确定评审目标"——当前目录不是 git 仓库时，会结合会话上下文推断目标项目，不明确时先行确认，不擅自切换评审目标。

### ocr 自带流水线 `/ocr-review`（需先配置 ocr 的 LLM，见下文）

多文件并发评审，token 消耗约为通用 Agent 的 1/9。常用参数全部透传：

```
/ocr-review --effort high                 # 评审力度
/ocr-review --exclude '**/generated/*'    # 追加排除
/ocr-review --resume <session-id>         # 恢复中断的评审（id 由 /ocr session list 查）
/ocr-review -f json -o result.json        # 机器可读输出
```

### 全量扫描 `/ocr-scan`（需 ocr LLM；不看 diff，审计陌生代码库）

```
/ocr-scan                    # 整个仓库（大仓库先 -p 干跑看范围）
/ocr-scan --path src/,internal/
```

### 任意子命令 `/ocr`

`session list/show/comments/compare`（历史会话与对比）、`rules check <file>`（看文件命中的评审规则）、`llm test`、`config set`、`viewer`（WebUI 会话查看器）等全部透传。

### ocr 的 LLM 配置（可选，仅 /ocr-review 与 /ocr-scan 需要）

**GLM 会员（Coding Plan）额度只能走 coding 专用端点**：`/api/v1` 无权限（403）、`paas/v4` 走按量余额（429 余额不足）。已验证可用的配置：

```bash
ocr config set llm.url https://open.bigmodel.cn/api/coding/paas/v4
ocr config set llm.auth_token <你的 GLM API Key>
ocr config set llm.model glm-5.3-flash    # 或 glm-5.3
ocr config set llm.use_anthropic false
ocr llm test
```

---

## headroom：请求层压缩代理

**原理**：ZCode → Headroom 代理（127.0.0.1:8787，本地压缩工具输出/日志/大 JSON）→ 智谱 GLM（`open.bigmodel.cn/api/anthropic`）。鉴权头原样转发，**GLM 会员额度照常**。

### 一键接入 `/hr-setup`

确认 headroom 已装（未装则 uv/pipx/pip 兜底安装）→ 后台启动代理（上游自动指向 GLM）→ `headroom doctor` 验证 → 给出界面配置清单。

### 必做一步：新建自定义供应商（界面操作，无法自动化）

自带的「智谱」供应商走内部 OAuth、接入地址写死，**指不了代理**，所以必须新建。设置 → 模型设置 → 供应商列表「+ 添加供应商」：

| 字段 | 填写值 | 说明 |
|---|---|---|
| 名称 | `BigModel`（随意） | 出现在自定义供应商区 |
| **API 格式** | **Anthropic Messages (/v1/messages)** | **不要选 Chat Completions**——headroom 转发保留 `/v1` 前缀，bigmodel 无该路径，必 404 |
| Base URL | `http://127.0.0.1:8787` | 指向本地代理 |
| API Key | 你的 GLM API Key | 代理原样转发，会员额度照常 |
| 模型列表 | `glm-5.3`、`glm-5.3-flash` | 与直连时相同的模型 ID |

保存并「已启用」，聊天时选该供应商下的模型即开始压缩。**自带「智谱」保留不动**——它就是回退开关，切回即"关闭"压缩。

### 日常命令

- `/hr-status`：代理状态 + doctor 健康检查 + token 节省报告
- `/hr-proxy start|stop|status|restart`：代理进程管理（日志 `~/.zcode-headroom-proxy.log`）
- `/hr dashboard`：浏览器实时节省报表；`/hr inspect`：对比原文与压缩结果；其余子命令全透传

### 自动启动

长期使用建议为代理配置 **systemd 用户服务**（开机自启、随登录拉起、崩溃自动重启；`/hr-setup` 第 2 步含完整 unit 内容）——`nohup` 方式起的进程在重启电脑后会丢失，导致 ZCode 提示"重新连接中"。此外插件自带 SessionStart 钩子兜底：每次会话启动检测 8787 端口，代理没跑就在后台拉起（按常见安装位置查找 headroom，不依赖 PATH）。环境变量可覆盖：`HEADROOM_PROXY_PORT`、`HEADROOM_PROXY_AUTOSTART=0`（关闭）、`HEADROOM_UPSTREAM_ANTHROPIC`（上游地址）。

---

## rtk：命令输出源头压缩

**原理**：rtk（Rust 单二进制，100+ 命令过滤器）在命令输出**进入对话之前**压缩 60-90%，与 headroom（请求层）互补。"何时压缩、怎么压缩"完全由 rtk 官方机制决定，插件只负责安装与接线：

1. **官方全局提示词**：`rtk init -g` 生成的 `RTK.md` 同步进 `~/.zcode/AGENTS.md`（带 `<!-- rtk:start/end -->` 标记）；SessionStart 钩子每次会话自动比对，rtk 升级后跟随更新
2. **官方改写判断**：PreToolUse(Bash) 钩子调用 `rtk rewrite`（rtk 官方声明的 hooks 唯一事实来源）——有等价改写才拦一次，stderr 直接给出改写后的命令，照做即可
3. **安全护栏**：输出重定向进文件（`>/dev/null` 除外）、命令替换 `$()`、已套 rtk、已管道限量（`| head`）的命令一律放行不改写；rtk 未装或 `/rtk off` 时完全静默

### 使用

```
/rtk-install      # 装 rtk（官方 install.sh，断流自动转 tar 包）+ 同步提示词 + 验证
/rtk-status       # 版本、钩子模式、提示词同步、节省统计（rtk gain）
/rtk off          # 关闭改写提醒（手动 rtk <命令> 不受影响）
/rtk gain         # rtk 自身统计的节省明细
```

日常无需任何操作：正常跑命令，钩子给出"[rtk] 改用以下等价命令"时照做即可。主动压缩就给命令加 `rtk ` 前缀（如 `rtk git status`）；被压缩的输出结果不可用时按提示 `rtk proxy <原命令>` 取原文。

---

## zcode-vision：图片视觉代理

**原理**：给主模型发图片时（粘贴/拖拽），UserPromptSubmit 钩子在消息发给模型**之前**把图片交给视觉模型（默认 `glm-5.3-flash`）识别，识别文字随消息注入对话——主模型即使不支持图片输入（如 glm-5.3），也能像"看到"图片一样直接回答，不再自己去 OCR 或读图。

- **开箱即用**：默认用 GLM 订阅（Coding Plan）的 key 直连官方端点识别，与当前会话用哪个供应商无关；key 留空自动获取
- **异常优先**：识别提示词要求先把界面截图里的错误、警告、异常状态逐字引用出来，再描述布局，关键报错不易被淹没
- **细节追问**：识别文字是一次性快照，注入文本附带图片完整路径，模型可随时调用 `vision_ask` 工具对原图定向追问（如"报错完整原文""右下角小字"），结果按图+问题缓存
- **跟随会话供应商**：代理设 `useProvider: session` 即用当前会话供应商的地址/key/格式识别（供应商本身指向 headroom 时即经 headroom）；也可指定供应商名。`/vision-proxy follow <代理名> session|<供应商>|off` 一键切换
- **多代理链**：`fallback`（依次尝试到成功，主力+备用）/ `pipeline`（逐级加工：描述→校对/提炼，后一步可用 `{prev}` 引用上一步）；每个代理可独立配供应商、模型、key、请求格式（Anthropic Messages / OpenAI Chat Completions）
- **不限图片数量与大小**；识别结果按「图片内容 + 链配置」缓存，同图同链不重复调用

### 使用

```
/vision-setup    # 首次向导：确认识别端点（模型/key/是否走 headroom）并验证
/vision test     # 用最近一张图跑通识别链
/vision status   # 配置与缓存状态
/vision off      # 临时关闭（on 恢复）
```

配置文件 `~/.zcode/zcode-vision.json`，[zcode-pro](https://github.com/duanluan/zcode-pro) 设置面板的「视觉代理」页编辑同一文件。

已知边界：钩子无法感知主模型是否支持图片，有图即识别注入（对支持图片的模型只是多一次 flash 调用，结果无害）；识别失败只把原因注入对话，绝不阻断消息。

---

## 相关项目

- [zcode-pro](https://github.com/duanluan/zcode-pro)：ZCode 桌面版界面增强工具——项目自定义别名、切换文件夹、会话排序、文件菜单增强、界面样式微调与全局提示词等；不修改官方应用文件，退出后自动恢复。

## 交流与反馈

- QQ 群：**428403354**（[点击加入](https://qm.qq.com/q/WXuISJK3ug)）
- 微信群：添加微信 **ai4only** 邀请进群

<p>
  <img src="assets/qq-group.png" width="200" alt="QQ 群二维码" />
  &nbsp;&nbsp;
  <img src="assets/wechat-ai4only.png" width="200" alt="微信二维码（ai4only）" />
</p>
