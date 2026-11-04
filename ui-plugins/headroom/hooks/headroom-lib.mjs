#!/usr/bin/env node
// Windows 原生实现的共享库（对应 POSIX 侧的 headroom-lib.sh）：配置读写、电源状态
// 检测、压缩后端决策、代理进程管理、监视器单实例、生命周期动作互斥锁。被
// hooks/ensure-proxy.mjs、hooks/hr-multi.mjs 与 hooks/power-watch.mjs 复用
//（import 使用，不直接执行）。
//
// 配置文件 ~/.zcode/headroom.json（可选，扁平 JSON，configSet 重写整文件但保留
// providers/router/instances 等其他键）：
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
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const home = homedir();
// HR_HEADROOM_CONFIG：hr-multi 自测用，配置文件路径跟随覆盖，保证测试与真机互不干扰
export const configFile = () => process.env.HR_HEADROOM_CONFIG || path.join(home, '.zcode', 'headroom.json');
export const stateFile = () => path.join(home, '.zcode-headroom-proxy.state');
export const watchPidFile = () => path.join(home, '.zcode-headroom-power-watch.pid');
export const proxyLog = () => path.join(home, '.zcode-headroom-proxy.log');

// —— 配置读写（三个电源/压缩键带默认值；configSet 只改目标键，其余键原样保留）——

// 临时文件加改名的原子写：直接 writeFileSync 写一半被强杀（钩子超时常见）会留下
// 截断的文件，下次读配置/状态直接失败。0600：配置里可能带供应商 key，别让同机其他用户读到
export function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function readConfigRaw() {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')); } catch { return {}; }
}

export function configGet(key, dflt) {
  const v = readConfigRaw()[key];
  // 布尔值按 1/0 返回：历史版本与手编配置会写 true/false，sh 侧读到是字符串
  // "true"/"false" 并按 1|true→battery 映射，这里对齐同一套映射输入
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : dflt;
}

export function configSet(key, value) {
  // 在整份配置上改目标键：以前只写三个键重盖整文件，会把 hr-join 写入的 providers
  // 等键整个丢掉
  const cfg = readConfigRaw();
  if (cfg.kompressBackend === undefined) cfg.kompressBackend = 'auto';
  if (cfg.powerSaveCpu === undefined) cfg.powerSaveCpu = 'off';
  if (cfg.powerWatchInterval === undefined) cfg.powerWatchInterval = 60;
  if (key === 'kompressBackend') cfg.kompressBackend = value;
  else if (key === 'powerSaveCpu') cfg.powerSaveCpu = ['battery', 'saver'].includes(value) ? value : 'off';
  else if (key === 'powerWatchInterval') cfg.powerWatchInterval = Number(value) || 60;
  else { console.error(`hr_config_set: 未知键 ${key}`); process.exit(1); }
  writeFileAtomic(configFile(), JSON.stringify(cfg, null, 2) + '\n');
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
  writeFileAtomic(stateFile(), kept.join('\n') + '\n');
}

// —— 代理进程管理 ——

