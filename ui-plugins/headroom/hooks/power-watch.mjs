#!/usr/bin/env node
// Windows 电源监视器（对应 POSIX 侧的 power-watch.sh）：powerSaveCpu 非 off 时轮询
// 电源状态，压缩后端需要变化时重启插件管理的代理（重启瞬间在途请求会闪断一次）。
// 由 headroom-lib.mjs 的 watchStart 拉起，单实例（pidfile）。自动退出条件：
// powerSaveCpu=off、代理连续多轮不可达（视为下线，交回 SessionStart 兜底）、
// 或代理非插件管理（无状态文件）。
// 模式：battery（拔电→cpu）| saver（省电档→cpu），见 headroom-lib.mjs 头部注释；
// 间隔 HEADROOM_POWER_WATCH_INTERVAL 或 powerWatchInterval（默认 60s，最小 10s）。

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import * as lib from './headroom-lib.mjs';

lib.appendLog(`${logStamp()} power-watch: 启动 pid=${process.pid} mode=${lib.powerSaveMode()}\n`);
// pid 文件带启动时间（pid 时间戳是秒，与 sh 版同一格式；见 headroom-lib.mjs）：
// 退出时核对内容还是自己写的那份才删，不然启动到退出之间接班的新监视器的
// pid 文件会被误删
const myPidLine = `${process.pid} ${Math.floor(Date.now() / 1000)}`;
writeFileSync(lib.watchPidFile(), `${myPidLine}\n`, 'utf8');

let downRounds = 0; // 连续不可达轮数：短暂失联（代理重启中）很常见，多轮才判定下线
for (;;) {
  await lib.sleep(lib.watchInterval() * 1000);

  // 决策只看配置 + 电源状态；清掉环境里可能残留的显式值，避免锁死决策
  delete process.env.HEADROOM_KOMPRESS_BACKEND;

  if (lib.powerSaveMode() === 'off') {
    lib.appendLog(`${logStamp()} power-watch: powerSaveCpu 已关闭（off），退出 pid=${process.pid}\n`);
    break;
  }
  const port = Number(lib.stateGet('port', process.env.HEADROOM_PROXY_PORT || 8787)) || 8787;
  if (!(await lib.portUp(port))) {
    downRounds += 1;
    if (downRounds >= 5) {
      lib.appendLog(`${logStamp()} power-watch: 代理连续 ${downRounds} 轮不可达（视为下线），退出 pid=${process.pid}\n`);
      break;
    }
    continue;
  }
  downRounds = 0;

  const want = await lib.desiredBackend();
  if (lib.stateGet('managed', 'no') === 'yes') {
    const cur = lib.stateGet('backend', 'auto');
    if (want !== cur) {
      lib.appendLog(`${logStamp()} power-watch: 代理切后端 ${cur} -> ${want}（重启端口 ${port}）\n`);
      // 停再启这段要抢生命周期锁：不抢会和 ensure-proxy 的动作并行，两边同时
      // 停/启同一端口的代理。用 restart 语义（用户操作）：抢不到就等，最终要切换
      const lock = await lib.acquireLifecycleLock('restart');
      try {
        await lib.proxyStop(port);
        await lib.sleep(1000);
        if (!(await lib.proxyStart(port, want))) break;
      } finally {
        lock.release();
      }
    }
  } else {
    lib.appendLog(`${logStamp()} power-watch: 代理非插件管理，退出 pid=${process.pid}\n`);
    break;
  }
}

lib.appendLog(`${logStamp()} power-watch: 退出 pid=${process.pid}\n`);
// 只删自己写的那份 pid 文件：从启动到退出之间可能已有新监视器接班并重写了内容，
// 内容对不上就不是自己的，不删
try {
  if (readFileSync(lib.watchPidFile(), 'utf8').trim() === myPidLine) {
    rmSync(lib.watchPidFile(), { force: true });
  }
} catch { /* 文件已不在 */ }
process.exit(0);

function logStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
