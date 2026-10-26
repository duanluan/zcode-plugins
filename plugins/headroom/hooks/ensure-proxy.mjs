#!/usr/bin/env node
// 跨平台代理生命周期入口（与 ensure-proxy.sh 同一套动作语义，hooks.json 无参调用
// ensure，/hr-proxy 等命令带动作调用）：
//
//   ensure-proxy.mjs [ensure|start]   确保代理在跑（已监听则跳过），按需拉起监视器
//   ensure-proxy.mjs stop             停代理 + 停监视器
//   ensure-proxy.mjs restart          stop + ensure
//   ensure-proxy.mjs status           打印端口/进程/后端/电源状态
//   ensure-proxy.mjs backend <值>     设置 kompressBackend（cpu|auto|headroom 原生值）并重启生效
//   ensure-proxy.mjs power <模式>     省电自动切换模式：battery | saver | off
//
// Windows 没有 POSIX sh，本文件在 win32 上原生实现（逻辑在 headroom-lib.mjs），
// 其余平台原样委托同目录的 ensure-proxy.sh（sh 版久经考验，不动）。
// 配置/状态文件与 sh 版共用同一套路径与格式（~/.zcode/headroom.json 等）。

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const action = args[0] || 'ensure';
const here = path.dirname(fileURLToPath(import.meta.url));

// —— 生命周期动作跨进程互斥 ——
// SessionStart 钩子补上 resume 匹配后，应用启动时多个恢复的会话会在几秒内连发
// 多个 ensure，同时 spawn 实例会抢同一端口、留下孤儿进程；/hr 命令、设置面板
// 的重启也可能撞上。锁用目录创建的原子性实现：抢不到且持有者存活、锁未
// 超时就静默跳过（ensure 幂等，跳过无影响）；持有者死亡（含强制重启残留的锁）
// 立即接管；超过 60 秒按悬挂强制接管——钩子 8 秒超时被强杀不走 exit 清理，只能
// 靠超时兜底。竞争时的两种策略：ensure/start 是自动触发的幂等动作，立刻退出；
// stop/restart/backend/power 是用户显式操作，最多等 20 秒后强制接管，保证用户
// 的停止/重启最终生效。status 只读，不加锁；锁目录异常（权限等）不拦截动作，
// 保持尽力而为。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockDir = process.env.HR_HEADROOM_CONFIG
  ? path.join(path.dirname(process.env.HR_HEADROOM_CONFIG), 'hr-ensure-test.lock')
  : path.join(homedir(), '.zcode-headroom-ensure.lock');
let lockHeld = false;
const releaseLock = () => {
  if (!lockHeld) return;
  lockHeld = false;
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
};
if (action !== 'status') {
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const rmLock = () => { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ } };
  const tryAcquire = () => {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
      return true;
    } catch (err) {
      return err?.code !== 'EEXIST';
    }
  };
  // 持有者死亡（含强制重启残留）或锁超龄 → 悬挂，可强制接管
  const lockStale = () => {
    let holderPid = 0;
    try { holderPid = Number(readFileSync(path.join(lockDir, 'pid'), 'utf8')) || 0; } catch { /* ignore */ }
    if (!holderPid || !pidAlive(holderPid)) return true;
    try { return statSync(lockDir).mtimeMs < Date.now() - 60_000; } catch { return true; }
  };
  const acquireOrSteal = () => {
    if (tryAcquire()) return true;
    if (!lockStale()) return false;
    rmLock();
    return tryAcquire();
  };
  let acquired = tryAcquire() || acquireOrSteal();
  if (!acquired && !['stop', 'restart', 'backend', 'power'].includes(action)) {
    console.log('headroom: 另一个生命周期动作正在执行，本次跳过（动作幂等，跳过无影响）');
    process.exit(0);
  }
  if (!acquired) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(acquired = acquireOrSteal())) {
      await sleep(300);
    }
    if (!acquired) {
      rmLock();
      acquired = tryAcquire();
      if (!acquired) console.log('headroom: 生命周期锁长时间无法获取，无锁继续执行');
    }
  }
  if (acquired) {
    lockHeld = true;
    process.on('exit', releaseLock);
    // 钩子超时被 SIGTERM/SIGINT 杀掉时不触发 exit 事件，单独清理，避免留下等 60 秒超时的锁
    process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
    process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  }
}

