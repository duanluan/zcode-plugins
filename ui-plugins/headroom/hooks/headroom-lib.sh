#!/bin/sh
# Headroom 插件共享库：配置读取、电源状态检测、压缩后端决策、代理进程管理。
# 被 hooks/ensure-proxy.sh 与 hooks/power-watch.sh 复用（source 使用，不直接执行）。
#
# 配置文件 ~/.zcode/headroom.json（可选，扁平 JSON，hr_config_set 只改目标键、
# 其余键原样保留）：
#   kompressBackend    "auto"（默认，headroom 自动选最快设备：CUDA/MPS 显卡优先）
#                      "cpu" 强制 CPU 压缩；也支持 headroom 原生值 onnx/onnx_cpu/
#                      onnx_coreml/pytorch/pytorch_mps 等（原样透传）
#   powerSaveCpu       省电自动切换模式："off"（关闭，默认；与 mjs 版一致）|
#                      "battery"（拔电→CPU，插电→切回）|
#                      "saver"（仅系统省电档→CPU，拔电但档位非省电不切）
#   powerWatchInterval 监视器轮询间隔秒数（默认 60，最小 10）
#
# 环境变量覆盖：HEADROOM_KOMPRESS_BACKEND / HEADROOM_POWER_SAVE_CPU（battery|saver|off，
#   兼容 1/0/true/false）/ HEADROOM_POWER_WATCH_INTERVAL / HEADROOM_PROXY_PORT /
#   HEADROOM_PROXY_AUTOSTART / HEADROOM_UPSTREAM_ANTHROPIC / HEADROOM_UPSTREAM_OPENAI
#   仅在当前进程（SessionStart 钩子、手动 ensure/start 等）生效；后台监视器只按
#   配置文件 + 电源状态决策。要持久锁定后端/开关，请写配置文件。

HR_PLUGIN_ROOT="${HR_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"

hr_config_file() { printf '%s\n' "${HR_HEADROOM_CONFIG:-${HOME:-/tmp}/.zcode/headroom.json}"; }
hr_state_file() { printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-proxy.state"; }
hr_watch_pidfile() { printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-power-watch.pid"; }
hr_proxy_log() { printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-proxy.log"; }

# 读扁平 JSON 顶层键（字符串、true/false 布尔或裸数字）；文件缺失/键缺失时输出默认值。
# 四种取值各一条 sed 表达式：POSIX BRE 没有 \| \? 这类 GNU 扩展，写成四条更稳。
# 裸数字那条是给 powerWatchInterval 的——hr_config_set 与 mjs configSet 都把它写成
# 不带引号的数字，只认引号字符串的旧写法永远读不回来。小数分支放在整数分支前面：
# 只有整数分支时 "60.5" 会被拆成 "5" 读回来（贪婪前缀把整数部分吃掉）。
hr_config_get() { # hr_config_get <key> <default>
    _cf=$(hr_config_file)
    _cv=""
    if [ -r "$_cf" ]; then
        _cv=$(sed -n \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*true.*/true/p' \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*false.*/false/p' \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
            -e 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
            "$_cf" | head -n 1)
    fi
    printf '%s\n' "${_cv:-$2}"
}

# 在整份配置上只改目标键（用 python3 合并写回；其余键——hr-join 注册的 providers/
# router/instances 等——原样保留。以前只写本插件三个键重盖整文件，会把它们整个丢掉，
# 接入后跑一次 backend/power 设置全部供应商就断流，见 ADR-0008 坑清单）
hr_config_set() { # hr_config_set <key> <value>
    _kk=$1 _kv=$2
    case "$_kk" in
        kompressBackend|powerWatchInterval) ;;
        powerSaveCpu)
            # 归一后写盘（1/true→battery、0/false→off）：以前只拿小写值做判断、写盘
            # 仍是原字符串，"BATTERY" 这类值会原样进配置，mjs 侧读到只当 off
            _kv=$(printf '%s' "$_kv" | tr '[:upper:]' '[:lower:]')
            case "$_kv" in 1|true) _kv=battery ;; 0|false) _kv=off ;; esac
            case "$_kv" in
                battery|saver|off) ;;
                *) printf 'hr_config_set: powerSaveCpu 只接受 battery|saver|off（兼容 1/0/true/false）\n' >&2
                   return 1 ;;
            esac ;;
        *) printf 'hr_config_set: 未知键 %s\n' "$_kk" >&2; return 1 ;;
    esac
    mkdir -p "$(dirname "$(hr_config_file)")" 2>/dev/null
    python3 - "$_kk" "$_kv" "$(hr_config_file)" <<'PY' || return 1
