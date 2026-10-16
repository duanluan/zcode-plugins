#!/usr/bin/env node
// zcode-vision MCP server：暴露 vision_ask 工具，让主模型在对话中对已注入过的原图做定向追问。
// 背景：钩子注入的识别文字是一次性快照，主模型想追问细节（"报错完整原文是什么""右下角那个按钮"）
// 时可调本工具，由视觉链对原图再回答一次。图片完整路径已随 [zcode-vision] 注入文本给出。
// 协议：stdio 上的 MCP（JSON-RPC 2.0，按行分隔）；共享逻辑在 vision-lib.mjs。
// 入口包装 hooks/vision-mcp.sh 负责定位 node（桌面环境 PATH 不含用户级 node）。
// UI Plugin（ZCode ≥ 3.15.1 桌面端）：vision_ask 结果附 _meta.ui 指向内嵌卡片页面
// （ui://zcode-vision/panel.html），并给出结构化副本；文本输出保持不变（ADR-0003）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askImage, loadConfig } from './vision-lib.mjs';

const SERVER_INFO = { name: 'zcode-vision', version: '1.1.0' };
const PROTOCOL_VERSION = '2024-11-05';
const PANEL_URI = 'ui://zcode-vision/panel.html';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOLS = [
  {
    name: 'vision_ask',
    description:
      '用视觉模型识别任意本地图片并回答问题。两类用途：① 识别描述缺细节时对 [zcode-vision] 注入文本中的图片定向追问；' +
      '② 识别任何本地图片文件——浏览文档/网页源码时遇到图片引用、拿到图表文件路径等，自己看不了图（Read 只返回占位符）的场景，' +
      '传路径让本工具代看。question 可以是针对性问题，也可以是「请完整识别这张图片的全部内容」这类总览请求。同一图片同一问题有缓存。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '本地图片文件的完整路径（png/jpg/gif/webp 等；可来自 [zcode-vision] 注入文本、文档中的图片引用、任意文件路径）' },
        question: { type: 'string', description: '针对这张图片的问题或要求（如"顶部报错的完整原文是什么"、"请完整识别这张图片的全部内容"）' },
      },
      required: ['image_path', 'question'],
    },
    _meta: {
      ui: {
        resourceUri: PANEL_URI,
        visibility: ['model', 'app'],
      },
    },
  },
  {
    name: 'vision_image_data',
    description: '读取本地图片为 data URL，供卡片页面显示（只给页面用）。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '本地图片文件的完整路径' },
      },
      required: ['image_path'],
    },
    _meta: { ui: { visibility: ['app'] } },
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: 'vision 图片卡片', mimeType: 'text/html;profile=mcp-app', description: '显示被识别的图片与问答，支持框选区域引用到对话' },
];

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleCall(name, args) {
  if (name === 'vision_ask') {
    const file = String(args?.image_path || '').trim();
    const question = String(args?.question || '').trim();
    if (!file || !question) return { content: [{ type: 'text', text: 'image_path 与 question 均必填' }], isError: true };
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return { content: [{ type: 'text', text: `图片不存在：${file}（路径来自注入文本；若会话已久图可能已被清理，请用户重发图片）` }], isError: true };
    }
    const cfg = loadConfig();
    const { desc, used, cached } = await askImage(cfg, file, question);
    // 文本输出保持不变（模型与旧客户端读它）；structuredContent 是内嵌卡片页面的数据副本（ADR-0003）
    return {
      content: [{ type: 'text', text: `[vision_ask · ${used}${cached ? ' · 缓存命中' : ''}] ${desc}` }],
      structuredContent: { image_path: file, question, desc, used, cached },
    };
  }
  if (name === 'vision_image_data') {
    const file = String(args?.image_path || '').trim();
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return { content: [{ type: 'text', text: `图片不存在：${file}` }], isError: true };
    }
    const stat = fs.statSync(file);
    if (stat.size > 8 * 1024 * 1024) {
      return { content: [{ type: 'text', text: `图片超过 8 MiB（${Math.round(stat.size / 1048576)} MiB），页面不加载` }], isError: true };
    }
    const mime = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
    const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: { dataUrl } };
  }
  return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
}

async function dispatch(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      return rpcResult(id, await handleCall(msg.params?.name, msg.params?.arguments));
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: `追问失败：${e?.message || e}` }], isError: true });
    }
  }
  if (method === 'resources/list') return rpcResult(id, { resources: RESOURCES });
  if (method === 'resources/read') {
    const uri = String(msg.params?.uri || '');
    if (uri === PANEL_URI) {
      const file = path.join(PLUGIN_ROOT, 'dist', 'panel.html');
      try {
        return rpcResult(id, {
          contents: [{ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: fs.readFileSync(file, 'utf8') }],
        });
      } catch (e) {
        return rpcError(id, -32002, `页面资源读取失败：${e?.message || e}`);
      }
    }
    return rpcError(id, -32002, `未知资源：${uri}`);
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
