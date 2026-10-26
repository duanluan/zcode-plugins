#!/usr/bin/env node
// 多供应商压缩路由（Plan A，ADR-0008）：所有接入的供应商 baseUrl 统一指向本地路由端口
// （默认 8787），路由器按请求头里的 API key 哈希识别供应商 → 转发到该供应商对应的
// headroom 实例（内部端口 28790 起，879x 段实测会被 IDE 的 Java 进程占用；按"格式+
// 上游"去重共享）→ headroom 压缩后把鉴权原样透传给真实上游（中转站或官方）。key 不
// 在插件侧存储明文，只存 sha256。
//
// 动作：
//   hr-multi.mjs ensure    确保路由器与全部实例在跑（providers 未配置时输出 legacy 并退出码 3）
//   hr-multi.mjs stop      停路由器与全部实例
//   hr-multi.mjs status    列出映射与端口状态
//   hr-multi.mjs --serve   路由器进程入口（由 ensure 拉起，不手动调用）
// 环境变量：HR_HEADROOM_CONFIG 覆盖配置文件路径（自测用）。
//
// 配置 ~/.zcode/headroom.json 在既有键之外新增（读改写保留其他键）：
//   router:  { port: 8787 }
//   providers: [ { id, name, upstream, format: "openai"|"anthropic", keyHash, origBaseURL } ]
//   instances: { "<format|upstream>": 端口 }   // 稳定分配，避免重启换端口

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHeadroom } from '../mcp/headroom-bin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = homedir();
const CONFIG = process.env.HR_HEADROOM_CONFIG || path.join(home, '.zcode', 'headroom.json');
const STATE = process.env.HR_HEADROOM_CONFIG
  ? path.join(path.dirname(process.env.HR_HEADROOM_CONFIG), 'hr-multi-test.state')
  : path.join(home, '.zcode-headroom-multi.state');
