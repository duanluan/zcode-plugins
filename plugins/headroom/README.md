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
- `/hr-proxy start|stop|status|restart`：代理进程管理（日志 `~/.zcode-headroom-proxy.log`）
- `/hr dashboard`：浏览器实时节省报表；`/hr inspect`：对比原文与压缩结果；其余子命令全透传

### 自动启动

长期使用建议配置 **systemd 用户服务**（开机自启、崩溃自动重启，`/hr-setup` 第 2 步含完整 unit 内容）——`nohup` 起的进程重启电脑后会丢失，导致 ZCode 提示"重新连接中"。插件另带 SessionStart 钩子兜底：每次会话启动检测 8787 端口，代理没跑就后台拉起。环境变量可覆盖：`HEADROOM_PROXY_PORT`、`HEADROOM_PROXY_AUTOSTART=0`（关闭）、`HEADROOM_UPSTREAM_ANTHROPIC`（上游地址）。