import json, os, sys
key, val, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cfg = json.load(open(path, encoding='utf8'))
except Exception:
    cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
cfg.setdefault('kompressBackend', 'auto')
cfg.setdefault('powerSaveCpu', 'off')
cfg.setdefault('powerWatchInterval', 60)
if key == 'powerWatchInterval':
    try:
        cfg[key] = int(val)
    except ValueError:
        cfg[key] = 60
else:
    cfg[key] = val
# 先写临时文件再改名：这份配置还装着 providers/router/instances，直接重写时
# 写一半被杀（钩子超时强杀常见）会把整份 JSON 截断。0600：配置里可能带供应商 key，
# 别让同机其他用户读到（残留的旧临时文件权限可能偏松，写完再补一次 chmod）
tmp = '%s.%d.tmp' % (path, os.getpid())
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf8') as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write('\n')
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

# 省电自动切换模式：off | battery（拔电→cpu）| saver（省电档→cpu）。其他值一律 off。
hr_power_save_mode() {
    _hr_m="${HEADROOM_POWER_SAVE_CPU:-$(hr_config_get powerSaveCpu off)}"
    case "$(printf '%s' "$_hr_m" | tr '[:upper:]' '[:lower:]')" in
        battery) printf 'battery\n' ;;
        saver) printf 'saver\n' ;;
        1|true) printf 'battery\n' ;;
        0|false) printf 'off\n' ;;
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

# 停完等端口真的空出来再启：旧进程还没退出就拉新进程，新进程绑不上端口
hr_wait_port_free() { # hr_wait_port_free <port>，最多等 5 秒
    _hr_t=5
    while hr_port_up "$1"; do
        [ "$_hr_t" -gt 0 ] || return 1
        _hr_t=$((_hr_t - 1))
        sleep 1
    done
    return 0
}

hr_state_get() { # hr_state_get <key> <default>
    _hr_sf=$(hr_state_file)
    _hr_sv=""
    [ -r "$_hr_sf" ] && _hr_sv=$(sed -n "s/^$1=//p" "$_hr_sf" | head -n 1)
    printf '%s\n' "${_hr_sv:-$2}"
}

hr_state_set() { # hr_state_set <key> <value>（同键覆盖）
    _hr_sf=$(hr_state_file)
    # 临时文件带 pid 后缀再改名：固定名 .tmp 会被并发调用互相写坏，改名是原子的
    _hr_st="${_hr_sf}.$$.tmp"
    grep -v "^$1=" "$_hr_sf" 2>/dev/null >"$_hr_st"
    printf '%s=%s\n' "$1" "$2" >>"$_hr_st"
    mv "$_hr_st" "$_hr_sf"
}

# 后台启动代理并写状态文件。hr_proxy_start <port> <backend>
# 动作段抢生命周期锁（抢不到按 ensure 语义静默跳过）：几套入口并行动作会抢同一端口。
hr_proxy_start() {
    _hr_port=$1 _hr_backend=$2
    hr_lock_acquire ensure || return 1
    _hr_bin=$(hr_find_headroom) || { hr_lock_release; return 1; }
    if [ -z "$_hr_bin" ]; then hr_lock_release; return 1; fi
    # </dev/null：别继承钩子的 stdin，后台进程占着管道不放会把调用方挂住
    if [ "$_hr_backend" = "auto" ]; then
        ANTHROPIC_TARGET_API_URL="${HEADROOM_UPSTREAM_ANTHROPIC:-https://open.bigmodel.cn/api/anthropic}" \
        OPENAI_TARGET_API_URL="${HEADROOM_UPSTREAM_OPENAI:-https://open.bigmodel.cn/api/paas/v4}" \
        nohup "$_hr_bin" proxy --port "$_hr_port" >>"$(hr_proxy_log)" 2>&1 </dev/null &
    else
        HEADROOM_KOMPRESS_BACKEND="$_hr_backend" \
        ANTHROPIC_TARGET_API_URL="${HEADROOM_UPSTREAM_ANTHROPIC:-https://open.bigmodel.cn/api/anthropic}" \
        OPENAI_TARGET_API_URL="${HEADROOM_UPSTREAM_OPENAI:-https://open.bigmodel.cn/api/paas/v4}" \
        nohup "$_hr_bin" proxy --port "$_hr_port" >>"$(hr_proxy_log)" 2>&1 </dev/null &
    fi
    printf '%s %s ensure-proxy: start headroom proxy port=%s backend=%s\n' \
        "$(date '+%F %T')" "$(uname -s)" "$_hr_port" "$_hr_backend" >>"$(hr_proxy_log)"
    hr_state_set pid "$!"
    hr_state_set port "$_hr_port"
    hr_state_set backend "$_hr_backend"
    hr_state_set managed yes
    hr_lock_release
}

