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
import { askImage, cardHeartbeat, cardUiAllowed, loadConfig, log, readSandboxRegistry, writeSandboxRegistry } from './vision-lib.mjs';

const SERVER_INFO = { name: 'zcode-vision', version: '1.1.0' };
const PROTOCOL_VERSION = '2024-11-05';
const PANEL_URI = 'ui://zcode-vision/panel.html';
const VISION_ASK_META = { ui: { resourceUri: PANEL_URI, visibility: ['model', 'app'] } }; // 原始挂卡配置（tools/list 动态摘挂的基准）
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
    _meta: VISION_ASK_META,
  },
  {
    name: 'vision_card_heartbeat',
    description: '识图卡片页面的沙箱名额心跳（插件内部使用）：上报本卡片沙箱仍活跃，领回闲置释放时长与超预算淘汰指令。模型无需调用。',
    inputSchema: {
      type: 'object',
      properties: {
        sandboxId: { type: 'string', description: '页面自造的随机标识（每张卡片一个，注册表只要求活着且可区分）' },
      },
      required: ['sandboxId'],
    },
    _meta: { ui: { visibility: ['app'] } },
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
  { uri: PANEL_URI, name: 'vision 图片卡片', mimeType: 'text/html;profile=mcp-app', description: '显示被识别的图片与问答（图片默认收起，点“显示图片”展开查看；追问直接在对话里提）' },
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
    // 机器可读的调用记录：钩子靠它在下一轮判断“模型已按要求识别”（跟踪追击）
    log(`ASK:OK ${file}`);
    // 文本输出保持不变（模型与旧客户端读它）；structuredContent 是内嵌卡片页面的数据副本（ADR-0003）
    return {
      content: [{ type: 'text', text: `[vision_ask · ${used}${cached ? ' · 缓存命中' : ''}] ${desc}` }],
      structuredContent: { image_path: file, question, desc, used, cached },
    };
  }
  if (name === 'vision_card_heartbeat') {
    const sandboxId = String(args?.sandboxId || '').trim();
    if (!sandboxId) return { content: [{ type: 'text', text: 'sandboxId 必填' }], isError: true };
    const reg = readSandboxRegistry();
    const verdict = cardHeartbeat(reg, sandboxId);
    writeSandboxRegistry(reg);
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: verdict };
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
  if (method === 'tools/list') {
    // 名额预算：活卡数达到预算时，vision_ask 不再挂卡片（无 _meta.ui → 新结果按纯文本
    // 展示，与旧客户端一致）。宿主沙箱全局上限 64，页面侧没有安全的单卡释放通道，
    // 只能在入口少挂，绝不碰运行时（request-teardown 会拆掉整个插件 UI）
    const cfg = loadConfig();
    const reg = readSandboxRegistry();
    const { live, allowed } = cardUiAllowed(reg, cfg);
    const visionAsk = TOOLS.find((t) => t.name === 'vision_ask');
    // 每次从留存的原始 _meta 取值再决定挂不挂：直接改 visionAsk._meta 会把摘除态
    // 固化，名额空出后恢复不回来
    // cardUi=false（总开关关）或名额满：不挂卡片，结果按纯文本展示。
    // 响应用拷贝构造（不改共享 TOOLS）：同批多条请求先后同步改写共享对象的话，
    // 先到的响应序列化时会带上后到的摘挂状态；拷贝彻底消除这一撕裂窗口
    const attach = allowed && cfg.cardUi !== false;
    if (!attach) log(cfg.cardUi === false ? 'cardUi=false：vision_ask 不挂卡片（纯文本）' : `识图卡片名额已满（活 ${live} ≥ 预算），vision_ask 暂挂纯文本`);
    return rpcResult(id, {
      tools: TOOLS.map((t) => t.name === 'vision_ask'
        ? { ...t, _meta: attach ? VISION_ASK_META : { ui: { visibility: ['model'] } } }
        : t),
    });
  }
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
    // .catch 必须有：任何未捕获 rejection 在 Node ≥15 会直接杀进程——实测表现为
    // 服务反复消失、会话中途丢工具（vision 卡"用不了"的根因之一）
    void dispatch(msg).then((resp) => {
      if (resp) process.stdout.write(`${JSON.stringify(resp)}\n`);
    }).catch((e) => {
      log(`dispatch 未捕获：${e?.stack || e}`);
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

// 兜底：任何漏网的未捕获异常/rejection 记日志后保活，不杀进程
process.on('uncaughtException', (e) => { log(`未捕获异常：${e?.stack || e}`); });
process.on('unhandledRejection', (e) => { log(`未处理 rejection：${e?.stack || e}`); });
