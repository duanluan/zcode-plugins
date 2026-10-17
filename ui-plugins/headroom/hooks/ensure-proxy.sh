#!/bin/sh
# Headroom 代理生命周期入口。SessionStart 钩子无参调用（ensure，静默、尽力而为，
# 失败不打扰会话）；/hr-proxy 等命令带动作调用：
#
#   ensure-proxy.sh [ensure|start]   确保代理在跑（已监听则跳过），按需拉起监视器
#   ensure-proxy.sh stop             停代理 + 停监视器（ZCode 里指向 127.0.0.1 的供应商会断连）
#   ensure-proxy.sh restart          stop + ensure
#   ensure-proxy.sh status           打印端口/进程/后端/电源状态
#   ensure-proxy.sh backend <值>     设置 kompressBackend（cpu|auto|headroom 原生值）并重启生效
#   ensure-proxy.sh power <模式>     省电自动切换模式：battery | saver | off
#
# CPU/省电配置见 ~/.zcode/headroom.json 与 headroom-lib.sh 头部注释。
#
# 注意：
# - ZCode 侧供应商的 API 格式必须选 Anthropic（Messages）。OpenAI/Chat Completions
#   格式无法用于 bigmodel 上游——headroom 转发保留客户端 /v1 路径前缀，必然 404。
# - 桌面启动的 ZCode 环境往往不含用户级 PATH（~/.local/bin、miniforge 等），
#   因此这里按常见位置主动查找 headroom，不依赖 PATH。
# - 本机若已配置 systemd 用户服务（headroom-proxy），代理由 systemd 管理，
#   本脚本探测到端口在线即静默退出，与服务不冲突（省电切换由监视器经 systemctl 完成）。
. "$(dirname -- "$0")/headroom-lib.sh"

hr_ensure() {
    _hr_port="${HEADROOM_PROXY_PORT:-8787}"
    if hr_port_up "$_hr_port"; then
        # 代理已在跑（可能是 systemd 或旧版拉起的）：省电切换开启时补上监视器
        [ "$(hr_power_save_mode)" != "off" ] && hr_watch_start
        return 0
    fi
    [ "${HEADROOM_PROXY_AUTOSTART:-1}" = "1" ] || return 0
    hr_find_headroom >/dev/null 2>&1 || return 0
    hr_proxy_start "$_hr_port" "$(hr_desired_backend)" || return 0
    [ "$(hr_power_save_mode)" != "off" ] && hr_watch_start
    return 0
}

hr_stop() {
    hr_watch_stop
    hr_proxy_stop "${HEADROOM_PROXY_PORT:-$(hr_state_get port 8787)}"
}

hr_status() {
    _hr_port="${HEADROOM_PROXY_PORT:-$(hr_state_get port 8787)}"
    if hr_port_up "$_hr_port"; then _hr_up="up"; else _hr_up="down"; fi
    printf 'proxy: %s (127.0.0.1:%s)\n' "$_hr_up" "$_hr_port"
    pgrep -af "headroom proxy" 2>/dev/null || printf 'process: none\n'
    printf 'managed-by-plugin: %s\n' "$(hr_state_get managed no)"
    printf 'current-backend: %s\n' "$(hr_state_get backend '?')"
    [ -n "${HEADROOM_KOMPRESS_BACKEND:-}" ] && printf 'env-override: HEADROOM_KOMPRESS_BACKEND=%s\n' "$HEADROOM_KOMPRESS_BACKEND"
    unset HEADROOM_KOMPRESS_BACKEND
    printf 'desired-backend: %s\n' "$(hr_desired_backend)"
    printf 'power-mode: %s\n' "$(hr_power_mode)"
    printf 'power-save-auto-cpu: %s (interval %ss)\n' "$(hr_power_save_mode)" "$(hr_watch_interval)"
    printf 'saver-detect: %s\n' "$(hr_saver_detect)"
    [ "$(hr_power_save_mode)" = "saver" ] && [ "$(hr_saver_detect)" != "ok" ] && hr_saver_hint
    if hr_watch_running; then
        printf 'watcher: running (pid %s)\n' "$(cat "$(hr_watch_pidfile)" 2>/dev/null)"
    else
        printf 'watcher: stopped\n'
    fi
    printf 'config: %s\n' "$(hr_config_file)"
}

case "${1:-ensure}" in
    ensure|start)
        hr_ensure
        ;;
    stop)
        hr_stop
        printf '已停止插件管理的 Headroom 代理与电源监视器\n'
        ;;
    restart)
        hr_stop
        sleep 1
        hr_ensure
        printf '已重启\n'
        ;;
    status)
        hr_status
        ;;
    backend)
        [ -n "${2:-}" ] || { printf '用法: ensure-proxy.sh backend <cpu|auto|onnx|coreml|mps|torch…>\n' >&2; exit 1; }
        hr_config_set kompressBackend "$2" || exit 1
        if hr_systemd_managed; then
            if [ "$2" = "auto" ]; then
                systemctl --user unset-environment HEADROOM_KOMPRESS_BACKEND
            else
                systemctl --user set-environment "HEADROOM_KOMPRESS_BACKEND=$2"
            fi
            systemctl --user restart headroom-proxy
            hr_state_set backend "$2"
        else
            hr_stop
            sleep 1
            hr_ensure
        fi
        printf 'kompressBackend=%s 已写入 %s 并重启代理生效\n' "$2" "$(hr_config_file)"
        ;;
    power)
        case "${2:-}" in
            battery)
                hr_config_set powerSaveCpu battery || exit 1
                hr_watch_start
                printf '省电自动切换已设为 battery：拔电（电池放电）→ CPU 压缩，插电切回\n'
                ;;
            saver)
                hr_config_set powerSaveCpu saver || exit 1
                hr_watch_start
                printf '省电自动切换已设为 saver：仅系统省电档 → CPU 压缩，退出切回（拔电但档位非省电不动）\n'
                [ "$(hr_saver_detect)" != "ok" ] && hr_saver_hint
                ;;
            off)
                hr_config_set powerSaveCpu off || exit 1
                hr_watch_stop
                printf '省电自动切换已关闭（当前后端保持不变，重启代理后回到 kompressBackend 配置值）\n'
                ;;
            *)
                printf '用法: ensure-proxy.sh power <battery|saver|off>\n  battery 拔电即 CPU；saver 仅省电档 CPU；off 关闭\n' >&2; exit 1
                ;;
        esac
        ;;
    *)
        printf '用法: ensure-proxy.sh [ensure|start|stop|restart|status|backend <值>|power <battery|saver|off>]\n' >&2
        exit 1
        ;;
esac
exit 0