# 停止代理（优先状态文件里的 pid，回退按端口精确匹配 pkill）并清除状态。
# 同样包在生命周期锁里（stop 语义：抢不到就等，用户显式停止最终要生效）。
hr_proxy_stop() { # hr_proxy_stop <port>
    hr_lock_acquire stop
    _hr_pid=$(hr_state_get pid "")
    if [ -n "$_hr_pid" ] && kill -0 "$_hr_pid" 2>/dev/null; then
        kill "$_hr_pid" 2>/dev/null
    fi
    pkill -f "headroom proxy --port $1" 2>/dev/null
    rm -f "$(hr_state_file)"
    hr_lock_release
}

hr_systemd_managed() {
    command -v systemctl >/dev/null 2>&1 || return 1
    [ "$(systemctl --user is-active headroom-proxy 2>/dev/null)" = "active" ]
}

# ---------------------------------------------------------------------------
# 电源监视器（power-watch.sh）单实例管理。pid 文件内容是"pid 启动时间戳"两字段
# （与 mjs 版一致）：带启动时间是为了让监视器退出时能核对文件还是自己写的那份，
# 不会误删接班的新监视器的 pid 文件。
hr_watch_pid() { # 只取第一段作 pid；空/非数字视为无效
    _hr_wp=$(head -n 1 "$(hr_watch_pidfile)" 2>/dev/null)
    _hr_wp=${_hr_wp%% *}
    case "$_hr_wp" in ''|*[!0-9]*) return 1 ;; esac
    printf '%s\n' "$_hr_wp"
}

hr_watch_running() {
    _hr_wp=$(hr_watch_pid) || return 1
    kill -0 "$_hr_wp" 2>/dev/null
}

hr_watch_start() {
    hr_watch_running && return 0
    _hr_pf=$(hr_watch_pidfile)
    # 残留的失效记录（进程已不在）清掉，别挡住下面的排他创建
    [ -e "$_hr_pf" ] && ! hr_watch_running && rm -f "$_hr_pf"
    # 拉起前先排他创建 pid 文件（noclobber）：查与写分成两步时，并发的两次调用都会
    # 看到"没在跑"，各拉起一个监视器。创建时先写拉起方自己的 pid：拉起方中途被杀
    # 留下的是可识别的失效记录，不会是空文件把后续启动一直挡住
    ( set -C; printf '%s %s\n' "$$" "$(date +%s)" >"$_hr_pf" ) 2>/dev/null || return 0
    # HR_LIFECYCLE_LOCK_HELD 置空给监视器：常驻的它后面自己还要抢生命周期锁
    HR_LIFECYCLE_LOCK_HELD= nohup /bin/sh "$HR_PLUGIN_ROOT/hooks/power-watch.sh" \
        >>"$(hr_proxy_log)" 2>&1 </dev/null &
}

hr_watch_stop() {
    _hr_wline=$(tr -d '\r' <"$(hr_watch_pidfile)" 2>/dev/null)
    _hr_wpid=$(hr_watch_pid) && kill "$_hr_wpid" 2>/dev/null
    # 只删自己刚读到的那份 pid 文件：杀进程到删文件之间可能已有新监视器接班写入，
    # 无条件删会把接班者的登记删掉、下次再拉起一个变双监视器
    if [ -n "$_hr_wline" ] && [ "$(tr -d '\r' <"$(hr_watch_pidfile)" 2>/dev/null)" = "$_hr_wline" ]; then
        rm -f "$(hr_watch_pidfile)"
    fi
}

# ---------------------------------------------------------------------------
# 生命周期动作互斥锁（与 mjs 版 acquireLifecycleLock 同语义）：ensure-proxy.sh 的
# 动作入口、hr_proxy_start/stop、power-watch.sh 的切后端段共用同一把锁目录——几套
# 入口并行动作会抢同一端口、互相删状态文件。锁目录用 mkdir 原子创建；抢不到时按动作
# 决定：ensure/start 是幂等的自动动作，静默跳过；stop/restart/backend/power 是用户
# 显式操作，最多等 20 秒后强制接管。持有者死亡或抢锁超过 60 秒视为悬挂的锁，直接强制接管——钩子
# 30 秒超时被强杀不走释放，只能靠超时兜底。锁目录里写持有者（pid + 随机 token +
# 抢锁时间三行）：释放前核对还是自己那份才删——锁可能已被别人强制接管，把新锁删掉
# 会让两个动作同时跑。经 ensure-proxy.mjs / hr-multi.mjs 转进来时调用方已持同一把锁
# （它们 spawn 时置 HR_LIFECYCLE_LOCK_HELD=1），见到该变量跳过加锁，避免父子互锁。
# 同一进程内可重入：已持锁的入口再调 hr_proxy_start/stop 不重复抢。
HR_LOCK_TOKEN=""
HR_LOCK_DEPTH=0

