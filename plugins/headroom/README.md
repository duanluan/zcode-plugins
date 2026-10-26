# Headroom：请求层压缩代理

[← 返回插件总览](../../README.md#-插件一览)

**装后必做：一步。** 跑 `/hr-setup`——headroom 安装、代理启动、供应商接入（自动创建或迁移注册，界面手建只是回退方式，见第 2 步）一次完成。

**原理**：ZCode → Headroom 代理（127.0.0.1:8787，本地压缩工具输出/日志/大 JSON）→ 接入的上游（默认智谱 GLM；任意供应商可经 /hr-join 接入，按 API key 分流）。API Key 原样转发，**会员额度照常**。

### `/hr-setup`

确认 headroom 已装（未装则 uv/pipx/pip 兜底安装）→ 后台启动代理（上游自动指向 GLM）→ `headroom doctor` 验证 → 供应商接入（已有指 8787 的存量供应商自动注册迁移；直连厂商的（MiMo、中转站）逐个询问是否接入；一个都没有时自动新建，失败才走下面的界面手建）。

### 回退：在界面手动新建自定义供应商（自动创建失败时）

自带的“智谱”供应商走内部 OAuth、接入地址写死，**指不了代理**，所以必须新建。设置 → 模型设置 → 供应商列表“+ 添加供应商”：

| 字段 | 填写值 | 说明 |
|---|---|---|
| 名称 | `BigModel`（随意） | 出现在自定义供应商区 |
| **API 格式** | **Anthropic Messages (/v1/messages)** | **不要选 Chat Completions**——headroom 转发保留 `/v1` 前缀，bigmodel 无该路径，必 404 |
| Base URL | `http://127.0.0.1:8787` | 指向本地代理 |
| API Key | 你的 GLM API Key | 代理原样转发，会员额度照常 |
| 模型列表 | `glm-5.3`、`glm-5.3-flash` | 与直连时相同的模型 ID |

保存并“已启用”，聊天时选该供应商下的模型即开始压缩。**自带“智谱”保留不动**——它就是回退开关，切回即"关闭"压缩。

### 🚀 日常命令

- `/hr-status`：代理状态 + doctor 健康检查 + token 节省报告
- `/hr-proxy start|stop|status|restart`：代理管理（日志 `~/.zcode-headroom-proxy.log`）；`/hr-proxy backend cpu|auto`：切换压缩设备；`/hr-proxy power battery|saver|off`：省电自动切换模式（battery 拔电即 CPU；saver 仅省电档 CPU）
- `/hr dashboard`：浏览器实时节省报表；`/hr inspect`：对比原文与压缩结果；其余子命令原样传入

**图形化设置页面在 [zcode-pro](https://github.com/duanluan/zcode-pro) 中**：用“ZCode Pro”启动 ZCode 后，右键侧边栏底部的设置按钮（齿轮）打开设置窗口，“Headroom”页管理压缩设备、省电切换与代理运行状态，以及 headroom 本体的检查更新与升级。

### ⚡ 压缩设备与省电

headroom 压缩模型默认自动选最快设备（CUDA/MPS 显卡优先，回退 CPU）。两个核心配置项写在 `~/.zcode/headroom.json`（文件可不建，全部走默认；`/hr-proxy backend` / `/hr-proxy power` 是它们的快捷命令；`powerWatchInterval` 为附加的轮询间隔调优项）：

| 键 | 默认 | 说明 |
|---|---|---|
| `kompressBackend` | `"auto"` | **强制压缩设备**：`"cpu"` 用 CPU 压缩（省电、不占显存）；`"auto"` 显卡优先；也支持 headroom 原生值 `onnx`/`coreml`/`mps`/`torch` 等，原样传入 |
| `powerSaveCpu` | `"off"` | **省电自动切换**，两种模式：`"battery"` 拔电（电池放电）即 CPU、插电切回；`"saver"` 仅系统省电档（GNOME/KDE 的 power-profiles-daemon 省电档、macOS 低电量模式、Windows 节电模式）才 CPU、退出切回（拔电但档位非省电不动）。`"off"` 关闭。插件起一个后台监视器按需重启代理（重启瞬间正在进行的请求可能中断一次） |
| `powerWatchInterval` | `60` | 监视器轮询间隔秒数（最小 10） |

优先级：省电规则命中（按上述模式）> 配置文件 > headroom 默认；同名环境变量（`HEADROOM_KOMPRESS_BACKEND`、`HEADROOM_POWER_SAVE_CPU=battery|saver|off`、`HEADROOM_POWER_WATCH_INTERVAL`）只在当前进程生效（如手动 `ensure`/`start`），**要持久生效请写配置文件**——桌面启动的 ZCode 环境往往不含用户级环境变量，监视器也只按配置文件 + 电源状态决策。

省电状态检测跨平台（battery 标志 + saver 标志独立判定，可同时成立）：macOS（`pmset`：低电量模式 + 电池放电）、Windows（PowerShell `PowerLineStatus` + 节电模式（Win10 1809+）+ 节能电源计划 GUID，Git Bash/WSL）、Linux（`power-profiles-daemon` 省电档——GNOME 40+/KDE 5.24+ 等主流桌面 + sysfs 电池放电，不依赖具体桌面环境；WSL 下自动改查 Windows 侧）。`saver` 模式依赖 `powerprofilesctl` 可跑：其 shebang 是 `#!/usr/bin/env python3`，在 miniforge/conda 等用户级 Python 靠前的环境里会被劫持而缺 `gi` 崩溃——**插件会自动改用系统 Python 重试**，仍不可用时（真缺 python-gobject / python3-gi）`/hr-proxy power saver`、`status` 与监视器日志会提示按发行版的修复命令，装完即生效无需重启；battery 模式只看 sysfs，完全不受影响。systemd 托管的代理（`/hr-setup` 装的 `headroom-proxy.service`）同样会被监视器切换。

### 🔄 自动启动

长期使用建议配置 **systemd 用户服务**（开机自启、崩溃自动重启，`/hr-setup` 含完整 unit 内容；**接入多供应商路由（/hr-join）后不要建**——8787 由路由器接管，systemd 的自动重启会反复抢端口）——`nohup` 启动的代理重启电脑后会丢失，导致 ZCode 提示"重新连接中"。插件另带兜底：每次会话启动或恢复时（SessionStart 的 `startup|resume` 匹配值；重启电脑后打开应用恢复旧会话触发的是 `resume`，只匹配 `startup` 会漏掉）检测 8787 端口，代理没跑就后台启动（端口探测用 `/livez`）；生命周期动作带跨进程锁，多个会话同时触发也不会重复拉起，启动中尚未监听端口的实例也不会被误杀重拉（30 秒宽限，超期按卡死重拉）。环境变量可覆盖：`HEADROOM_PROXY_PORT`、`HEADROOM_PROXY_AUTOSTART=0`（关闭）、`HEADROOM_UPSTREAM_ANTHROPIC`（上游地址）、`HEADROOM_KOMPRESS_BACKEND` / `HEADROOM_POWER_SAVE_CPU`（见上节，仅当前进程生效）。

### 🪟 Windows

1.2.0 起原生支持 Windows，无需 sh/Git Bash，钩子也**无需预装 Node.js**：经 `hooks/runtime.cmd` 跨平台启动器拉起，自动找可用运行时——PATH 里的 node → 常见安装位置（nvm/volta/conda/scoop 等）→ ZCode 自带运行时（ELECTRON_RUN_AS_NODE，桌面版自带、零依赖）。MCP 取回工具（`headroom mcp serve`）需 PATH 里有 node：缺失时该工具自动缺席，代理与压缩本体不受影响。Windows 侧的代理生命周期（detached 启动、taskkill 树杀 + 按端口兜底）、状态输出、电源监视器（`power-watch.mjs`）均为 node 原生实现，Linux/macOS 上入口内部仍委托原 `ensure-proxy.sh`，行为不变。headroom 本体装法：zcode-pro 面板一键安装（pip 通道），或手动 `py -m pip install "headroom-ai[all]"`；无 systemd，开机自启依赖会话启动钩子兜底（或自行设计划任务）。

### 📊 压缩记录面板（ZCode ≥ 3.15.1 桌面端）

活跃会话右侧面板区“headroom 压缩记录”：展示压缩节省总览（累计/今天/近 7 天/近 30 天的节省 token、费用与调用次数，统计覆盖全部模型，来自 `headroom savings` 台账；台账覆盖期短于 30 天时近 30 天卡与累计相同会自动隐藏）、近 14 天每日节省柱状图（每根柱子带日期，悬停或点击看当天明细，默认显示峰值日）、压缩率（整体=总省/总原，与 headroom 官方面板同口径；单次最好）、按模型分布（只有一个有效模型时自动隐藏；逐条聚合 `savings_events` 事件账本），并可按哈希取回压缩前的原文——“最近被压缩的内容”列表点击即可查看压缩前原文（约 30 分钟内有效，过期自动消失，显示哈希前 8 位），或把对话压缩标记“[N items compressed... hash=xxx]”里的 xxx 填入取回框。面板由独立的 headroom-ui 服务提供（经现有单例桥调用 headroom_retrieve，不改动桥本身），原有 MCP 工具不受影响。

### 🔀 多供应商压缩路由（/hr-join）

任意自定义供应商（中转站/官方，如 MiMo、聚合中转）都能接入压缩；没有现成供应商也能一键新建（GLM 场景自动复制官方模型清单）：`/hr-join` 从供应商配置自动读出上游地址与协议格式，记录映射后把它的 baseUrl 统一改为 `http://127.0.0.1:8787`；本地路由器按请求里的 **API key**（只存哈希）识别供应商，转给对应 headroom 实例压缩后把鉴权原样透传给真实上游。`/hr-join off` 随时还原原始 baseUrl。兼容边界：anthropic 格式任意上游可用；openai 格式需上游为 /v1 形态（GLM 官方 openai 接口是 /v4 形态，GLM 请用 anthropic 地址接入）。同一上游的多个供应商共享实例；不接入的供应商不受任何影响。
