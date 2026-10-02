# Headroom：请求层压缩代理

[← 返回插件总览](../../README.md#插件一览)

**装后必做：两步。** ① 跑 `/hr-setup`；② 在 ZCode 界面新建自定义供应商（界面操作，无法自动化）。

**原理**：ZCode → Headroom 代理（127.0.0.1:8787，本地压缩工具输出/日志/大 JSON）→ 智谱 GLM。鉴权头原样转发，**GLM 会员额度照常**。

### 第 1 步：`/hr-setup`

确认 headroom 已装（未装则 uv/pipx/pip 兜底安装）→ 后台启动代理（上游自动指向 GLM）→ `headroom doctor` 验证 → 给出界面配置清单。

### 第 2 步：新建自定义供应商（界面操作，无法自动化）

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
- `/hr-proxy start|stop|status|restart`：代理进程管理（日志 `~/.zcode-headroom-proxy.log`）；`/hr-proxy backend cpu|auto`：切换压缩设备；`/hr-proxy power battery|saver|off`：省电自动切换模式（battery 拔电即 CPU；saver 仅省电档 CPU）
- `/hr dashboard`：浏览器实时节省报表；`/hr inspect`：对比原文与压缩结果；其余子命令全透传

### 压缩设备与省电

headroom 压缩模型默认自动选最快设备（CUDA/MPS 显卡优先，回退 CPU）。两个核心配置项写在 `~/.zcode/headroom.json`（文件可不建，全部走默认；`/hr-proxy backend` / `/hr-proxy power` 是它们的快捷命令；`powerWatchInterval` 为附加的轮询间隔调优项）：

| 键 | 默认 | 说明 |
|---|---|---|
| `kompressBackend` | `"auto"` | **强制压缩设备**：`"cpu"` 用 CPU 压缩（省电、不占显存）；`"auto"` 显卡优先；也支持 headroom 原生值 `onnx`/`coreml`/`mps`/`torch` 等，原样透传 |
| `powerSaveCpu` | `"off"` | **省电自动切换**，两种模式：`"battery"` 拔电（电池放电）即 CPU、插电切回；`"saver"` 仅系统省电档（GNOME/KDE 的 power-profiles-daemon 省电档、macOS 低电量模式、Windows 节电模式）才 CPU、退出切回（拔电但档位非省电不动）。`"off"` 关闭。插件起一个后台监视器按需重启代理（重启瞬间在途请求会闪断一次） |
| `powerWatchInterval` | `60` | 监视器轮询间隔秒数（最小 10） |

优先级：省电规则命中（按上述模式）> 配置文件 > headroom 默认；同名环境变量（`HEADROOM_KOMPRESS_BACKEND`、`HEADROOM_POWER_SAVE_CPU=battery|saver|off`、`HEADROOM_POWER_WATCH_INTERVAL`）只在当前进程生效（如手动 `ensure`/`start`），**要持久生效请写配置文件**——桌面启动的 ZCode 环境往往不含用户级环境变量，监视器也只按配置文件 + 电源状态决策。

省电状态检测跨平台（battery 标志 + saver 标志独立判定，可同时成立）：macOS（`pmset`：低电量模式 + 电池放电）、Windows（PowerShell `PowerLineStatus` + 节电模式（Win10 1809+）+ 节能电源计划 GUID，Git Bash/WSL）、Linux（`power-profiles-daemon` 省电档——GNOME 40+/KDE 5.24+ 等主流桌面 + sysfs 电池放电，不依赖具体桌面环境；WSL 下自动改查 Windows 侧）。`saver` 模式依赖 `powerprofilesctl` 可跑：其 shebang 是 `#!/usr/bin/env python3`，在 miniforge/conda 等用户级 Python 靠前的环境里会被劫持而缺 `gi` 崩溃——**插件会自动改用系统 Python 重试**，仍不可用时（真缺 python-gobject / python3-gi）`/hr-proxy power saver`、`status` 与监视器日志会提示按发行版的修复命令，装完即生效无需重启；battery 模式只看 sysfs，完全不受影响。systemd 托管的代理（`/hr-setup` 装的 `headroom-proxy.service`）同样会被监视器切换。

### 自动启动

长期使用建议配置 **systemd 用户服务**（开机自启、崩溃自动重启，`/hr-setup` 第 2 步含完整 unit 内容）——`nohup` 起的进程重启电脑后会丢失，导致 ZCode 提示"重新连接中"。插件另带 SessionStart 钩子兜底：每次会话启动检测 8787 端口，代理没跑就后台拉起（端口探测用 `/livez`）。环境变量可覆盖：`HEADROOM_PROXY_PORT`、`HEADROOM_PROXY_AUTOSTART=0`（关闭）、`HEADROOM_UPSTREAM_ANTHROPIC`（上游地址）、`HEADROOM_KOMPRESS_BACKEND` / `HEADROOM_POWER_SAVE_CPU`（见上节，仅当前进程生效）。