hr_lock_path() {
    if [ -n "${HR_HEADROOM_CONFIG:-}" ]; then
        printf '%s\n' "$(dirname "$HR_HEADROOM_CONFIG")/hr-ensure-test.lock"
    else
        printf '%s\n' "${HOME:-/tmp}/.zcode-headroom-ensure.lock"
    fi
}

# 锁里记的持有者还是自己（pid + token 都对）才算持有
hr_lock_holder_is_us() {
    _hr_ld=$(hr_lock_path)
    [ -r "$_hr_ld/holder" ] || return 1
    [ "$(sed -n '1p' "$_hr_ld/holder" 2>/dev/null)" = "$$" ] || return 1
    [ "$(sed -n '2p' "$_hr_ld/holder" 2>/dev/null)" = "$HR_LOCK_TOKEN" ]
}

hr_lock_try() {
    _hr_ld=$(hr_lock_path)
    mkdir "$_hr_ld" 2>/dev/null || return 1
    printf '%s\n%s\n%s\n' "$$" "$HR_LOCK_TOKEN" "$(date +%s)" >"$_hr_ld/holder" 2>/dev/null
    # mkdir 到写 holder 之间有窗口，写完核对还是自己：中间可能已被别人强制接管
    hr_lock_holder_is_us
}

# 持有者死亡，或抢锁超过 60 秒（holder 第三行是抢锁时间）→ 视为悬挂的锁，可强制接管。
# holder 只有两行（mjs 版写的）时年龄未知，按活着处理不抢
hr_lock_stale() {
    _hr_ld=$(hr_lock_path)
    _hr_hp=$(sed -n '1p' "$_hr_ld/holder" 2>/dev/null)
    [ -n "$_hr_hp" ] || return 0
    kill -0 "$_hr_hp" 2>/dev/null || return 0
    _hr_ht=$(sed -n '3p' "$_hr_ld/holder" 2>/dev/null)
    case "$_hr_ht" in ''|*[!0-9]*) return 1 ;; esac
    _hr_now=$(date +%s)
    [ $((_hr_now - _hr_ht)) -ge 60 ]
}

# hr_lock_acquire <action>：返回 0=继续（已持锁或按无锁继续），1=跳过本次动作
hr_lock_acquire() {
    [ -n "${HR_LIFECYCLE_LOCK_HELD:-}" ] && return 0
    if [ "$HR_LOCK_DEPTH" -gt 0 ]; then
        HR_LOCK_DEPTH=$((HR_LOCK_DEPTH + 1))
        return 0
    fi
    HR_LOCK_TOKEN="$$-$(head -c 8 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    hr_lock_try && { HR_LOCK_DEPTH=1; return 0; }
    hr_lock_stale && { rm -rf "$(hr_lock_path)" 2>/dev/null
                       hr_lock_try && { HR_LOCK_DEPTH=1; return 0; }; }
    case "$1" in
        stop|restart|backend|power) ;; # 用户显式操作：等一会再强制接管
        *) return 1 ;;
    esac
    _hr_n=0
    while [ "$_hr_n" -lt 20 ]; do
        sleep 1
        _hr_n=$((_hr_n + 1))
        hr_lock_try && { HR_LOCK_DEPTH=1; return 0; }
        hr_lock_stale && { rm -rf "$(hr_lock_path)" 2>/dev/null
                           hr_lock_try && { HR_LOCK_DEPTH=1; return 0; }; }
    done
    # 长时间抢不到：无锁继续（与 mjs 版一致），释放时核对不是自己的不会误删
    rm -rf "$(hr_lock_path)" 2>/dev/null
    hr_lock_try && { HR_LOCK_DEPTH=1; return 0; }
    return 0
}

# 嵌套到最外层才真正释放；不是自己持有的锁不动
hr_lock_release() {
    [ "$HR_LOCK_DEPTH" -gt 0 ] || return 0
    HR_LOCK_DEPTH=$((HR_LOCK_DEPTH - 1))
    [ "$HR_LOCK_DEPTH" -eq 0 ] || return 0
    hr_lock_holder_is_us || return 0
    rm -rf "$(hr_lock_path)" 2>/dev/null
}
