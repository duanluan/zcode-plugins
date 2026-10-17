#!/bin/sh
# 电源监视器：powerSaveCpu 非 off 时轮询电源状态，压缩后端需要变化时重启插件管理的代理
# （重启瞬间在途请求会闪断一次）。由 headroom-lib.sh 的 hr_watch_start 拉起，单实例
# （pidfile）。自动退出条件：powerSaveCpu=off、代理连续多轮不可达（视为下线，交回
# SessionStart 兜底）、或代理非插件管理（无状态文件且非 systemd 单元 headroom-proxy）。
# 模式：battery（拔电→cpu）| saver（省电档→cpu），见 headroom-lib.sh 头部注释；
# 间隔 HEADROOM_POWER_WATCH_INTERVAL 或 powerWatchInterval（默认 60s，最小 10s）。
. "${HR_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}/hooks/headroom-lib.sh"

printf '%s %s power-watch: 启动 pid=%s mode=%s\n' "$(date '+%F %T')" "$(uname -s)" "$$" "$(hr_power_save_mode)" >>"$(hr_proxy_log)"
[ "$(hr_power_save_mode)" = "saver" ] && [ "$(hr_saver_detect)" != "ok" ] \
    && hr_saver_hint >>"$(hr_proxy_log)"
printf '%s\n' "$$" >"$(hr_watch_pidfile)"

_hr_down=0  # 连续不可达轮数：短暂失联（代理重启中）很常见，多轮才判定下线
while :; do
    sleep "$(hr_watch_interval)"

    # 决策只看配置 + 电源状态；清掉环境里可能残留的显式值，避免锁死决策
    unset HEADROOM_KOMPRESS_BACKEND

    if [ "$(hr_power_save_mode)" = "off" ]; then
        printf '%s %s power-watch: powerSaveCpu 已关闭（off），退出 pid=%s\n' \
            "$(date '+%F %T')" "$(uname -s)" "$$" >>"$(hr_proxy_log)"
        break
    fi
    hr_port=$(hr_state_get port "${HEADROOM_PROXY_PORT:-8787}")
    if ! hr_port_up "$hr_port"; then
        _hr_down=$((_hr_down + 1))
        if [ "$_hr_down" -ge 5 ]; then
            printf '%s %s power-watch: 代理连续 %s 轮不可达（视为下线），退出 pid=%s\n' \
                "$(date '+%F %T')" "$(uname -s)" "$_hr_down" "$$" >>"$(hr_proxy_log)"
            break
        fi
        continue
    fi
    _hr_down=0

    hr_want=$(hr_desired_backend)
    if hr_systemd_managed; then
        # systemd 托管：把后端写进 manager 环境再重启单元。
        # 注意若单元文件里手写了 Environment=HEADROOM_KOMPRESS_BACKEND，
        # 请把 ~/.zcode/headroom.json 的 kompressBackend 设成同值，避免监视器反复改写。
        hr_cur=$(hr_state_get backend auto)
        if [ "$hr_want" != "$hr_cur" ]; then
            printf '%s %s power-watch: systemd 代理切后端 %s -> %s\n' \
                "$(date '+%F %T')" "$(uname -s)" "$hr_cur" "$hr_want" >>"$(hr_proxy_log)"
            if [ "$hr_want" = "auto" ]; then
                systemctl --user unset-environment HEADROOM_KOMPRESS_BACKEND
            else
                systemctl --user set-environment "HEADROOM_KOMPRESS_BACKEND=$hr_want"
            fi
            systemctl --user restart headroom-proxy
            hr_state_set backend "$hr_want"
        fi
    elif [ "$(hr_state_get managed no)" = "yes" ]; then
        hr_cur=$(hr_state_get backend auto)
        if [ "$hr_want" != "$hr_cur" ]; then
            printf '%s %s power-watch: 代理切后端 %s -> %s（重启端口 %s）\n' \
                "$(date '+%F %T')" "$(uname -s)" "$hr_cur" "$hr_want" "$hr_port" >>"$(hr_proxy_log)"
            hr_proxy_stop "$hr_port"
            sleep 1
            hr_proxy_start "$hr_port" "$hr_want" || break
        fi
    else
        printf '%s %s power-watch: 代理非插件管理且非 systemd 单元，退出 pid=%s\n' \
            "$(date '+%F %T')" "$(uname -s)" "$$" >>"$(hr_proxy_log)"
        break
    fi
done

printf '%s %s power-watch: 退出 pid=%s\n' "$(date '+%F %T')" "$(uname -s)" "$$" >>"$(hr_proxy_log)"
rm -f "$(hr_watch_pidfile)"
