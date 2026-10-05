#!/usr/bin/env node
// MCP stdio 单例桥：同一台机器上的多个 ZCode 运行时（主会话 + 子代理等）都按
// .mcp.json 各自拉起一份 MCP 服务进程，headroom 这类服务单份占上百 MB，并发
// 子代理时成倍放大内存压力。本桥让首个实例兼任守护方（持有真正的服务进程），
// 后续实例经本地套接字复用同一个 MCP 会话：initialize 只发给服务一次（在途时
// 后来者的握手挂起、应答后扇出，再后来的直接用缓存应答），请求/应答经 id 重映射
// 表路由回各自客户端（id 原值原样保留，类型不改；客户端的取消通知按在途请求
// 改写 id 后转发），服务端通知广播给所有客户端。全部客户端断开并空闲一段时间后，
// 守护方结束服务进程并退出。套接字机制不可用时自动退化为直接执行服务命令。
//
// 用法: node bridge.mjs -- <服务命令> [参数...]
// 环境变量:
//   MCP_BRIDGE_IDLE_MS   全部客户端断开后守护方存活时间（默认 120000）
//   MCP_BRIDGE_DEBUG     置 1 输出调试日志到 stderr
//
// 协议按 MCP stdio 传输层：一行一条 JSON 消息（NDJSON）。

import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dash = process.argv.indexOf('--');
if (dash < 0 || !process.argv[dash + 1]) {
  console.error('[mcp-bridge] 用法: bridge.mjs -- <服务命令> [参数...]');
  process.exit(2);
}
const serverArgv = process.argv.slice(dash + 1);
const IDLE_MS = Number(process.env.MCP_BRIDGE_IDLE_MS) > 0 ? Number(process.env.MCP_BRIDGE_IDLE_MS) : 120000;
const log = (...a) => { if (process.env.MCP_BRIDGE_DEBUG) console.error('[mcp-bridge]', ...a); };

