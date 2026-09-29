#!/usr/bin/env node
// zcode-vision MCP server：暴露 vision_ask 工具，让主模型在对话中对已注入过的原图做定向追问。
// 背景：钩子注入的识别文字是一次性快照，主模型想追问细节（"报错完整原文是什么""右下角那个按钮"）
// 时可调本工具，由视觉链对原图再回答一次。图片完整路径已随 [zcode-vision] 注入文本给出。
// 协议：stdio 上的 MCP（JSON-RPC 2.0，按行分隔）；共享逻辑在 vision-lib.mjs。
// 入口包装 hooks/vision-mcp.sh 负责定位 node（桌面环境 PATH 不含用户级 node）。

import fs from 'node:fs';
import { askImage, loadConfig } from './vision-lib.mjs';

const SERVER_INFO = { name: 'zcode-vision', version: '1.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'vision_ask',
    description:
      '对一张图片追问细节。输入图片的完整路径（来自 [zcode-vision] 注入文本中的 [图N · 路径]）和一个具体问题，' +
      '由视觉模型对原图定向回答。适用于：识别描述中缺失的细节（如报错完整原文、局部文字、小字号内容、图表数值等）。' +
      '同一图片同一问题有缓存，不会重复调用。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '图片文件的完整路径（[zcode-vision] 注入文本 [图N · …] 中给出的路径）' },
        question: { type: 'string', description: '针对这张图片的具体问题（如"顶部报错的完整原文是什么"' },
      },
      required: ['image_path', 'question'],
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleCall(name, args) {
  if (name !== 'vision_ask') return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  const file = String(args?.image_path || '').trim();
  const question = String(args?.question || '').trim();
  if (!file || !question) return { content: [{ type: 'text', text: 'image_path 与 question 均必填' }], isError: true };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return { content: [{ type: 'text', text: `图片不存在：${file}（路径来自注入文本；若会话已久图可能已被清理，请用户重发图片）` }], isError: true };
  }
  const cfg = loadConfig();
  const { desc, used, cached } = await askImage(cfg, file, question);
  return { content: [{ type: 'text', text: `[vision_ask · ${used}${cached ? ' · 缓存命中' : ''}] ${desc}` }] };
}

async function dispatch(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      return rpcResult(id, await handleCall(msg.params?.name, msg.params?.arguments));
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: `追问失败：${e?.message || e}` }], isError: true });
    }
  }
  if (method === 'ping') return rpcResult(id, {});
  // notifications（initialized/cancelled 等）无 id，不需回应
  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `method not found: ${method}`);
}

// 请求处理中/输入已结束的计数：追问是异步的，stdin 关闭后要等在飞的调用完成再退出
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
