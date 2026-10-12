#!/usr/bin/env node
// Windows 原生实现的共享库（对应 POSIX 侧的 headroom-lib.sh）：配置读写、电源状态
// 检测、压缩后端决策、代理进程管理、监视器单实例。被 hooks/ensure-proxy.mjs 与
// hooks/power-watch.mjs 复用（import 使用，不直接执行）。
//
// 配置文件 ~/.zcode/headroom.json（可选，扁平 JSON，由 configSet 重写整文件）：
//   kompressBackend    "auto"（默认，headroom 自动选最快设备：CUDA 优先）
//                      "cpu" 强制 CPU 压缩；也支持 headroom 原生值原样透传
//   powerSaveCpu       省电自动切换模式："battery"（拔电→CPU，插电→切回）|
//                      "saver"（仅系统省电档→CPU）| "off"（关闭，默认）
//   powerWatchInterval 监视器轮询间隔秒数（默认 60，最小 10）
//
// 环境变量覆盖与 sh 版一致：HEADROOM_KOMPRESS_BACKEND / HEADROOM_POWER_SAVE_CPU /
// HEADROOM_POWER_WATCH_INTERVAL / HEADROOM_PROXY_PORT / HEADROOM_PROXY_AUTOSTART /
// HEADROOM_UPSTREAM_ANTHROPIC / HEADROOM_UPSTREAM_OPENAI。

import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const home = homedir();
export const configFile = () => path.join(home, '.zcode', 'headroom.json');
export const stateFile = () => path.join(home, '.zcode-headroom-proxy.state');
export const watchPidFile = () => path.join(home, '.zcode-headroom-power-watch.pid');
export const proxyLog = () => path.join(home, '.zcode-headroom-proxy.log');

// —— 配置读写（三键整文件形状，与 hr_config_set 一致）——

function readConfigRaw() {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')); } catch { return {}; }
}

export function configGet(key, dflt) {
  const v = readConfigRaw()[key];
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : dflt;
}