// 套接字路径：同一服务命令（含参数）共用一个；Windows 用命名管道
const sockKey = createHash('sha1').update(JSON.stringify(serverArgv)).digest('hex').slice(0, 12);
const sockPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\zcode-mcp-bridge-${sockKey}`
  : (() => {
      const dir = path.join(tmpdir(), `zcode-mcp-bridge-${process.getuid()}`);
      // 0700：守护方套接字无应用层鉴权，目录必须仅限本用户访问；
      // mkdir 的 mode 只对新建生效，已存在（含前次宽松权限创建）的要补校正
      try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 竞争下已存在 */ }
      try { chmodSync(dir, 0o700); } catch { /* 无权限时尽力而为 */ }
      return path.join(dir, `${sockKey}.sock`);
    })();

const isRequest = (m) => m && m.method !== undefined && m.id !== undefined && m.id !== null;
const isNotification = (m) => m && m.method !== undefined && (m.id === undefined || m.id === null);
const isResponse = (m) => m && (m.result !== undefined || m.error !== undefined) && m.id !== undefined;

// 按行拆流（TCP 是字节流，消息可能跨块/粘包），cb 收到完整一行
function onLines(sock, cb) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) cb(line);
    }
  });
}

// =====================================================================
// 客户端：把本进程 stdio 桥接到守护方套接字；守护方消失则退出，
// 由宿主（ZCode）按 MCP 连接失败自行处理。
// =====================================================================
function runClient() {
  // 12 位十六进制（48bit）：短 id 并发客户端会碰撞——守护方按 id 路由应答，
  // 碰撞时连接互相覆盖、应答串线
  const clientId = randomBytes(6).toString('hex');
  const sock = net.connect(sockPath);
  const send = (line) => { try { sock.write(JSON.stringify({ c: clientId, d: line }) + '\n'); } catch { /* ignore */ } };
  const stop = () => { try { sock.destroy(); } catch { /* ignore */ } process.exit(1); };

  sock.on('connect', () => log(`client ${clientId} 已连接`));
  sock.on('close', stop);
  sock.on('error', stop);
  onLines(sock, (line) => {
    try {
      const env = JSON.parse(line);
      // '*' 为守护方广播；d 是已序列化的服务端消息原文，直接透传给宿主
      if (env && typeof env.d === 'string' && (env.c === clientId || env.c === '*')) {
        process.stdout.write(env.d + '\n');
      }
    } catch { log('守护方消息解析失败'); }
  });

  onLines(process.stdin, send);
  process.stdin.on('end', () => { try { sock.end(); } catch { /* ignore */ } process.exit(0); });
  process.stdin.on('close', () => { try { sock.end(); } catch { /* ignore */ } });
}

// =====================================================================
// 守护方：监听套接字，持有真正的服务进程，服务多个客户端
// =====================================================================
function createDaemon() {
  const clients = new Map();    // clientId -> socket
  let server = null;
  let serverDead = false;
  let initResult = null;        // 首个 initialize 的结果缓存（后来客户端直接复用）
  let initInFlight = false;     // 首个 initialize 已发出、应答未回（期间的握手挂起等扇出）
  const initWaiters = [];       // 等首个 initialize 应答的后来客户端 [{ client, id }]
  let sawInitNotified = false;  // initialized 通知只向服务放行一份
  const pending = new Map();    // 发往服务的请求 id -> { client, id, init? }
  const serverReqs = new Set(); // 服务端主动发起、尚无应答的请求 id（首个应答生效）
  let seq = 0;
  let idleTimer = null;
  let closing = false;
  let ownsSock = false; // 是否取得监听权（决定退出时能否清理套接字文件）

  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const armIdle = () => { clearIdle(); idleTimer = setTimeout(shutdown, IDLE_MS); };

  function sendTo(clientId, msg) {
    const s = clients.get(clientId);
    if (!s) return;
    try { s.write(JSON.stringify({ c: clientId, d: JSON.stringify(msg) }) + '\n'); } catch { /* ignore */ }
  }
  function broadcast(msg) {
    const payload = JSON.stringify({ c: '*', d: JSON.stringify(msg) }) + '\n';
    for (const s of clients.values()) { try { s.write(payload); } catch { /* ignore */ } }
  }
  const toServer = (msg) => {
    if (!server || serverDead) return;
    try { server.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
  };

  function ensureServer() {
    if (server || serverDead) return;
    log('启动服务:', serverArgv.join(' '));
    server = spawn(serverArgv[0], serverArgv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
    server.on('error', (err) => { log('服务进程启动失败:', err.message); serverDead = true; shutdown(); });
    onLines(server.stdout, handleServerLine);
    server.on('exit', () => { serverDead = true; log('服务进程退出'); shutdown(); });
  }

  function handleServerLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { log('服务消息解析失败'); return; }
    if (isResponse(msg)) {
      const hit = pending.get(String(msg.id));
      if (!hit) return; // 服务端主动请求的重复应答（已放行首份），丢弃
      pending.delete(String(msg.id));
      if (hit.init) {
        // 首个握手应答：缓存成功结果（失败不缓存，之后的客户端可重新握手），
        // 并扇出给在途期间到达的后来客户端
        initInFlight = false;
        if (msg.result !== undefined) initResult = msg.result;
        for (const w of initWaiters.splice(0)) {
          const out = { jsonrpc: '2.0', id: w.id };
          if (msg.result !== undefined) out.result = msg.result; else out.error = msg.error;
          sendTo(w.client, out);
        }
      }
      const out = { jsonrpc: '2.0', id: hit.id };
      if (msg.result !== undefined) out.result = msg.result; else out.error = msg.error;
      sendTo(hit.client, out);
      return;
    }
    if (isRequest(msg)) serverReqs.add(String(msg.id)); // 应答只收第一份
    broadcast(msg);
  }

  function handleClientLine(clientId, rawLine) {
    let msg;
    try { msg = JSON.parse(rawLine); } catch { return; }
    if (isRequest(msg)) {
      if (msg.method === 'initialize') {
        if (initResult) {
          // 握手结果已有缓存：直接应答，服务侧不重复 initialize
          sendTo(clientId, { jsonrpc: '2.0', id: msg.id, result: initResult });
          return;
        }
        if (initInFlight) {
          // 首个 initialize 还在途：挂起等扇出。直接放行会给服务发第二次握手，
          // 服务端通常按协议错误拒绝，该客户端的工具将全部不可用
          initWaiters.push({ client: clientId, id: msg.id });
          return;
        }
        initInFlight = true;
      }
      ensureServer();
      const daemonId = `b${seq++}`;
      pending.set(daemonId, { client: clientId, id: msg.id, init: msg.method === 'initialize' });
      toServer({ ...msg, id: daemonId });
      return;
    }
    if (isNotification(msg)) {
      ensureServer();
      if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
        if (sawInitNotified) return; // 重复的握手完成通知不再打扰服务
        sawInitNotified = true;
      }
      // 取消通知带的是客户端自己的请求 id：找到本客户端的在途请求改写成守护方
      // id 再转发；找不到（已完成/不属于它）就丢弃——原样转发会误伤服务端认识的
      // 恰好同 id 的其他请求
      if (msg.method === 'notifications/cancelled' && msg.params && msg.params.requestId !== undefined && msg.params.requestId !== null) {
        let target = null;
        for (const [d, hit] of pending) {
          if (hit.client === clientId && String(hit.id) === String(msg.params.requestId)) { target = d; break; }
        }
        if (!target) { log(`client ${clientId} 取消的请求不在途，丢弃`); return; }
        toServer({ ...msg, params: { ...msg.params, requestId: target } });
        return;
      }
      toServer(msg);
      return;
    }
    if (isResponse(msg)) {
      // 客户端应答服务端主动发起的请求：id 与服务端原值一致，只放行第一份
      if (serverReqs.has(String(msg.id))) {
        serverReqs.delete(String(msg.id));
        toServer(msg);
      }
    }
  }

  function shutdown() {
    if (closing) return;
    closing = true;
    clearIdle();
    for (const s of clients.values()) { try { s.end(); } catch { /* ignore */ } }
    if (server) {
      try { server.kill('SIGTERM'); } catch { /* ignore */ }
      const kill = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ignore */ } process.exit(0); }, 3000);
      kill.unref();
      server.on('exit', () => process.exit(0));
    } else {
      process.exit(0);
    }
  }

  const listener = net.createServer((sock) => {
    clearIdle();
    let clientId = null;
    sock.on('close', () => {
      if (clientId) {
        clients.delete(clientId);
        log(`client ${clientId} 断开，剩余 ${clients.size}`);
      }
      // 未注册就断开的静默连接也要能重新进入空闲计时，否则守护方永不退出
      if (clients.size === 0) armIdle();
    });
    sock.on('error', () => { try { sock.destroy(); } catch { /* ignore */ } });
    onLines(sock, (line) => {
      let env;
      try { env = JSON.parse(line); } catch { return; }
      if (!env || !env.c || typeof env.d !== 'string') return;
      if (!clientId) {
        clientId = env.c;
        clients.set(clientId, sock);
        log(`client ${clientId} 接入`);
      }
      if (env.c === clientId) handleClientLine(clientId, env.d);
    });
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // 只有真正取得监听权的进程才在退出时清理套接字文件，避免误删竞争赢家的
  process.on('exit', () => {
    if (!ownsSock) return;
    try { if (process.platform !== 'win32') rmSync(sockPath, { force: true }); } catch { /* ignore */ }
  });
  return {
    listener,
    start() { ownsSock = true; armIdle(); },
    shutdown,
  };
}

// —— 启动流程 ——
// 客户端模式：先试连现有守护方；没有则孵化一个独立的守护进程（detached，与任何
// ZCode 运行时进程无关——运行时被强杀不影响其他客户端），再接入。
// 守护模式（--daemon-role）：只监听 + 持有服务进程，不接 stdio；监听竞争的输家
// 静默退出，因此多个客户端同时孵化也不会出现两个守护方。
const probe = () => new Promise((resolve) => {
  const s = net.connect(sockPath);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

// 监听一次：成功 resolve(true)；失败 resolve(err)
const tryListen = (listener, p) => new Promise((resolve) => {
  const onOk = () => { cleanup(); resolve(true); };
  const onErr = (e) => { cleanup(); resolve(e); };
  const cleanup = () => { listener.removeListener('listening', onOk); listener.removeListener('error', onErr); };
  listener.once('listening', onOk);
  listener.once('error', onErr);
  listener.listen(p);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes('--daemon-role')) {
  const daemon = createDaemon();
  let res = await tryListen(daemon.listener, sockPath);
  if (res !== true && res && res.code === 'EADDRINUSE') {
    // 套接字文件残留（守护方被强杀未及清理）：确认确实无人监听后清掉重试一次；
    // 若真有别的守护方，本进程就是多余竞争者，退出
    if (!(await probe())) {
      try { if (process.platform !== 'win32') rmSync(sockPath, { force: true }); } catch { /* ignore */ }
      res = await tryListen(daemon.listener, sockPath);
    }
  }
  if (res === true) {
    daemon.start();
    log('守护进程就绪:', sockPath);
  } else {
    log('守护监听竞争失败，退出:', res && res.code);
    process.exit(0);
  }
} else {
  const directRun = () => {
    log('回退直连:', serverArgv.join(' '));
    const child = spawn(serverArgv[0], serverArgv.slice(1), { stdio: 'inherit' });
    child.on('error', () => process.exit(127));
    child.on('exit', (c) => process.exit(c ?? 0));
  };

  if (!(await probe())) {
    // 随机小延迟错峰孵化，减少重复 daemon（输了也会自行退出，无副作用）
    await sleep(Math.floor(Math.random() * 150));
    if (!(await probe())) {
      const { realpathSync } = await import('node:fs');
      const self = realpathSync(process.argv[1]);
      const child = spawn(process.execPath, [self, '--daemon-role', '--', ...serverArgv], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
      // 等守护方就绪（监听竞争输家会退出，赢家通常百毫秒内就绪）
      for (let i = 0; i < 100 && !(await probe()); i++) await sleep(100);
    }
  }
  if (await probe()) runClient();
  else directRun();
}
