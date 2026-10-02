#!/bin/sh
# Headroom 插件共享库：配置读取、电源状态检测、压缩后端决策、代理进程管理。
# 被 hooks/ensure-proxy.sh 与 hooks/power-watch.sh 复用（source 使用，不直接执行）。
#
# 配置文件 ~/.zcode/headroom.json（可选，扁平 JSON，由 hr_config_set 重写整文件）：
#   kompressBackend    "auto"（默认，headroom 自动选最快设备：CUDA/MPS 显卡优先）
#                      "cpu" 强制 CPU 压缩；也支持 headroom 原生值 onnx/onnx_cpu/
#                      onnx_coreml/pytorch/pytorch_mps 等（原样透传）
#   powerSaveCpu       省电自动切换模式："battery"（默认，拔电→CPU，插电→切回）|
#                      "saver"（仅系统省电档→CPU，拔电但档位非省电不切）| "off"（关闭）
#   powerWatchInterval 监视器轮询间隔秒数（默认 60，最小 10）
#
# 环境变量覆盖：HEADROOM_KOMPRESS_BACKEND / HEADROOM_POWER_SAVE_CPU（battery|saver|off，
#   兼容 1/0/true/false）/ HEADROOM_POWER_WATCH_INTERVAL / HEADROOM_PROXY_PORT /
#   HEADROOM_PROXY_AUTOSTART / HEADROOM_UPSTREAM_ANTHROPIC / HEADROOM_UPSTREAM_OPENAI
#   仅在当前进程（SessionStart 钩子、手动 ensure/start 等）生效；后台监视器只按
#   配置文件 + 电源状态决策。要持久锁定后端/开关，请写配置文件。

HR_PLUGIN_ROOT="${HR_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"

hr_config_file() { printf '%s\n' "${HOME:-/tmp}/.zcode/headroom.json"; }
hr_state_file() { printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-proxy.state"; }
hr_watch_pidfile() { printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-power-watch.pid"; }
hr_proxy_log() { printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-proxy.log"; }

# 读扁平 JSON 顶层键（字符串或 true/false 布尔）；文件缺失/键缺失时输出默认值。
hr_config_get() { # hr_config_get <key> <default>
    _cf=$(hr_config_file)
    _cv=""
    if [ -r "$_cf" ]; then
        _cv=$(sed -n \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\(true\|false\)[[:space:]]*\(,\|}\)\?.*/\1/p' \
            "$_cf" | head -n 1)
    fi
    printf '%s\n' "${_cv:-$2}"
}

# 重写配置文件（仅本插件拥有的 3 个键，会丢弃其他手工添加的键）
hr_config_set() { # hr_config_set <key> <value>
    _kk=$1 _kv=$2
    _kb=$(hr_config_get kompressBackend auto)
    _kp=$(hr_config_get powerSaveCpu off)
    _kw=$(hr_config_get powerWatchInterval 60)
    case "$_kk" in
        kompressBackend) _kb=$_kv ;;
        powerSaveCpu)
            case "$(printf '%s' "$_kv" | tr '[:upper:]' '[:lower:]')" in
                battery|saver) ;;
                *) _kv=off ;;
            esac
            _kp=$_kv ;;
        powerWatchInterval) _kw=$_kv ;;
        *) printf 'hr_config_set: 未知键 %s\n' "$_kk" >&2; return 1 ;;
    esac
    mkdir -p "$(dirname "$(hr_config_file)")" 2>/dev/null
    printf '{\n  "kompressBackend": "%s",\n  "powerSaveCpu": "%s",\n  "powerWatchInterval": %s\n}\n' \
        "$_kb" "$_kp" "$_kw" >"$(hr_config_file)"
}

# 省电自动切换模式：off | battery（拔电→cpu）| saver（省电档→cpu）。其他值一律 off。
hr_power_save_mode() {
    _hr_m="${HEADROOM_POWER_SAVE_CPU:-$(hr_config_get powerSaveCpu off)}"
    case "$(printf '%s' "$_hr_m" | tr '[:upper:]' '[:lower:]')" in
        battery) printf 'battery\n' ;;
        saver) printf 'saver\n' ;;
        *) printf 'off\n' ;;
    esac
}

hr_watch_interval() {
    _iv="${HEADROOM_POWER_WATCH_INTERVAL:-$(hr_config_get powerWatchInterval 60)}"
    case "$_iv" in ''|*[!0-9]*) _iv=60 ;; esac
    [ "$_iv" -ge 10 ] || _iv=10
    printf '%s\n' "$_iv"
}