// 多供应商压缩路由（hr-multi）：providers 已配置时由它接管 ensure/start/restart/status；
// backend/power 先写配置再转 hr-multi 重启实例（旧代理的重启语义在多实例模式下不适用，
// 且转给 hr-multi 会因动作名不认识被打"用法"错误）；stop 无论何种状态都"双跑"
// （multi 停路由器与实例 + 旧代理停单实例）——迁移切换时旧 headroom 占着 8787，
// 只跑 multi 的 stop 会让旧实例漏网、路由器起不来。配置路径跟随 HR_HEADROOM_CONFIG，
// 与 hr-multi 保持同一视图（自测时不误碰真机）
{
  const { handle } = await import('./hr-multi.mjs');
  const cfgPath = process.env.HR_HEADROOM_CONFIG || path.join(homedir(), '.zcode', 'headroom.json');
  let hasProviders = false;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    hasProviders = Array.isArray(cfg.providers) && cfg.providers.length > 0;
  } catch { /* 配置缺失 = 未接入 */ }
  if (hasProviders && ['ensure', 'start', 'restart', 'status'].includes(action)) {
    const r = await handle(action);
    if (r !== null) process.exit(r === 3 ? 0 : r);
  } else if (hasProviders && action === 'backend' && args[1]) {
    const { configSet, configFile } = await import('./headroom-lib.mjs');
    configSet('kompressBackend', args[1]);
    const r = await handle('restart');
    console.log(`kompressBackend=${args[1]} 已写入 ${configFile()} 并重启实例生效`);
    process.exit(r === 3 ? 0 : r);
  } else if (hasProviders && action === 'power' && ['battery', 'saver', 'off'].includes(args[1])) {
    const { configSet } = await import('./headroom-lib.mjs');
    configSet('powerSaveCpu', args[1]);
    console.log(`省电自动切换已写入配置（${args[1]}）。注意：多实例模式下电源监视器不自动重启实例（避免误停路由器）；要立即切换压缩后端用 backend 动作`);
    process.exit(0);
  } else if (action === 'stop' && hasProviders) {
    await handle('stop'); // 继续落到旧代理 stop（双跑）
  }
}

if (platform() !== 'win32') {
  // POSIX：委托 sh 版（systemd 协作、pgrep/pkill 等逻辑都在那边）
  const child = spawn('/bin/sh', [path.join(here, 'ensure-proxy.sh'), ...args], { stdio: 'inherit' });
  child.on('error', (err) => { console.error(String(err?.message || err)); process.exit(1); });
  child.on('close', (code) => process.exit(code ?? 1));
} else {
  import('./headroom-lib.mjs').then((lib) => runWindows(lib, action, args.slice(1)))
    .then((code) => process.exit(code))
    .catch((err) => { console.error(String(err?.message || err)); process.exit(1); });
}

// ===========================================================================
// Windows 原生实现（动作语义与 ensure-proxy.sh 逐条对应）
// ===========================================================================

