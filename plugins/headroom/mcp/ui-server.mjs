#!/usr/bin/env node
// headroom-ui MCP 服务（UI Plugin）：为「headroom 压缩记录」侧栏面板提供 ui:// 资源与页面工具。
// 独立于现有 headroom 桥（bridge.mjs 一行不改，见 ADR-0005）：
//   - hr_savings_overview 直接跑 headroom CLI（savings --json）；
//   - hr_retrieve 把 bridge.mjs 当子进程拉起、经其 stdio 说 MCP，复用单例桥调 headroom_retrieve。
// 工具只给页面调用（_meta.ui.visibility=["app"]）。
// 协议：stdio 上的 MCP（JSON-RPC 2.0，按行分隔），手写实现。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findHeadroom } from './headroom-bin.mjs';

const SERVER_INFO = { name: 'headroom-ui', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
const PANEL_URI = 'ui://headroom/panel.html';
const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(MCP_DIR, '..');

const APP_ONLY = { ui: { visibility: ['app'] } };

const TOOLS = [
  {
    name: 'hr_savings_overview',
    description: '压缩节省总览（包装 headroom savings --json）：累计与近期节省的 token、费用、调用次数。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计窗口天数（默认 30，上限 30）' },
      },
    },
    _meta: APP_ONLY,
  },
  {
    name: 'hr_retrieve',
    description: '按哈希取回压缩前的原文（经现有单例桥调用 headroom 本体的 headroom_retrieve 工具）。',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: "压缩标记里的哈希（如 hash=abc123 里的 abc123）" },
      },
      required: ['hash'],
    },
    _meta: APP_ONLY,
  },
  {
    name: 'hr_recent_compressions',
    description: '列出最近仍可取回的压缩记录（哈希、时间、内容预览），读 headroom 的 ccr_store 数据库；条目有存活期（约 30 分钟），过期自动不显示。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: APP_ONLY,
  },
  {
    name: 'hr_daily_savings',
    description: '按日汇总的压缩节省（近 N 天每天的 token、费用、调用次数）、按模型分布与压缩率，逐条读 headroom 的 savings_events 事件账本聚合。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计天数（默认 14，上限 30）' },
      },
    },
    _meta: APP_ONLY,
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: 'headroom 压缩记录', mimeType: 'text/html;profile=mcp-app', description: '压缩节省总览与按哈希取回原文' },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

// —— 桥客户端：把 bridge.mjs 当子进程，经 stdio 说 MCP（桥负责守护复用/孵化/回退直连）——
let bridgeProc = null;
let bridgeBuf = '';
let bridgeSeq = 0;
let bridgeInitPromise = null;
const bridgePending = new Map(); // id -> {resolve, reject}

function bridgeSend(msg) {
  if (!bridgeProc) return;
  try { bridgeProc.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* ignore */ }
}

function bridgeDead(where) {
  bridgeProc = null;
  bridgeInitPromise = null;
  const err = new Error(`headroom 桥连接断开（${where}）`);
  for (const p of bridgePending.values()) p.reject(err);
  bridgePending.clear();
}

async function ensureBridge() {
  if (bridgeProc) return;
  const bin = findHeadroom();
  if (!bin) throw new Error('找不到 headroom：请先跑 /hr-setup 安装 headroom-ai，再重试');
  const bridgeScript = join(MCP_DIR, 'bridge.mjs');
  bridgeProc = spawn(process.execPath, [bridgeScript, '--', bin, 'mcp', 'serve'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  bridgeProc.stdout.setEncoding('utf8');
  bridgeProc.stdout.on('data', (chunk) => {
    bridgeBuf += chunk;
    let idx;
    while ((idx = bridgeBuf.indexOf('\n')) >= 0) {
      const line = bridgeBuf.slice(0, idx).trim();
      bridgeBuf = bridgeBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const hit = msg.id !== undefined && msg.id !== null ? bridgePending.get(String(msg.id)) : null;
      if (hit) {
        bridgePending.delete(String(msg.id));
        if (msg.error) hit.reject(new Error(msg.error.message || '桥请求失败'));
        else hit.resolve(msg.result);
      }
    }
  });
  bridgeProc.on('error', (e) => bridgeDead(`启动失败 ${e.message}`));
  bridgeProc.on('exit', () => bridgeDead('子进程退出'));
}

function bridgeRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!bridgeProc) { reject(new Error('桥未连接')); return; }
    const id = `u${bridgeSeq++}`;
    bridgePending.set(id, { resolve, reject });
    bridgeSend({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (bridgePending.delete(id)) reject(new Error(`桥请求超时：${method}`));
    }, 60000).unref();
  });
}