# ---------------------------------------------------------------------------
# 电源状态检测：hr_power_flags 输出空格分隔标志，可同时存在——
#   saver   系统省电档/低电量模式/节电模式
#   battery 电池放电中
# 都没有 = 交流供电的正常档位。检测失败（unknown 平台等）输出空 = 按 ac 处理。
#   macOS     pmset（低电量模式 + 电池放电）
#   Linux     power-profiles-daemon 省电档（GNOME 40+/KDE 5.24+ 等主流桌面）
#             + sysfs 电池放电（与桌面环境无关）；WSL 下回退 Windows 侧检测
#   Windows   PowerShell PowerLineStatus/PowerSavingMode + powercfg 节能计划 GUID
#             （Git Bash / MSYS / WSL interop）
hr_power_flags() {
    case "$(uname -s)" in
        Darwin) hr_power_flags_mac ;;
        Linux) hr_power_flags_linux ;;
        MINGW*|MSYS*|CYGWIN*) hr_power_flags_win ;;
        *) printf '\n' ;;
    esac
}

# 展示用单值：saver+battery | saver | battery | ac
hr_power_mode() {
    case " $(hr_power_flags) " in
        *" saver "*" battery "*|*" battery "*" saver "*) printf 'saver+battery\n' ;;
        *" saver "*) printf 'saver\n' ;;
        *" battery "*) printf 'battery\n' ;;
        *) printf 'ac\n' ;;
    esac
}

hr_power_flags_mac() {
    _hr_f=""
    command -v pmset >/dev/null 2>&1 || { printf '\n'; return; }
    pmset -g 2>/dev/null | grep -Eq '^[[:space:]]*lowpowermode[[:space:]]+1' && _hr_f="saver"
    pmset -g batt 2>/dev/null | grep -q 'Battery Power' && _hr_f="$_hr_f battery"
    printf '%s\n' "${_hr_f# }"
}

hr_power_flags_linux() {
    _hr_f=""
    case "$(hr_ppd_get)" in
        *power-saver*) _hr_f="saver" ;;
    esac
    _hr_bat_seen=""
    for _hr_b in /sys/class/power_supply/BAT*; do
        [ -r "$_hr_b/status" ] || continue
        _hr_bat_seen=1
        if grep -q '^Discharging$' "$_hr_b/status" 2>/dev/null; then
            _hr_f="$_hr_f battery"
            break
        fi
    done
    # 无电池可见：台式机按交流处理；WSL 看不到主机电池，改查 Windows 侧
    if [ -z "$_hr_bat_seen" ] && command -v powershell.exe >/dev/null 2>&1; then
        hr_power_flags_win; return
    fi
    printf '%s\n' "${_hr_f# }"
}

hr_power_flags_win() {
    _hr_ps=""
    for _hr_c in powershell.exe powershell; do
        command -v "$_hr_c" >/dev/null 2>&1 && { _hr_ps=$_hr_c; break; }
    done
    [ -n "$_hr_ps" ] || { printf '\n'; return; }
    _hr_out=$("$_hr_ps" -NoProfile -Command 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.SystemInformation]::PowerStatus; $s="Indeterminate"; try{$s=[string]$p.PowerSavingMode}catch{}; "PL=$($p.PowerLineStatus);SAVER=$s;SCHEME=$(powercfg /getactivescheme)"' 2>/dev/null) || { printf '\n'; return; }
    _hr_f=""
    # Windows 节电模式（Win10 1809+），或激活的电源计划是「节能」
    # （计划名会本地化，但 GUID 固定：a1841308-3541-4fab-bc81-f71556f20b4a）
    case "$_hr_out" in
        *SAVER=True*|*a1841308-3541-4fab-bc81-f71556f20b4a*) _hr_f="saver" ;;
    esac
    case "$_hr_out" in
        *PL=Offline*) _hr_f="$_hr_f battery" ;;
    esac
    printf '%s\n' "${_hr_f# }"
}

# powerprofilesctl get 的可靠封装：其 shebang 是 `#!/usr/bin/env python3`，
# 在 miniforge/conda 等用户级 Python 排在 PATH 前面的环境里会被劫持、因缺 gi 崩溃
# （系统已装 python-gobject 也没用）。失败后改用系统 Python 重试。成功时输出档位。
hr_ppd_get() {
    command -v powerprofilesctl >/dev/null 2>&1 || return 1
    _hr_pp=$(command -v powerprofilesctl)
    _hr_out=$(powerprofilesctl get 2>/dev/null) && { printf '%s\n' "$_hr_out"; return 0; }
    if [ -x /usr/bin/python3 ]; then
        _hr_out=$(/usr/bin/python3 "$_hr_pp" get 2>/dev/null) && { printf '%s\n' "$_hr_out"; return 0; }
    fi
    return 1
}