async function runWindows(lib, act, rest) {
  switch (act) {
    case 'ensure': case 'start':
      await hrEnsure(lib);
      return 0;
    case 'stop':
      await hrStop(lib);
      console.log('已停止插件管理的 Headroom 代理与电源监视器');
      return 0;
    case 'restart':
      await hrStop(lib);
      await lib.sleep(1000);
      await hrEnsure(lib);
      console.log('已重启');
      return 0;
    case 'status':
      await hrStatus(lib);
      return 0;
    case 'backend': {
      const v = rest[0];
      if (!v) { console.error('用法: ensure-proxy.mjs backend <cpu|auto|onnx|coreml|mps|torch…>'); return 1; }
      lib.configSet('kompressBackend', v);
      await hrStop(lib);
      await lib.sleep(1000);
      await hrEnsure(lib);
      console.log(`kompressBackend=${v} 已写入 ${lib.configFile()} 并重启代理生效`);
      return 0;
    }
    case 'power': {
      const mode = rest[0];
      if (!['battery', 'saver', 'off'].includes(mode)) {
        console.error('用法: ensure-proxy.mjs power <battery|saver|off>\n  battery 拔电即 CPU；saver 仅省电档 CPU；off 关闭');
        return 1;
      }
      lib.configSet('powerSaveCpu', mode);
      if (mode === 'off') {
        lib.watchStop();
        console.log('省电自动切换已关闭（当前后端保持不变，重启代理后回到 kompressBackend 配置值）');
      } else {
        lib.watchStart(here);
        console.log(mode === 'battery'
          ? '省电自动切换已设为 battery：拔电（电池放电）→ CPU 压缩，插电切回'
          : '省电自动切换已设为 saver：仅系统省电档 → CPU 压缩，退出切回（拔电但档位非省电不动）');
      }
      return 0;
    }
    default:
      console.error('用法: ensure-proxy.mjs [ensure|start|stop|restart|status|backend <值>|power <battery|saver|off>]');
      return 1;
  }
}

async function hrEnsure(lib) {
  const port = Number(process.env.HEADROOM_PROXY_PORT) || 8787;
  if (await lib.portUp(port)) {
    if (lib.powerSaveMode() !== 'off') lib.watchStart(here);
    return;
  }
  // 与 sh 版同语义：HEADROOM_PROXY_AUTOSTART 缺省视为 1，任何非 1 值都不自启
  if (String(process.env.HEADROOM_PROXY_AUTOSTART ?? '1') !== '1') return;
  const backend = await lib.desiredBackend();
  if (!(await lib.proxyStart(port, backend))) return;
  if (lib.powerSaveMode() !== 'off') lib.watchStart(here);
}

async function hrStop(lib) {
  lib.watchStop();
  const port = Number(process.env.HEADROOM_PROXY_PORT) || Number(lib.stateGet('port', 8787)) || 8787;
  await lib.proxyStop(port);
}

async function hrStatus(lib) {
  const port = Number(process.env.HEADROOM_PROXY_PORT) || Number(lib.stateGet('port', 8787)) || 8787;
  const up = await lib.portUp(port);
  console.log(`proxy: ${up ? 'up' : 'down'} (127.0.0.1:${port})`);
  const procOut = await lib.powershellSync(
    `Get-CimInstance Win32_Process -Filter "Name='headroom.exe'" | ` +
    `Where-Object {$_.CommandLine -match 'proxy'} | ` +
    `ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`);
  const procs = (procOut || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (procs.length) for (const p of procs) console.log(p);
  else console.log('process: none');
  console.log(`managed-by-plugin: ${lib.stateGet('managed', 'no')}`);
  console.log(`current-backend: ${lib.stateGet('backend', '?')}`);
  if (process.env.HEADROOM_KOMPRESS_BACKEND) console.log(`env-override: HEADROOM_KOMPRESS_BACKEND=${process.env.HEADROOM_KOMPRESS_BACKEND}`);
  delete process.env.HEADROOM_KOMPRESS_BACKEND;
  console.log(`desired-backend: ${await lib.desiredBackend()}`);
  console.log(`power-mode: ${await lib.powerMode()}`);
  console.log(`power-save-auto-cpu: ${lib.powerSaveMode()} (interval ${lib.watchInterval()}s)`);
  console.log('saver-detect: ok'); // Windows 用 PowerShell 检测，无 powerprofilesctl 依赖
  if (lib.watchRunning()) {
    console.log(`watcher: running (pid ${readFileSync(lib.watchPidFile(), 'utf8').trim()})`);
  } else {
    console.log('watcher: stopped');
  }
  console.log(`config: ${lib.configFile()}`);
}