async function bridgeReady() {
  if (!bridgeInitPromise) {
    bridgeInitPromise = (async () => {
      await ensureBridge();
      await bridgeRequest('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'headroom-ui', version: SERVER_INFO.version },
      });
      bridgeSend({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
  }
  return bridgeInitPromise;
}

process.on('exit', () => { if (bridgeProc) { try { bridgeProc.kill(); } catch { /* ignore */ } } });

// —— 工具实现 ——

async function savingsOverview(args) {
  const bin = findHeadroom();
  if (!bin) return textResult('找不到 headroom：请先跑 /hr-setup 安装 headroom-ai', true);
  const days = Math.min(Math.max(1, Math.floor(Number(args?.days) || 30)), 30);
  const text = await new Promise((resolve) => {
    const child = spawn(bin, ['savings', '--json', '--days', String(days)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 20000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve(`headroom 启动失败：${e.message}`); });
    child.on('close', () => { clearTimeout(timer); resolve(out || err); });
  });
  try {
    const data = JSON.parse(text);
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: data };
  } catch {
    return textResult(`savings 输出解析失败：${String(text).slice(0, 300)}`, true);
  }
}

// 最近压缩记录：node:sqlite（Node ≥22.5 内建）只读打开 ccr_store；环境不支持或库不存在时
// 返回空列表加原因，页面退回手填哈希模式
async function recentCompressions() {
  const dbFile = join(homedir(), '.headroom', 'ccr_store.db');
  const empty = (note) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { items: [], note } });
  if (!existsSync(dbFile)) return empty('还没有压缩记录（~/.headroom/ccr_store.db 不存在，用一段时间后再看）');
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return empty('当前 Node 运行时不含 node:sqlite（需 ≥22.5），请从对话压缩标记里复制哈希手填');
  }
  try {
    // readOnly 在部分旧版 Node 会被忽略，但本工具只执行 SELECT，不会写入；
    // finally 保证查询抛错（表结构变化、库被锁）时连接也被关闭
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let rows;
    try {
      rows = db
        .prepare('SELECT hash, entry_json, created_at, ttl FROM ccr_entries ORDER BY created_at DESC LIMIT 50')
        .all();
    } finally {
      db.close();
    }
    const now = Date.now();
    const items = [];
    for (const r of rows) {
      const expiresAtMs = r.ttl ? (r.created_at + r.ttl) * 1000 : null;
      if (expiresAtMs !== null && expiresAtMs <= now) continue;
      let preview = '';
      let bytes = 0;
      try {
        const entry = JSON.parse(r.entry_json);
        const content = typeof entry.original_content === 'string' ? entry.original_content : '';
        bytes = content.length;
        preview = content.replace(/\s+/g, ' ').slice(0, 80);
      } catch {
        bytes = String(r.entry_json || '').length;
      }
      items.push({
        hash: String(r.hash),
        createdAt: new Date(r.created_at * 1000).toISOString(),
        expiresAtMs,
        preview,
        bytes,
      });
    }
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: { items } };
  } catch (e) {
    return textResult(`读取压缩记录失败：${e?.message || e}`, true);
  }
}