# ---------------------------------------------------------------------------
# saver 档检测可用性（saver 模式依赖；仅 Linux 有意义）：
#   ok      检测可用 / 非 Linux 平台（macOS 用 pmset、Windows 用 PowerShell）
#   missing 未装 powerprofilesctl（需装 power-profiles-daemon）
#   broken  装了但跑不起来（缺 python-gobject，或被无 gi 的用户级 Python 劫持）
hr_saver_detect() {
    case "$(uname -s)" in
        Linux) ;;
        *) printf 'ok\n'; return ;;
    esac
    command -v powerprofilesctl >/dev/null 2>&1 || { printf 'missing\n'; return; }
    if [ -n "$(hr_ppd_get)" ]; then printf 'ok\n'; else printf 'broken\n'; fi
}

# saver 档检测不可用时的修复提示（按发行版给出具体命令）
hr_saver_hint() {
    _hr_st=$(hr_saver_detect)
    _hr_id=""
    [ -r /etc/os-release ] && _hr_id=$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '" ')
    _hr_cmd=""
    if [ "$_hr_st" = "missing" ]; then
        case "$_hr_id" in
            arch|manjaro|endeavouros|garuda|artix) _hr_cmd="sudo pacman -S power-profiles-daemon" ;;
            ubuntu|debian|linuxmint|pop)          _hr_cmd="sudo apt install power-profiles-daemon" ;;
            fedora)                               _hr_cmd="sudo dnf install power-profiles-daemon" ;;
            opensuse*|suse)                       _hr_cmd="sudo zypper install power-profiles-daemon" ;;
            *) _hr_cmd="安装 power-profiles-daemon（提供 powerprofilesctl）" ;;
        esac
    else
        case "$_hr_id" in
            arch|manjaro|endeavouros|garuda|artix) _hr_cmd="sudo pacman -S python-gobject" ;;
            ubuntu|debian|linuxmint|pop)          _hr_cmd="sudo apt install python3-gi" ;;
            fedora)                               _hr_cmd="sudo dnf install python3-gobject" ;;
            opensuse*|suse)                       _hr_cmd="sudo zypper install python3-gobject" ;;
            *) _hr_cmd="安装 python-gobject（Debian/Ubuntu 叫 python3-gi）" ;;
        esac
    fi
    printf '注意：saver 档检测不可用（%s），省电档变化将检测不到（battery 模式不受影响）。修复：%s\n' "$_hr_st" "$_hr_cmd"
}

# ---------------------------------------------------------------------------
# 压缩后端决策。输出 "auto" 表示不设置 HEADROOM_KOMPRESS_BACKEND（显卡优先）。
# 本进程显式设置了 HEADROOM_KOMPRESS_BACKEND 时原样返回（启动路径的临时覆盖）；
# 否则按省电模式判定：battery 模式→电池放电即 cpu；saver 模式→省电档才 cpu；
# 其余情况用配置文件 kompressBackend（默认 auto）。
# 注意：长期驻留的调用方（监视器）每轮须先 unset HEADROOM_KOMPRESS_BACKEND，
# 避免拉起时继承的值锁死决策。
hr_desired_backend() {
    if [ -n "${HEADROOM_KOMPRESS_BACKEND:-}" ]; then
        printf '%s\n' "$HEADROOM_KOMPRESS_BACKEND"
        return
    fi
    _hr_b="$(hr_config_get kompressBackend auto)"
    _hr_mode="$(hr_power_save_mode)"
    if [ "$_hr_b" != "cpu" ] && [ "$_hr_mode" != "off" ]; then
        # 标志两侧补空格后做子串匹配，避免首标志的前导空格被分隔符吞掉
        _hr_fs=" $(hr_power_flags) "
        case "${_hr_mode}|${_hr_fs}" in
            "battery|"*" battery "*|"saver|"*" saver "*) _hr_b=cpu ;;
        esac
    fi
    printf '%s\n' "$_hr_b"
}

# ---------------------------------------------------------------------------
# 代理进程管理
hr_find_headroom() {
    if command -v headroom >/dev/null 2>&1; then command -v headroom; return; fi
    for _hr_c in "${HOME:-}/.local/bin/headroom" "${HOME:-}/miniforge3/bin/headroom" \
                 "${HOME:-}/.cargo/bin/headroom" /usr/local/bin/headroom /usr/bin/headroom; do
        if [ -x "$_hr_c" ]; then printf '%s\n' "$_hr_c"; return; fi
    done
    return 1
}