export function configSet(key, value) {
  const cfg = {
    kompressBackend: configGet('kompressBackend', 'auto'),
    powerSaveCpu: configGet('powerSaveCpu', 'off'),
    powerWatchInterval: Number(configGet('powerWatchInterval', '60')) || 60,
  };
  if (key === 'kompressBackend') cfg.kompressBackend = value;
  else if (key === 'powerSaveCpu') cfg.powerSaveCpu = ['battery', 'saver'].includes(value) ? value : 'off';
  else if (key === 'powerWatchInterval') cfg.powerWatchInterval = Number(value) || 60;
  else { console.error(`hr_config_set: 未知键 ${key}`); process.exit(1); }
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// —— 电源状态（PowerShell，与 hr_power_flags_win 同源）——

export function powerSaveMode() {
  let m = String(process.env.HEADROOM_POWER_SAVE_CPU ?? configGet('powerSaveCpu', 'off')).toLowerCase();
  if (['1', 'true'].includes(m)) m = 'battery';
  if (['0', 'false'].includes(m)) m = 'off';
  return ['battery', 'saver'].includes(m) ? m : 'off';
}

export function watchInterval() {
  let iv = process.env.HEADROOM_POWER_WATCH_INTERVAL ?? configGet('powerWatchInterval', '60');
  if (!/^\d+$/.test(String(iv))) iv = 60;
  return Math.max(10, Number(iv));
}

// 同步跑 PowerShell（System32 里的 powershell.exe 不依赖用户级 PATH）
export function powershellSync(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// 输出 'saver'/'battery' 标志（可同时存在），检测失败输出空 = 按交流处理。
// saver = Windows 节电模式（Win10 1809+）或激活的电源计划是「节能」
//（计划名会本地化，但 GUID 固定：a1841308-3541-4fab-bc81-f71556f20b4a）；
// battery = 电池放电中（PowerLineStatus Offline）。
export async function powerFlags() {
  const out = await powershellSync(
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.SystemInformation]::PowerStatus; ' +
    '$s="Indeterminate"; try{$s=[string]$p.PowerSavingMode}catch{}; ' +
    '"PL=$($p.PowerLineStatus);SAVER=$s;SCHEME=$(powercfg /getactivescheme)"');
  if (out == null) return [];
  const f = [];
  if (/SAVER=True/.test(out) || out.includes('a1841308-3541-4fab-bc81-f71556f20b4a')) f.push('saver');
  if (/PL=Offline/.test(out)) f.push('battery');
  return f;
}

export async function powerMode() {
  const f = await powerFlags();
  if (f.includes('saver') && f.includes('battery')) return 'saver+battery';
  return f[0] || 'ac';
}

// 与 sh 版 hr_desired_backend 同义：本进程显式设置了 backend 时原样用；
// 否则按省电模式判定（battery 放电即 cpu / saver 省电档才 cpu），其余用配置值。
// 长期驻留的调用方（监视器）每轮须先清掉环境里的显式值，避免锁死决策。
export async function desiredBackend() {
  if (process.env.HEADROOM_KOMPRESS_BACKEND) return process.env.HEADROOM_KOMPRESS_BACKEND;
  let b = configGet('kompressBackend', 'auto');
  const mode = powerSaveMode();
  if (b !== 'cpu' && mode !== 'off') {
    const f = await powerFlags();
    if ((mode === 'battery' && f.includes('battery')) || (mode === 'saver' && f.includes('saver'))) b = 'cpu';
  }
  return b;
}

// —— headroom 本体查找（where.exe + 常见安装位置，不依赖 PATH 一定含它）——

export function findHeadroom() {
  return new Promise((resolve) => {
    execFile('where.exe', ['headroom'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        // 优先 .exe：.bat/.cmd 直接 spawn 会抛 EINVAL（Node 18+ 安全限制）
        const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const hit = lines.find((p) => p.toLowerCase().endsWith('.exe') && existsSync(p)) || lines[0];
        if (hit && existsSync(hit)) { resolve(hit); return; }
      }
      resolve(findHeadroomCandidates());
    });
  });
}