// 逐日/按模型汇总：流式解析 savings_events.jsonl（每行一个事件），按本地日期与模型聚合。
// 账本是 headroom 自己写的（v1 格式），字段变化时逐行 try/catch 跳过坏行
function dailySavings(args) {
  const file = join(homedir(), '.headroom', 'savings_events.jsonl');
  const empty = (note) => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { days: [], models: [], note } });
  if (!existsSync(file)) return empty('还没有事件账本（~/.headroom/savings_events.jsonl）');
  if (statSync(file).size > 50 * 1024 * 1024) return empty('事件账本超过 50 MiB，跳过逐日统计（可清理 ~/.headroom/savings_events.jsonl）');
  const days = Math.min(Math.max(1, Math.floor(Number(args?.days) || 14)), 30);
  const cutoff = Date.now() - days * 86400000;
  const byDay = new Map();
  const byModel = new Map();
  let ratioCount = 0;
  let ratioBest = 0;
  let totalBefore = 0;
  let totalAfter = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = Date.parse(ev.ts || '');
    if (!Number.isFinite(t) || t < cutoff) continue;
    const saved = Number(ev.saved) || 0;
    const cost = Number(ev.cost_usd) || 0;
    const d = new Date(t);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let day = byDay.get(dayKey);
    if (!day) { day = { date: dayKey, saved: 0, cost: 0, calls: 0 }; byDay.set(dayKey, day); }
    day.saved += saved;
    day.cost += cost;
    day.calls += 1;
    const modelKey = String(ev.model || '未知');
    let m = byModel.get(modelKey);
    if (!m) { m = { model: modelKey, saved: 0, calls: 0 }; byModel.set(modelKey, m); }
    m.saved += saved;
    m.calls += 1;
    const before = Number(ev.before) || 0;
    const after = Number(ev.after) || 0;
    totalBefore += before;
    totalAfter += after;
    if (before > 0 && after >= 0) {
      const r = (before - after) / before;
      ratioCount += 1;
      if (r > ratioBest) ratioBest = r;
    }
  }
  // 没有事件的日期补零，保证柱状图连续
  const series = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    series.push(byDay.get(key) || { date: key, saved: 0, cost: 0, calls: 0 });
  }
  const models = Array.from(byModel.values()).sort((a, b) => b.saved - a.saved).slice(0, 6);
  const compression = {
    // 整体压缩率用总量口径（总省/总原），与 headroom 官方面板一致；
    // 逐次平均会被大量微压缩请求抬高，不适合当"平均"展示
    avgRatio: totalBefore > 0 ? (totalBefore - totalAfter) / totalBefore : null,
    bestRatio: ratioBest > 0 ? ratioBest : null,
    samples: ratioCount,
  };
  return { content: [{ type: 'text', text: 'ok' }], structuredContent: { days: series, models, compression } };
}

async function handleCall(name, args) {
  if (name === 'hr_savings_overview') return savingsOverview(args);
  if (name === 'hr_recent_compressions') return recentCompressions();
  if (name === 'hr_daily_savings') return dailySavings(args);
  if (name === 'hr_retrieve') {
    const hash = String(args?.hash || '').trim();
    if (!/^[0-9a-zA-Z_-]+$/.test(hash)) return textResult('hash 格式不对（压缩标记里 hash= 后面的值）', true);
    await bridgeReady();
    const result = await bridgeRequest('tools/call', { name: 'headroom_retrieve', arguments: { hash } });
    return result;
  }
  return textResult(`未知工具：${name}`, true);
}

async function dispatch(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      return rpcResult(id, await handleCall(msg.params?.name, msg.params?.arguments));
    } catch (e) {
      return rpcResult(id, textResult(`调用失败：${e?.message || e}`, true));
    }
  }
  if (method === 'resources/list') return rpcResult(id, { resources: RESOURCES });
  if (method === 'resources/read') {
    const uri = String(msg.params?.uri || '');
    if (uri === PANEL_URI) {
      const file = join(PLUGIN_ROOT, 'dist', 'panel.html');
      try {
        return rpcResult(id, {
          contents: [{ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: readFileSync(file, 'utf8') }],
        });
      } catch (e) {
        return rpcError(id, -32002, `页面资源读取失败（${
          existsSync(file) ? '权限/IO 错误' : '产物缺失，请在插件仓库跑 pnpm build 后重装插件'
        }）：${e?.message || e}`);
      }
    }
    return rpcError(id, -32002, `未知资源：${uri}`);
  }
  if (method === 'ping') return rpcResult(id, {});
  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `method not found: ${method}`);
}

let pending = 0;
let stdinEnded = false;
function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    pending += 1;
    void dispatch(msg).then((resp) => {
      if (resp) process.stdout.write(`${JSON.stringify(resp)}\n`);
    }).finally(() => {
      pending -= 1;
      maybeExit();
    });
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
