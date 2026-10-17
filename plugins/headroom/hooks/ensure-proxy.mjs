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
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const action = args[0] || 'ensure';
const here = path.dirname(fileURLToPath(import.meta.url));

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