const LOG = path.join(home, '.zcode-headroom-proxy.log');
// 内部实例端口起始（879x 段实测会被 IDE 的 Java 进程占用）。自测模式端口错开真机，
// 否则测试实例会抢走真机实例的端口、测试 stop 会误杀真机实例
const BASE_PORT = process.env.HR_HEADROOM_CONFIG ? 38790 : 28790;

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}
function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(st) {
  writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n', 'utf8');
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// 试绑定判断端口空闲；被任何进程（哪怕不是我们的）占用都返回 false
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

// 路由器身份探测：/livez 必须回 hr-multi-router。只看端口有应答会把旧 headroom
// 单实例（同样有 /livez）误认成路由器，导致路由器永远起不来
function routerUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/livez', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body.trim() === 'hr-multi-router'));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// 停旧单实例代理（路由器端口被旧 headroom 占着时由 ensure 的自动恢复逻辑调用；没有旧
// 实例时是无害空操作）。它停的是真机旧代理（按真机状态文件登记 pid 杀进程），所以自测
// 模式（设置了 HR_HEADROOM_CONFIG）必须是空操作——2026-10-17 实测自测时误调它把真机
// 8787 服务杀了
function stopLegacy(port) {
  return new Promise((resolve) => {
    if (process.env.HR_HEADROOM_CONFIG) { resolve(); return; }
    if (process.platform === 'win32') {
      import('./headroom-lib.mjs').then((lib) => lib.proxyStop(port || 8787)).then(() => resolve());
      return;
    }
    const child = spawn('/bin/sh', [path.join(here, 'ensure-proxy.sh'), 'stop'], { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

// 端口探测：优先官方 /livez，回退 /health
function portUp(port) {
  const probe = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 2000 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  return probe('/livez').then((ok) => ok || probe('/health'));
}

// 日志文件：自测模式（HR_HEADROOM_CONFIG）写到 /tmp，绝不混入真机日志
const logFile = () => (process.env.HR_HEADROOM_CONFIG ? '/tmp/hr-multi-test.log' : LOG);

function appendLog(text) {
  try {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    writeFileSync(logFile(), `${stamp} ${process.env.HR_HEADROOM_CONFIG ? '[test] ' : ''}${text}`, { flag: 'a' });
  } catch { /* 日志失败不影响主流程 */ }
}

// —— 实例规划：按"格式+上游"分组共享。端口复用条件 = state 里该组的 pid 存活
// （是我们拉起的实例）；pid 存活时端口未监听也算复用（实例启动要数秒到十几秒，
// 冷启动窗口内后续 ensure 不改端口——否则会杀掉正在初始化的实例、换端口重拉，
// 应用启动时多个恢复会话连发钩子必踩）；pid 不活时配置端口视为失效，
// 从 BASE_PORT 找可绑定空闲口 ——
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 该组最近一次 spawn 的时间戳在宽限期内（默认 30 秒，启动慢的冷启动够用）：
// pid 活着但端口还没监听时视为"启动中"，不杀不重拉；超期仍没监听按卡死处理
const START_GRACE_MS = 30_000;
function startingGrace(st, key) {
  const t = st.startedAt && st.startedAt[key];
  return typeof t === 'number' && Date.now() - t < START_GRACE_MS;
}

async function plan(cfg, st) {
  const groups = new Map();
  for (const p of cfg.providers || []) {
    if (!p || !p.format || !p.upstream) {
      console.error(`跳过不完整的供应商注册（缺 format/upstream，请用 /hr-join 重新接入）：${(p && (p.name || p.id)) || '未知'}`);
      continue;
    }
    const key = `${p.format}|${p.upstream}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  cfg.instances = cfg.instances || {};
  st.instances = st.instances || {};
  const used = new Set();
  let next = BASE_PORT;
  const findFree = async () => {
    while (!await canBind(next) || used.has(next)) next += 1;
    used.add(next);
    return next;
  };
  const plans = [];
  for (const [key, provs] of groups) {
    let port = cfg.instances[key];
    const ourPid = st.instances[key];
    if (port && !used.has(port) && ourPid && pidAlive(ourPid)) {
      // 我们拉起的实例还活着（含端口未监听的启动窗口）：保留原端口，不重分配
      used.add(port);
    } else {
      port = await findFree();
      cfg.instances[key] = port;
    }
    plans.push({ key, port, format: provs[0].format, upstream: provs[0].upstream, providers: provs, pid: ourPid });
  }
  return plans;
}

async function killTree(pid) {
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true }, () => {});
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
}

// —— ensure：拉起缺的实例与路由器 ——
async function doEnsure() {
  const cfg = readConfig();
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    console.log('legacy');
    return 3;
  }
  const routerPort = (cfg.router && cfg.router.port) || 8787;
  const st0 = readState();
  const plans = await plan(cfg, st0);
  writeConfig(cfg);
  writeState(st0);
  const bin = await findHeadroom();
  if (!bin) { console.error('找不到 headroom 可执行文件（先 /hr-setup 安装）'); return 1; }
  const st = st0;
  st.instances = st.instances || {};
  for (const pl of plans) {
    // 幂等判定：本组登记 pid 存活且端口健康 → 跳过；pid 活着但端口未监听且仍在
    // 启动宽限期内（冷启动要数秒到十几秒）→ 同样跳过，不杀不重拉；超期还没监听
    // 按卡死处理重拉；pid 已死（含被陌生进程占口）重拉
    if (pl.pid && pidAlive(pl.pid)) {
      if (await portUp(pl.port)) { console.log(`实例 ${pl.key} 127.0.0.1:${pl.port} 已在跑`); st.instances[pl.key] = pl.pid; continue; }
      if (startingGrace(st, pl.key)) { console.log(`实例 ${pl.key} 127.0.0.1:${pl.port} 启动中（pid ${pl.pid}），本次不干预`); continue; }
      killTree(pl.pid);
    }
    const env = { ...process.env };
    // 上游用 CLI 参数显式指定。注意不要传 --backend：默认（passthrough）会按鉴权风格
    // 自动选 anthropic/openai 上游并使用下面的 URL 覆盖；传 --backend openai 会覆写成
    // litellm 的 openai 提供者（无视自定义 URL 直连 api.openai.com，实测被墙即报错）
    const proxyArgs = ['proxy', '--port', String(pl.port)];
    if (pl.format === 'anthropic') proxyArgs.push('--anthropic-api-url', pl.upstream);
    else proxyArgs.push('--openai-api-url', pl.upstream);
    const backend = cfg.kompressBackend;
    if (backend && backend !== 'auto') env.HEADROOM_KOMPRESS_BACKEND = backend;
    try {
      const logFd = openSync(logFile(), 'a');
      const child = spawn(bin, proxyArgs, { detached: true, stdio: ['ignore', logFd, logFd], env, windowsHide: true });
      child.unref();
      st.instances[pl.key] = child.pid;
      st.startedAt = st.startedAt || {};
      st.startedAt[pl.key] = Date.now();
      appendLog(`start headroom port=${pl.port} upstream=${pl.upstream} format=${pl.format}\n`);
    } catch (e) {
      console.error(`实例 ${pl.key} 启动失败：${e.message}`);
    }
  }
  // 实例 pid 先落盘再做路由器接管：接管失败的提前 return 不能把刚拉起的实例 pid
  // 丢在内存里——否则 stop 按状态文件找不到它们，就成了杀不掉的孤儿进程
  writeState(st);
  if (await routerUp(routerPort)) {
    console.log(`路由器 127.0.0.1:${routerPort} 已在跑`);
  } else if (!(await canBind(routerPort))) {
    // 端口被占且不是我们的路由器（典型：旧 headroom 单实例占着 8787）。只有路由器端口
    // 就是旧代理端口时才停旧代理接管；停完还被占（陌生进程）则明确失败，绝不把陌生进程当路由器
    const legacyPort = Number(process.env.HEADROOM_PROXY_PORT) || 8787;
    if (routerPort === legacyPort) {
      console.log(`端口 ${routerPort} 被非路由器进程占用，先停止旧单实例代理…`);
      await stopLegacy(legacyPort);
      for (let i = 0; i < 5 && !(await canBind(routerPort)); i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!(await canBind(routerPort))) {
      console.error(`端口 ${routerPort} 仍被占用（非旧代理进程），路由器无法接管；排查：ss -tlnp | grep ${routerPort}`);
      return 1;
    }
  }
  if (!(await routerUp(routerPort))) {
    try {
      const logFd = openSync(logFile(), 'a');
      const env = { ...process.env, HR_MULTI_ROUTER_PORT: String(routerPort) };
      if (process.env.HR_HEADROOM_CONFIG) env.HR_HEADROOM_CONFIG = process.env.HR_HEADROOM_CONFIG;
      const child = spawn(process.execPath, [path.join(here, 'hr-multi.mjs'), '--serve'], { detached: true, stdio: ['ignore', logFd, logFd], env, windowsHide: true });
      child.unref();
      st.routerPid = child.pid;
      appendLog(`start router port=${routerPort}\n`);
    } catch (e) {
      console.error(`路由器启动失败：${e.message}`);
    }
  }
  writeState(st);
  // 最多等 10 秒让端口就绪
  for (let i = 0; i < 10; i++) {
    const allUp = (await portUp(routerPort)) && (await Promise.all(plans.map((pl) => portUp(pl.port)))).every(Boolean);
    if (allUp) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await doStatus();
  return 0;
}

async function doStop() {
  const st = readState();
  killTree(st.routerPid);
  for (const pid of Object.values(st.instances || {})) killTree(pid);
  rmSync(STATE, { force: true });
  console.log('路由器与全部实例已停止');
  return 0;
}

// —— 电源状态与省电档检测（与 headroom-lib.sh hr_power_flags / hr_saver_detect
// 同语义的 Node 实现）：multi 模式没有常驻监视器，但 status 仍要如实报告当前电源
// 与检测能力——ZCode Pro 面板的“电源 / 省电模式检测”两栏读这两行输出
const shOut = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
});

async function winPowerFlags() {
  const out = await shOut('powershell.exe', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.SystemInformation]::PowerStatus; $s="Indeterminate"; try{$s=[string]$p.PowerSavingMode}catch{}; "PL=$($p.PowerLineStatus);SAVER=$s;SCHEME=$(powercfg /getactivescheme)"']);
  if (out == null) return null;
  const f = [];
  if (/SAVER=True/.test(out) || out.includes('a1841308-3541-4fab-bc81-f71556f20b4a')) f.push('saver');
  if (/PL=Offline/.test(out)) f.push('battery');
  return f;
}

// → { mode: 'ac'|'battery'|'saver'|'saver+battery', saverDetect: 'ok'|'missing'|'broken' }
async function powerInfo() {
  if (process.platform === 'win32') {
    const f = (await winPowerFlags()) || [];
    const mode = f.includes('saver') && f.includes('battery') ? 'saver+battery' : (f[0] || 'ac');
    return { mode, saverDetect: 'ok' };
  }
  if (process.platform === 'darwin') {
    const f = [];
    const g = await shOut('pmset', ['-g']);
    if (/^\s*lowpowermode\s+1/m.test(g || '')) f.push('saver');
    const b = await shOut('pmset', ['-g', 'batt']);
    if (/Battery Power/.test(b || '')) f.push('battery');
    return { mode: f.includes('saver') && f.includes('battery') ? 'saver+battery' : (f[0] || 'ac'), saverDetect: 'ok' };
  }
  // Linux：powerprofilesctl（其 shebang 的 python3 可能被用户级 Python 劫持缺 gi 崩溃，
  // 失败用系统 Python 重试——hr_ppd_get 同款）+ /sys 电池放电状态
  let saverDetect = 'missing';
  let ppd = null;
  const which = await shOut('sh', ['-c', 'command -v powerprofilesctl']);
  if (which && which.trim()) {
    saverDetect = 'broken';
    ppd = await shOut('powerprofilesctl', ['get']);
    if (ppd == null) ppd = await shOut('/usr/bin/python3', [which.trim(), 'get']);
    if (ppd != null) saverDetect = 'ok';
  }
  const f = [];
  if (ppd && ppd.includes('power-saver')) f.push('saver');
  let batSeen = false;
  try {
    for (const name of readdirSync('/sys/class/power_supply')) {
      if (!/^BAT/.test(name)) continue;
      batSeen = true;
      try {
        if (readFileSync(`/sys/class/power_supply/${name}/status`, 'utf8').trim() === 'Discharging') { f.push('battery'); break; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  // WSL 看不到主机电池：改查 Windows 侧
  if (!batSeen) {
    const win = await winPowerFlags();
    if (win) return { mode: win.includes('saver') && win.includes('battery') ? 'saver+battery' : (win[0] || 'ac'), saverDetect };
  }
  return { mode: f.includes('saver') && f.includes('battery') ? 'saver+battery' : (f[0] || 'ac'), saverDetect };
}

// 结构化状态（不打印）：ensure-proxy 的 status 输出与 headroom-ui 面板的
// hr_router_status 工具共用这一份探测，避免两处各自维护端口/分组判定。
// providers 未配置时返回 { legacy: true }，调用方各自表达。
export async function statusData() {
  const cfg = readConfig();
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    return { legacy: true };
  }
  const routerPort = (cfg.router && cfg.router.port) || 8787;
  const st = readState();
  const plans = await plan(cfg, st);
  const instances = [];
  for (const pl of plans) {
    instances.push({
      port: pl.port,
      format: pl.format,
      upstream: pl.upstream,
      up: await portUp(pl.port),
      providers: pl.providers.map((p) => p.name || p.id),
    });
  }
  return {
    legacy: false,
    router: { port: routerPort, up: await portUp(routerPort) },
    instances,
    backend: cfg.kompressBackend || 'auto',
    powerSave: cfg.powerSaveCpu || 'off',
    watchInterval: Math.max(10, Number(cfg.powerWatchInterval) || 60),
    managed: Object.keys(st.instances || {}).length > 0,
    ...(await powerInfo()),
  };
}

async function doStatus() {
  const data = await statusData();
  if (data.legacy) {
    console.log('legacy');
    return 3;
  }
  const { router, instances } = data;
  // 人读摘要
  console.log(`路由器 127.0.0.1:${router.port}：${router.up ? '运行中' : '未运行'}`);
  for (const it of instances) {
    const names = it.providers.join('、');
    console.log(`  实例 :${it.port} ${it.format} → ${it.upstream} ${it.up ? '运行中' : '未运行'} | 供应商：${names}`);
  }
  // —— 机器可读字段：字段名与单实例模式（ensure-proxy 的 status）对齐，已发布的
  // ZCode Pro（parseHeadroomStatus 只认这些字段）无需更新即可恢复“运行中”判定；
  // instance 行是给新版 ZCode Pro 的实例列表（旧版忽略未知行）。多实例模式没有独立
  // 电源监视器（切后端走 backend 动作重启实例），watcher 恒为 stopped，
  // power-mode / saver-detect 无来源、不输出（面板显示 —）
  console.log(`proxy: ${router.up ? 'up' : 'down'} (127.0.0.1:${router.port})`);
  console.log(`managed-by-plugin: ${data.managed ? 'yes' : 'no'}`);
  console.log(`instances: ${instances.length}`);
  for (const it of instances) {
    console.log(`instance: ${it.port} ${it.format} ${it.upstream} ${it.up ? 'up' : 'down'} ${it.providers.join('、')}`);
  }
  console.log(`current-backend: ${data.backend}`);
  console.log(`desired-backend: ${data.backend}`);
  console.log(`power-mode: ${data.mode}`);
  console.log(`power-save-auto-cpu: ${data.powerSave} (interval ${data.watchInterval}s)`);
  console.log(`saver-detect: ${data.saverDetect}`);
  console.log('watcher: stopped');
  return 0;
}

// —— 路由器进程 ——
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

function serve() {
  const cfg = readConfig();
  const port = Number(process.env.HR_MULTI_ROUTER_PORT) || (cfg.router && cfg.router.port) || 8787;
  // keyHash → 实例端口（anthropic 客户端用 x-api-key，openai 用 Authorization Bearer）。
  // 每个请求重读配置（文件只有几 KB）：/hr-join 追加供应商后无需重启路由器即可路由；
  // 路由表若只在启动时建一次，后接入的供应商 key 会一律 502"未接入"
  const routesNow = () => {
    const m = new Map();
    const c = readConfig();
    for (const p of c.providers || []) {
      const inst = (c.instances || {})[`${p.format}|${p.upstream}`];
      if (inst) m.set(String(p.keyHash), inst);
    }
    return m;
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/livez' || req.url === '/health') { res.writeHead(200); res.end('hr-multi-router'); return; }
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const apiKey = String(req.headers['x-api-key'] || '') || bearer;
    const routes = routesNow();
    let target = null;
    if (apiKey) target = routes.get(sha256(apiKey)) || null;
    if (!target) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: '该 API key 未接入 headroom 压缩路由',
        hint: '用 /hr-join 查看已接入的供应商，或把该供应商的 baseUrl 改回原值',
        keyHash8: apiKey ? sha256(apiKey).slice(0, 8) : null,
      }));
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers }, (upRes) => {
      const h = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_HEADERS.has(k.toLowerCase())) h[k] = v;
      }
      res.writeHead(upRes.statusCode, h);
      upRes.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `压缩实例（127.0.0.1:${target}）不可达：${e.message}`, hint: '跑 /hr-join 或 hooks/hr-multi.mjs ensure 重新拉起' }));
    });
    req.pipe(up);
  });
  // SSE/长流：不限请求时长
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.listen(port, '127.0.0.1', () => {
    appendLog(`router listening on 127.0.0.1:${port} routes=${routesNow().size}\n`);
  });
}

// —— 入口：handle 供 ensure-proxy.mjs 直接 import（返回 'legacy' 或退出码）；CLI 同语义 ——
export async function handle(action) {
  if (action === '--serve') { serve(); return null; } // 常驻，不返回
  if (action === 'ensure' || action === 'start') return await doEnsure();
  if (action === 'stop') return await doStop();
  if (action === 'restart') { await doStop(); return await doEnsure(); }
  if (action === 'status') return await doStatus();
  console.error('用法: hr-multi.mjs [ensure|start|stop|restart|status|--serve]');
  return 2;
}

// ensure/start/status 的返回码 3 = 未配置 providers（legacy 模式），调用方据此走旧代理
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const action = process.argv[2] || 'ensure';
  const r = await handle(action);
  if (r !== null) process.exit(r === 3 ? 3 : r === 2 ? 2 : r === 1 ? 1 : 0);
}
