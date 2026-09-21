# zcode-plugins

ZCode 插件市场，市场名 `duanluan-zcode-plugins`。围绕 token 效率与代码质量构建：rtk 在源头压缩命令输出，Headroom 在请求层压缩对话历史，GLM Coding Plan 提供模型额度；OpenCodeReview 提供 Git 变更的行级代码评审。

## 插件一览

| 插件 | 作用 | 命令 |
|---|---|---|
| **open-code-review** | 集成 [OpenCodeReview (ocr)](https://github.com/alibaba/open-code-review)：Git 变更行级 AI 代码评审。委托模式由 ZCode 自身模型评审，**无需为 ocr 配置 LLM** | `/ocr-delegate-review`、`/ocr-review`、`/ocr-scan`、`/ocr <任意子命令>` |
| **zcode-headroom** | 接入 [Headroom](https://github.com/headroomlabs-ai/headroom) 本地压缩代理：ZCode 的 LLM 请求先压缩再转发 GLM；SessionStart 自动拉起代理；注册官方 CCR 取回工具 | `/hr-setup`、`/hr-status`、`/hr-proxy`、`/hr <任意子命令>` |
| **zcode-rtk** | 接入 [rtk](https://github.com/rtk-ai/rtk)（Rust 单二进制）：常见开发命令输出压缩 60-90%；何时压缩完全由 rtk 官方提示词与 `rtk rewrite` 决定 | `/rtk-install`、`/rtk-status`、`/rtk <on\|off\|gain\|uninstall>` |
| **zcode-agentteams** | 接入 [AgentTeams](https://github.com/agentscope-ai/AgentTeams) 多智能体协作平台：`/at-install` 可一键部署平台本体，活动面板可视化项目/队长/成员/任务依赖 DAG | `/at-install`、`/at-setup`、`/at-dashboard`、`/at-status`、`/at <agt 子命令>` |

所有命令的菜单简介里都带用法示例；大部分参数原样透传给底层 CLI。

## 安装

前置：Git ≥ 2.41。各插件依赖的底层工具都由插件自己带安装命令，不用手动装：ocr 缺失时自动 `npm i -g`；headroom 缺失时 `/hr-setup` 按 uv → pipx → pip 兜底安装；rtk 由 `/rtk-install` 跑官方 install.sh；AgentTeams 平台本体是一套 Docker 容器栈（不是单文件 CLI），`/at-install` 封装官方脚本一键部署，前置 Docker 和一个 LLM API Key（暂不想部署可先 `/at-dashboard demo` 看面板效果）。

1. ZCode → 设置 → 插件管理 → 右上角「+」→ 添加插件市场，填 GitHub 仓库：
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

## zcode-headroom：请求层压缩代理

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

## zcode-rtk：命令输出源头压缩

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

## zcode-agentteams：多智能体协作可视化

**原理**：接入 [AgentTeams](https://github.com/agentscope-ai/AgentTeams)（Manager-Workers 多智能体协作平台，Matrix 房间协作 + Controller 控制面）。插件在本地起一个零依赖 Node 服务（127.0.0.1:8712）聚合 Controller 只读 API，浏览器里实时看项目进展。数据源自动适配，优先级：**AgentTeams Controller（projects 模型，任务 DAG 全功能）→ 本地 Docker 控制面（`/at-install` 装的稳定栈，旧品牌 HiClaw：teams/workers 模型，展示队长/成员/团队实时状态，无 tasks API 时 DAG 区显示说明）→ `agt get projects -o json` 兜底 → 演示数据**。`controllerUrl` 支持 `docker://容器名`（自动 docker inspect 解析容器 IP，不怕 Docker 重启 IP 漂移）。

三层关系一句话说清：**市场装的是插件**（面板 + 命令，无外部依赖）；**AgentTeams 平台本体要单独部署**（`/at-install` 封装官方 install.sh，前置 Docker + LLM API Key，或官方 Helm/K8s 路线）；**部署完 `/at-setup` 接线**（填 Controller 地址与 token），面板即从演示数据切到真实项目。

### 部署平台本体 `/at-install`

```bash
/at-install --use-zcode-key                      # 复用 ZCode 已存的 GLM Key（零新购，Coding Plan 额度）
/at-install --key sk-xxx --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-5.3-flash   # 独立 Key
/at-install --interactive                        # 想逐项自定义：给命令在自己终端跑
/at-install uninstall                            # 停止并移除 Manager + 全部 Worker
```

Key 说明：裸跑 `/at-install` 会先问「Key 用哪种」（复用 ZCode 已存 / 粘贴 GLM Key / 其他家）。Worker 是常驻容器自己调模型，端点+Key 不可省，但**推荐复用 ZCode 的 GLM Key**（OpenAI 兼容端点自动换成 Coding Plan 的 `/api/coding/paas/v4`，会员额度照常，同 ocr 委托模式的复用逻辑）；给 `--key` 时默认也按 GLM 处理（coding 端点 + `glm-5.3-flash`）。多 Worker 并发会加速这份额度的消耗。

非交互封装官方 `agentteams-install.sh`（HiClaw 是 AgentTeams 更名前的旧名，本命令一律用官方新安装器）：自动下载脚本、写入 600 权限的 env（Key 不进 shell 历史）、后台安装并落日志 `~/.zcode-agentteams/install.log`。Docker 未装时给发行版指引（需要 sudo，插件不代办）；装完从日志取访问地址（默认 Element Web 18088 / 网关 18080 / Manager 控制台 18888）与 admin 密码，再自动接线或走 `/at-setup`。

### 可视化面板 `/at-dashboard`

暖白卡片风格面板，内容自上而下：项目卡（成员数/完成度/消息数）→ 队长卡（派发数/执行中人数）→ 总进度条（运行中/等待派发/已交付等 6 态分段）→ 成员卡（状态/进度/队长派发的任务 chip）→ **任务依赖 DAG**（分层布局贝塞尔连线，**悬停高亮上游依赖链、点击固定**并联动底部任务详情：负责人/等待的依赖/完成后解锁谁/工件下载）。默认 5 秒自动刷新，可暂停。

```
/at-dashboard status            # 是否在线、数据源模式
/at-dashboard start             # 后台启动并给出面板地址
/at-dashboard --float           # 浏览器 app 模式无边框小窗 + X11 置顶（悬浮效果）
/at-dashboard demo              # 演示数据模式（无需 Controller，先看界面效果）
/at-dashboard stop              # 停止
```

ZCode 插件没有往 ZCode 界面里嵌自定义面板的能力（插件只有命令/skill/钩子/MCP 四种挂载面），所以完整界面走本地 Web；ZCode 内部看进展用 `/at-status`（对话内 markdown 进度卡）。

### 接入 `/at-setup`

写 `~/.zcode-agentteams/config.json`（Controller 地址、token/tokenFile、team、port、refreshSeconds）→ 验证连通性 → 启动面板。鉴权是 Bearer token（K8s ServiceAccount token 或 Matrix access token），推荐只存 token 文件路径。配好后 SessionStart 钩子每次会话静默拉起面板（`AGENTTEAMS_DASHBOARD_AUTOSTART=0` 关闭）。

### CLI 透传 `/at`

```
/at get projects                    # 项目列表
/at get projects <id> -o json       # workflow：节点/边/任务详情
/at get projects <id> --mermaid     # 依赖图 mermaid 文本
/at project pause|resume|replan|cancel|complete <id>
/at spawn messages <sessionId>      # 成员会话消息流
```