export function appendLog(text) {
  let fd = -1;
  try {
    fd = openSync(proxyLog(), 'a');
    writeSync(fd, text);
  } catch { /* 日志失败不影响主流程 */ }
  finally {
    // closeSync 放 finally：writeSync 抛错时不把 fd 泄漏掉
    if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
  }
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
    try {
      child = spawn(bin, ['proxy', '--port', String(port)], { detached: true, stdio: ['ignore', logFd, logFd], env, windowsHide: true });
      child.unref();
    } finally {
      // 子进程已经继承了日志 fd，父进程这份要关掉，否则每启动一次代理漏一个 fd
      closeSync(logFd);
    }
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
// pid 文件内容是"pid 启动时间"两个字段：带启动时间是为了让监视器退出时能核对
// 文件还是自己写的那份，不会误删接班的新监视器的 pid 文件

function watchPidLine() {
  try {
    return Number(readFileSync(watchPidFile(), 'utf8').trim().split(/\s+/)[0]) || 0;
  } catch { return 0; }
}

export function watchRunning() {
  const pid = watchPidLine();
  if (pid > 0) {
    try { process.kill(pid, 0); return true; } catch { /* 进程不在 */ }
  }
  return false;
}

export function watchStart(here) {
  if (watchRunning()) return;
  // 排他创建 pid 文件占位后再拉起：查完再写的窗口里两个调用会各拉一个监视器。
  // 占位内容写调用方 pid 与秒级时间（与 sh 版同一格式），中途被杀留下可识别的
  // 失效记录，不会是空文件挡住后续启动
  const claim = `${process.pid} ${Math.floor(Date.now() / 1000)}\n`;
  try {
    writeFileSync(watchPidFile(), claim, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') return;
    // 文件在但 watchRunning 刚判过没在跑：残留记录（占位 pid 已死）才接管；
    // 占位 pid 还活着说明有另一个调用正在拉起，本次放弃
    try {
      const oldPid = Number(readFileSync(watchPidFile(), 'utf8').trim().split(/\s+/)[0]) || 0;
      const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
      if (oldPid && alive(oldPid)) return;
    } catch { return; }
    try { writeFileSync(watchPidFile(), claim, 'utf8'); } catch { return; }
  }
  try {
    const logFd = openSync(proxyLog(), 'a');
    let child;
    try {
      child = spawn(process.execPath, [path.join(here, 'power-watch.mjs')],
        { detached: true, stdio: ['ignore', logFd, logFd], env: process.env, windowsHide: true });
      child.unref();
    } finally {
      // 子进程已经继承了日志 fd，父进程这份要关掉，否则每拉起一次监视器漏一个 fd
      closeSync(logFd);
    }
    writeFileSync(watchPidFile(), `${child.pid} ${Math.floor(Date.now() / 1000)}\n`, 'utf8');
  } catch { /* 监视器起不来不阻塞主流程 */ }
}

export function watchStop() {
  let line = '';
  try { line = readFileSync(watchPidFile(), 'utf8').trim(); } catch { /* 文件不在 */ }
  const pid = Number(line.split(/\s+/)[0]) || 0;
  if (pid > 0) { try { process.kill(pid, 0); void taskkill(pid); } catch { /* 已不在 */ } }
  // 只删自己刚读到的那份 pid 文件：杀进程到删文件之间可能已有新监视器接班写入
  try {
    if (line && readFileSync(watchPidFile(), 'utf8').trim() === line) {
      rmSync(watchPidFile(), { force: true });
    }
  } catch { /* 文件已不在 */ }
}

// —— 生命周期动作跨进程互斥（目录锁）——
// ensure-proxy.mjs 与 hr-multi.mjs 直跑入口、power-watch.mjs 的代理重启共用同一把
// 锁：几套入口并行动作会抢同一端口、互相删状态文件。锁目录的创建是原子的；抢不到
// 且持有者存活、锁未超时就按动作决定跳过还是等待；持有者死亡（含强制重启残留的锁）
// 立即接管；超过 60 秒按悬挂强制接管——钩子 8 秒超时被强杀不走 exit 清理，只能靠
// 超时兜底。竞争时的两种策略：ensure/start 是自动触发的幂等动作，立刻退出；
// stop/restart/backend/power 是用户显式操作，最多等 20 秒后强制接管，保证用户的
// 停止/重启最终生效。status 只读不加锁；锁目录异常（权限等）不拦截动作，尽力而为。
// 锁目录里写持有者信息（pid + 随机 token）：释放前核对还是自己那份才删——锁可能
// 已被别人按超时接管，把新锁删掉会让两个动作同时跑。
// 返回 { status, release }：'held' 抢到锁（进程退出时自动释放，信号处理里调
// release）；'skipped' 被别的动作挡住且本次可跳过（提示已打印）；'unlocked' 长时间
// 抢不到，无锁继续（提示已打印）。
export async function acquireLifecycleLock(action) {
  const lockDir = process.env.HR_HEADROOM_CONFIG
    ? path.join(path.dirname(process.env.HR_HEADROOM_CONFIG), 'hr-ensure-test.lock')
    : path.join(home, '.zcode-headroom-ensure.lock');
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const holderFile = path.join(lockDir, 'holder');
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readHolder = () => {
    try {
      const [pidLine, tokenLine] = readFileSync(holderFile, 'utf8').split(/\r?\n/);
      return { pid: Number(pidLine) || 0, token: tokenLine || '' };
    } catch { return { pid: 0, token: '' }; }
  };
  const rmLock = () => { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ } };
  const tryAcquire = () => {
    try {
      mkdirSync(lockDir);
      writeFileSync(holderFile, `${process.pid}\n${token}\n`, 'utf8');
    } catch (err) {
      return err?.code !== 'EEXIST';
    }
    // 写完核对 holder 还是自己：mkdir 到写 holder 之间有窗口，别人可能已按悬挂接管
    const h = readHolder();
    return h.pid === process.pid && h.token === token;
  };
  // 持有者死亡（含强制重启残留）或锁超龄 → 悬挂，可强制接管
  const lockStale = () => {
    const h = readHolder();
    if (!h.pid || !pidAlive(h.pid)) return true;
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
    return { status: 'skipped', release: () => {} };
  }
  if (!acquired) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(acquired = acquireOrSteal())) await sleep(300);
    if (!acquired) {
      rmLock();
      acquired = tryAcquire();
      if (!acquired) console.log('headroom: 生命周期锁长时间无法获取，无锁继续执行');
    }
  }
  if (!acquired) return { status: 'unlocked', release: () => {} };
  const release = () => {
    // 释放后摘掉自己的 exit 监听器：power-watch 这类常驻进程每次抢锁都挂一个，
    // 不摘会攒出监听器超限警告
    process.off('exit', release);
    const h = readHolder();
    if (h.pid !== process.pid || h.token !== token) return;
    rmLock();
  };
  process.on('exit', release);
  return { status: 'held', release };
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