# 端口探测：/livez（headroom 官方端点，毫秒级；根路径 / 会挂起不可用），/health 兜底。
# curl 收到任意 HTTP 响应即算在线（端口被占则不该重复拉起，与旧版 / 探测语义一致）。
hr_port_up() {
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/livez" 2>/dev/null && return 0
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/health" 2>/dev/null
}

hr_state_get() { # hr_state_get <key> <default>
    _hr_sf=$(hr_state_file)
    _hr_sv=""
    [ -r "$_hr_sf" ] && _hr_sv=$(sed -n "s/^$1=//p" "$_hr_sf" | head -n 1)
    printf '%s\n' "${_hr_sv:-$2}"
}

hr_state_set() { # hr_state_set <key> <value>（同键覆盖）
    _hr_sf=$(hr_state_file)
    grep -v "^$1=" "$_hr_sf" 2>/dev/null >"${_hr_sf}.tmp"
    printf '%s=%s\n' "$1" "$2" >>"${_hr_sf}.tmp"
    mv "${_hr_sf}.tmp" "$_hr_sf"
}

# 后台启动代理并写状态文件。hr_proxy_start <port> <backend>
hr_proxy_start() {
    _hr_port=$1 _hr_backend=$2
    _hr_bin=$(hr_find_headroom) || return 1
    [ -n "$_hr_bin" ] || return 1
    if [ "$_hr_backend" = "auto" ]; then
        ANTHROPIC_TARGET_API_URL="${HEADROOM_UPSTREAM_ANTHROPIC:-https://open.bigmodel.cn/api/anthropic}" \
        OPENAI_TARGET_API_URL="${HEADROOM_UPSTREAM_OPENAI:-https://open.bigmodel.cn/api/paas/v4}" \
        nohup "$_hr_bin" proxy --port "$_hr_port" >>"$(hr_proxy_log)" 2>&1 &
    else
        HEADROOM_KOMPRESS_BACKEND="$_hr_backend" \
        ANTHROPIC_TARGET_API_URL="${HEADROOM_UPSTREAM_ANTHROPIC:-https://open.bigmodel.cn/api/anthropic}" \
        OPENAI_TARGET_API_URL="${HEADROOM_UPSTREAM_OPENAI:-https://open.bigmodel.cn/api/paas/v4}" \
        nohup "$_hr_bin" proxy --port "$_hr_port" >>"$(hr_proxy_log)" 2>&1 &
    fi
    printf '%s %s ensure-proxy: start headroom proxy port=%s backend=%s\n' \
        "$(date '+%F %T')" "$(uname -s)" "$_hr_port" "$_hr_backend" >>"$(hr_proxy_log)"
    hr_state_set pid "$!"
    hr_state_set port "$_hr_port"
    hr_state_set backend "$_hr_backend"
    hr_state_set managed yes
}

# 停止代理（优先状态文件里的 pid，回退按端口精确匹配 pkill）并清除状态。
hr_proxy_stop() { # hr_proxy_stop <port>
    _hr_pid=$(hr_state_get pid "")
    if [ -n "$_hr_pid" ] && kill -0 "$_hr_pid" 2>/dev/null; then
        kill "$_hr_pid" 2>/dev/null
    fi
    pkill -f "headroom proxy --port $1" 2>/dev/null
    rm -f "$(hr_state_file)"
}

hr_systemd_managed() {
    command -v systemctl >/dev/null 2>&1 || return 1
    [ "$(systemctl --user is-active headroom-proxy 2>/dev/null)" = "active" ]
}

# ---------------------------------------------------------------------------
# 电源监视器（power-watch.sh）单实例管理
hr_watch_running() {
    _hr_pf=$(hr_watch_pidfile)
    [ -r "$_hr_pf" ] && kill -0 "$(cat "$_hr_pf" 2>/dev/null)" 2>/dev/null
}

hr_watch_start() {
    hr_watch_running && return 0
    nohup /bin/sh "$HR_PLUGIN_ROOT/hooks/power-watch.sh" >>"$(hr_proxy_log)" 2>&1 &
    printf '%s\n' "$!" >"$(hr_watch_pidfile)"
}

hr_watch_stop() {
    _hr_pf=$(hr_watch_pidfile)
    if [ -r "$_hr_pf" ]; then
        _hr_wpid=$(cat "$_hr_pf" 2>/dev/null)
        [ -n "$_hr_wpid" ] && kill "$_hr_wpid" 2>/dev/null
        rm -f "$_hr_pf"
    fi
}
