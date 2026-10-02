---
description: 管理 Headroom 本地代理进程：启动（上游默认 GLM）/停止/状态/重启/压缩后端/省电切换。示例：/hr-proxy status ｜ /hr-proxy start ｜ /hr-proxy restart ｜ /hr-proxy backend cpu ｜ /hr-proxy power battery
argument-hint: <start|stop|status|restart|backend <cpu|auto|…>|power <battery|saver|off>> [--port <端口>] [--upstream-anthropic <url>] [--upstream-openai <url>]
allowed-tools: Bash(sh:*), Bash(headroom:*), Bash(curl:*), Bash(ls:*), Bash(pgrep:*), Bash(pkill:*), Bash(systemctl:*)
---

管理本机 Headroom 压缩代理进程。**`$ARGUMENTS` 原样作为参数来源**：第一个位置参数是动作（`start|stop|status|restart|backend|power`，缺省视为 `status`），`--port`、`--upstream-*` 等其余参数按下方约定使用，不做改写。

## 通用约定

- 生命周期与 CPU/省电逻辑统一在插件脚本 `ensure-proxy.sh`（含 stub 测试过的启动环境、状态文件、电源监视器），先定位它：

```bash
HR_HOOK=$(ls ~/.zcode/cli/plugins/cache/duanluan-zcode-plugins/headroom/*/hooks/ensure-proxy.sh 2>/dev/null | tail -1)
```

- 端口：`${HEADROOM_PROXY_PORT:-8787}`（`--port` 可覆盖，作为 `HEADROOM_PROXY_PORT` 环境变量传入脚本）
- 上游默认：Anthropic → `https://open.bigmodel.cn/api/anthropic`，OpenAI → `https://open.bigmodel.cn/api/paas/v4`（`HEADROOM_UPSTREAM_ANTHROPIC` / `HEADROOM_UPSTREAM_OPENAI` 环境变量可覆盖）
- 日志：`~/.zcode-headroom-proxy.log`
- 在线探测用 `/livez` 或 `/health`（**不要探测根路径 `/`，会挂起**）

## 动作

### status

```bash
sh "$HR_HOOK" status
```

输出：端口在线状态、进程、插件是否托管（状态文件）、当前/期望压缩后端、电源状态、省电自动切换开关、监视器进程。

### start / restart / stop

```bash
sh "$HR_HOOK" start     # 幂等：端口已在线则跳过（systemd 托管时不动服务）
sh "$HR_HOOK" restart
sh "$HR_HOOK" stop      # 停代理 + 停电源监视器
```

**注意**：停止代理后，ZCode 里指向 `http://127.0.0.1:<port>` 的供应商会断连——提醒用户切回直连供应商，或尽快重新 start。

### backend `<cpu|auto|onnx|coreml|mps|torch…>`

```bash
sh "$HR_HOOK" backend cpu   # 强制 CPU 压缩（写 ~/.zcode/headroom.json 并重启生效）
sh "$HR_HOOK" backend auto  # 恢复默认：headroom 自动选最快设备（CUDA/MPS 显卡优先）
```

### power `<on|battery|saver|off>`

```bash
sh "$HR_HOOK" power battery   # 拔电（电池放电）→ CPU 压缩，插电切回
sh "$HR_HOOK" power saver     # 仅系统省电档 → CPU 压缩，退出切回（拔电但档位非省电不动）
sh "$HR_HOOK" power off       # 关闭省电自动切换
```

开启后插件起一个后台监视器（默认 60s 轮询，`~/.zcode/headroom.json` 的 `powerWatchInterval` 可调），需要切后端时自动重启代理（**重启瞬间在途请求会闪断一次**）。systemd 托管的代理同样支持（经 `systemctl --user set-environment` + `restart`）。`saver` 模式依赖 `powerprofilesctl` 可用：不可用时 `power saver` 与 `status` 会自动提示按发行版的修复命令（如 Manjaro/Arch 装 `python-gobject`），按提示装完即生效，无需重启；battery 模式只看 sysfs，不受影响。

## 找不到脚本时（内联等价命令）

```bash
# 在线探测
curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 http://127.0.0.1:<port>/livez
# 后台启动（backend 非默认时按需加 HEADROOM_KOMPRESS_BACKEND=cpu）
ANTHROPIC_TARGET_API_URL=<anthropic上游> OPENAI_TARGET_API_URL=<openai上游> \
nohup headroom proxy --port <port> >> ~/.zcode-headroom-proxy.log 2>&1 &
```