function findHeadroomCandidates() {
  // Program Files 根既可能是标准带空格的，也可能是自定义无空格的（如 C:\ProgramFiles），都列
  const pfRoots = [...new Set([
    process.env.PROGRAMFILES || 'C:\\Program Files',
    'C:\\Program Files',
    'C:\\ProgramFiles',
  ])];
  const dirs = [
    path.join(home, '.local', 'bin'),                     // pipx / uv tool 默认
    path.join(home, 'miniforge3', 'Scripts'),
    path.join(home, 'miniconda3', 'Scripts'),
    path.join(home, 'anaconda3', 'Scripts'),
    path.join(home, '.cargo', 'bin'),
  ];
  for (const pf of pfRoots) {
    dirs.push(
      path.join(pf, 'miniforge3', 'Scripts'),
      path.join(pf, 'miniconda3', 'Scripts'),
      path.join(pf, 'anaconda3', 'Scripts'),
      path.join(pf, 'Python313', 'Scripts'),
      path.join(pf, 'Python312', 'Scripts'),
      path.join(pf, 'Python311', 'Scripts'),
    );
  }
  // pip --user 的脚本目录带 Python 小版本号，目录名不定，按前缀扫
  for (const base of [path.join(process.env.APPDATA || '', 'Python'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python')]) {
    if (!base || !existsSync(base)) continue;
    try { for (const d of readdirSync(base)) dirs.push(path.join(base, d, 'Scripts')); } catch { /* ignore */ }
  }
  for (const d of dirs) {
    const p = path.join(d, 'headroom.exe');               // 只认 .exe（.bat spawn 会 EINVAL）
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

// —— 端口探测（/livez 官方端点毫秒级；不要探测根路径 /，会挂起）——

export function portUp(port) {
  const probe = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2000 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  return probe('/livez').then((ok) => ok || probe('/health'));
}

// —— 状态文件（key=value 行格式，与 sh 版共用）——

export function stateGet(key, dflt) {
  try {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(stateFile(), 'utf8'));
    if (m) return m[1];
  } catch { /* ignore */ }
  return dflt;
}

export function stateSet(key, value) {
  const lines = existsSync(stateFile()) ? readFileSync(stateFile(), 'utf8').split(/\r?\n/) : [];
  const kept = lines.filter((l) => l && !l.startsWith(`${key}=`));
  kept.push(`${key}=${value}`);
  writeFileSync(stateFile(), kept.join('\n') + '\n', 'utf8');
}

// —— 代理进程管理 ——

export function appendLog(text) {
  try {
    const fd = openSync(proxyLog(), 'a');
    writeSync(fd, text);
    closeSync(fd);
  } catch { /* 日志失败不影响主流程 */ }
}

function logStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 后台启动代理并写状态文件（detached + unref，stdout/stderr 落日志文件）
export async function proxyStart(port, backend) {
  const bin = await findHeadroom();
  if (!bin) return false;
  const env = { ...process.env };
  if (backend !== 'auto') env.HEADROOM_KOMPRESS_BACKEND = backend;
  env.ANTHROPIC_TARGET_API_URL = process.env.HEADROOM_UPSTREAM_ANTHROPIC || 'https://open.bigmodel.cn/api/anthropic';
  env.OPENAI_TARGET_API_URL = process.env.HEADROOM_UPSTREAM_OPENAI || 'https://open.bigmodel.cn/api/paas/v4';
  let child;
  try {
    const logFd = openSync(proxyLog(), 'a');
    child = spawn(bin, ['proxy', '--port', String(port)], { detached: true, stdio: ['ignore', logFd, logFd], env, windowsHide: true });
    child.unref();
  } catch { return false; }
  appendLog(`${logStamp()} Windows_NT ensure-proxy: start headroom proxy port=${port} backend=${backend}\n`);
  stateSet('pid', String(child.pid));
  stateSet('port', String(port));
  stateSet('backend', backend);
  stateSet('managed', 'yes');
  return true;
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true }, () => resolve());
  });
}

// 停止代理（优先状态文件里的 pid，taskkill /T 连子进程一起杀）并清除状态。
// 回退按端口找占用进程：pip 的 console script 是「启动器 exe → python 子进程」两层，
// 只按进程名杀 headroom.exe 会漏掉真正占端口的 python 子进程。
export async function proxyStop(port) {
  const pid = Number(stateGet('pid', '')) || 0;
  if (pid > 0) { try { process.kill(pid, 0); await taskkill(pid); } catch { /* 进程已不在 */ } }
  await powershellSync(
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { taskkill /PID $_.OwningProcess /T /F }`);
  rmSync(stateFile(), { force: true });
}

// —— 电源监视器（power-watch.mjs）单实例管理 ——

export function watchRunning() {
  try {
    const pid = Number(readFileSync(watchPidFile(), 'utf8').trim()) || 0;
    if (pid > 0) { process.kill(pid, 0); return true; }
  } catch { /* pid 文件缺失或进程不在 */ }
  return false;
}

export function watchStart(here) {
  if (watchRunning()) return;
  try {
    const logFd = openSync(proxyLog(), 'a');
    const child = spawn(process.execPath, [path.join(here, 'power-watch.mjs')],
      { detached: true, stdio: ['ignore', logFd, logFd], env: process.env, windowsHide: true });
    child.unref();
    writeFileSync(watchPidFile(), `${child.pid}\n`, 'utf8');
  } catch { /* 监视器起不来不阻塞主流程 */ }
}

export function watchStop() {
  try {
    const pid = Number(readFileSync(watchPidFile(), 'utf8').trim()) || 0;
    if (pid > 0) { try { process.kill(pid, 0); void taskkill(pid); } catch { /* 已不在 */ } }
  } catch { /* ignore */ }
  rmSync(watchPidFile(), { force: true });
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
