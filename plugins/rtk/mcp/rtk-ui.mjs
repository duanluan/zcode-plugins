#!/usr/bin/env node
// rtk-ui MCP 服务（UI Plugin）：为「rtk 输出记录」侧栏面板提供 ui:// 资源与页面工具。
// 工具只给页面调用（_meta.ui.visibility=["app"]，不进模型工具列表）；数据经 rtk CLI
// 读取（recall.db 由 rtk 本体管理，本服务不碰数据库文件）。
// 协议：stdio 上的 MCP（JSON-RPC 2.0，按行分隔），与 vision-mcp.mjs 同款手写实现。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRtk } from '../lib/rtk-bin.mjs';

const SERVER_INFO = { name: 'rtk-ui', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
const PANEL_URI = 'ui://rtk/panel.html';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APP_ONLY = { ui: { visibility: ['app'] } };

const TOOLS = [
  {
    name: 'rtk_recent_outputs',
    description: '列出最近的 rtk 命令输出记录（优先读 rtk 本体的 recall.db：含时间戳与完整命令；库不可用时退回解析 rtk recall --list）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回多少条（默认 200，上限 500）' },
      },
    },
    _meta: APP_ONLY,
  },
  {
    name: 'rtk_read_output',
    description: '读取一条 rtk 输出记录的内容（包装 rtk recall）。默认只返回被压缩省略的部分。',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: '记录哈希（唯一前缀即可）' },
        full: { type: 'boolean', description: '返回完整输出而不是被省略的部分' },
        grep: { type: 'string', description: '按正则过滤行' },
      },
      required: ['hash'],
    },
    _meta: APP_ONLY,
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: 'rtk 输出记录', mimeType: 'text/html;profile=mcp-app', description: '查看与搜索最近的 rtk 命令完整输出' },
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

function runRtk(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const rtk = findRtk();
    if (!rtk) {
      resolve({ ok: false, text: '找不到 rtk 可执行文件：请先运行 /rtk-setup 安装 rtk（github.com/rtk-ai/rtk）' });
      return;
    }
    const child = spawn(rtk, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: `rtk 启动失败：${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, text: out || err });
    });
  });
}

// recall.db 是 rtk 本体的正式存储（v0.51 schema：hash/command/created_at/total_lines/
// shown_upto/byte_size/truncated）；库不存在、node:sqlite 不可用或结构变化时返回 null 走兜底
async function listFromDb(limit) {
  const file = path.join(homedir(), '.local', 'share', 'rtk', 'recall.db');
  if (!existsSync(file)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null;
  }
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    let rows;
    try {
      rows = db
        .prepare('SELECT hash, command, created_at, total_lines, shown_upto, byte_size, truncated FROM recall ORDER BY created_at DESC LIMIT ?')
        .all(limit);
    } finally {
      db.close();
    }
    return rows.map((r) => ({
      hash: String(r.hash),
      command: String(r.command),
      lines: r.total_lines ?? 0,
      hidden: Math.max((r.total_lines ?? 0) - (r.shown_upto ?? 0), 0),
      bytes: typeof r.byte_size === 'number' ? r.byte_size : null,
      truncated: r.truncated === 1,
      createdAt: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
    }));
  } catch {
    return null;
  }
}

// CLI 列表（兜底数据源）：同步跑 rtk recall --list，失败返回 null
function spawnSyncRtkList() {
  const rtk = findRtk();
  if (!rtk) return null;
  const r = spawnSync(rtk, ['recall', '--list'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

// 列表是固定列的文本表：HASH COMMAND LINES HIDDEN ORIG EXIT TRUNC
function parseList(text, limit) {
  const items = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{8,})\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(\s+(\S+))?$/);
    if (!m) continue;
    items.push({
      hash: m[1],
      command: m[2],
      lines: Number(m[3]),
      hidden: Number(m[4]),
      bytes: null,
      truncated: Boolean(m[8] && m[8] !== '-'),
      createdAt: null,
      // 兜底路径才有：CLI 列表的紧凑体积串（如 4.5K）
      origText: m[5],
    });
    if (items.length >= limit) break;
  }
  return items;
}

async function handleCall(name, args) {
  if (name === 'rtk_recent_outputs') {
    const limit = Math.min(Math.max(1, Number(args?.limit) || 200), 500);
    // 优先读 rtk 本体的 recall.db（时间戳、完整命令、精确字节数）；不可用时退回 CLI 列表解析
    const fromDb = await listFromDb(limit);
    const items = fromDb ?? (() => {
      // parseList 同步解析 CLI 输出；失败时返回空列表由页面提示
      const r = spawnSyncRtkList();
      return r ? parseList(r, limit) : [];
    })();
    return { content: [{ type: 'text', text: `${items.length} 条记录` }], structuredContent: { items, source: fromDb ? 'db' : 'cli' } };
  }
  if (name === 'rtk_read_output') {
    const hash = String(args?.hash || '').trim();
    if (!/^[0-9a-f]+$/i.test(hash)) return textResult('hash 必须是十六进制哈希（唯一前缀即可）', true);
    const cliArgs = ['recall', hash];
    if (args?.full) cliArgs.push('--full');
    if (args?.grep) cliArgs.push('--grep', String(args.grep));
    const r = await runRtk(cliArgs, { timeoutMs: 30000 });
    if (!r.ok) return textResult(r.text || '读取失败', true);
    // 上限 1 MiB，超出截断标注（避免超大全文撑爆页面与传输）
    const MAX = 1024 * 1024;
    const truncated = r.text.length > MAX;
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { hash, text: truncated ? r.text.slice(0, MAX) : r.text, truncated },
    };
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
      const file = path.join(PLUGIN_ROOT, 'dist', 'panel.html');
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

// 异步调用计数：stdin 关闭后等在飞请求完成再退出
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
