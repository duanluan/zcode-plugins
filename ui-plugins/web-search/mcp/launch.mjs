#!/usr/bin/env node
// web-search 的 MCP 启动器。
//
// 上游 dsh-free-search 的 MCP 路径只认环境变量（没有配置文件入口），而本插件用
// ~/.zcode/web-search.json 管理配置，所以这一层负责把配置文件翻译成环境变量，
// 再用同一个 node 进程拉起上游 bin/mcp.js。
//
// 除了转发，还做一件事：把 web_fetch 抓到的“浏览器错误页”改判为失败。
// 上游用无头浏览器抓取时，只在前 3000 字节里查 403/captcha 就算通过；而 Chrome
// 的错误页正文前面有大段内联样式，neterror 标记实测在 14 万字节之后，于是整页
// 错误页被当成正常内容返回（isError: false）。模型收到错误页会以为抓成功了，
// 继续基于它作答或反复换源重试，白白消耗上下文。
//
// 三个输入来源的优先级：环境变量（用户在 shell 里自己设的）< 配置文件。
// 配置文件里写了的键会覆盖环境变量，这样“改配置文件”就是唯一可信的生效方式。
//
// 没有任何配置时也照常启动：上游的免 key 引擎（Bing、DuckDuckGo）不需要任何设置。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.join(here, '..', 'vendor', 'dsh-free-search', 'bin', 'mcp.js');
const configPath = process.env.WEB_SEARCH_CONFIG || path.join(homedir(), '.zcode', 'web-search.json');

if (!existsSync(upstream)) {
  console.error(`web-search: 找不到上游 MCP 入口 ${upstream}`);
  process.exit(127);
}

const cfg = readConfig(configPath);
const env = { ...process.env, ...translate(cfg) };
// 上游的引擎用全局 fetch，Node 20+ 默认不读 http_proxy/https_proxy；打开这个开关后才跟随
// 环境变量里的代理。用户显式配了 proxy 时直接写进 http_proxy/https_proxy。
env.NODE_USE_ENV_PROXY = '1';

const child = spawn(process.execPath, ['--no-warnings', upstream], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env,
  windowsHide: true,
});

// 请求 id → 工具名，用来判断某个响应是不是 web_fetch 的。只记最近若干条，
// 长时间会话下不会无限增长。
const pending = new Map();
const PENDING_LIMIT = 200;

process.stdin.on('data', (chunk) => {
  // 转发前先按行扫一遍请求，记下“id → 工具名”，响应回来时才知道该不该改写
  recordRequests(chunk);
  try { child.stdin.write(chunk); } catch { /* 子进程已退出 */ }
});
process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* ignore */ } });

// 请求侧也要按行切：一条消息可能跨多个数据块
let reqBuffer = '';
function recordRequests(chunk) {
  reqBuffer += chunk.toString('utf8');
  let idx;
  while ((idx = reqBuffer.indexOf('\n')) >= 0) {
    const line = reqBuffer.slice(0, idx);
    reqBuffer = reqBuffer.slice(idx + 1);
    try { rememberRequest(JSON.parse(line)); } catch { /* 非 JSON 不记 */ }
  }
}

// 上游按行输出 JSON-RPC，一行一条；这里按行切，逐行决定原样转发还是改写。
// 不完整的行留到下一块，避免把一条消息切坏。
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    process.stdout.write(`${rewriteLine(line)}\n`);
  }
});
child.stdout.on('end', () => {
  if (buffer.trim() !== '') process.stdout.write(buffer);
});

child.on('error', (err) => {
  console.error(`web-search: 启动上游失败：${err?.message || err}`);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* 子进程已退出 */ }
  });
}

function rememberRequest(msg) {
  if (!msg || msg.method !== 'tools/call' || msg.id === undefined) return;
  const tool = msg.params?.name;
  if (typeof tool !== 'string') return;
  pending.set(JSON.stringify(msg.id), tool);
  if (pending.size > PENDING_LIMIT) {
    // Map 迭代顺序是插入顺序，删最早的
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
  }
}

function rewriteLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return line;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return line; } // 非 JSON 原样转发

  rememberRequest(msg);

  // 只处理“有 id 且有 result”的响应
  if (msg.id === undefined || msg.result === undefined) return line;
  const key = JSON.stringify(msg.id);
  const tool = pending.get(key);
  if (tool === undefined) return line;
  pending.delete(key);
  if (tool !== 'web_fetch') return line;

  const content = msg.result.content;
  if (!Array.isArray(content)) return line;

  for (const item of content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    const reason = browserErrorPage(item.text);
    if (!reason) continue;
    item.text = `${reason}\n\n（这一页没有拿到内容：目标站点拒绝了本地出口，或站点本身不可达。` +
      `请换其他来源，不要对同一地址重复抓取。）`;
    msg.result.isError = true;
    return JSON.stringify(msg);
  }
  return line;
}

// 识别 Chrome/Edge 无头浏览器的错误页。判据只取错误页独有的标记：
// - class="neterror"：错误页 <body> 的类名，正常页面不会用
// - id="main-frame-error"：错误页最外层容器
// 实测这两个标记在错误页里位于 14 万字节之后（前面是大段内联样式），所以查全文
// 而不是只查开头；正常页面交叉验证过没有出现过这两个字符串。
// 不拿 ERR_ 错误码当判据：正常页面的脚本里也可能出现这类字符串。
function browserErrorPage(text) {
  if (text.length < 500) return '';
  const isChromeError = /class="neterror"/.test(text) || /id="main-frame-error"/.test(text);
  if (!isChromeError) return '';
  const code = text.match(/\bERR_[A-Z_]+/)?.[0] || '';
  return `抓取失败：目标站点返回了浏览器错误页${code ? `（${code}）` : ''}，不是网页内容。`;
}

function readConfig(file) {
  try {
    const text = readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    // 文件不存在是正常情况（免 key 引擎不需要配置）；语法错误要让人看见，否则
    // 用户会以为配置生效了
    if (err?.code !== 'ENOENT') console.error(`web-search: 读取 ${file} 失败：${err?.message || err}`);
    return {};
  }
}

// 配置文件 → 环境变量。字段与上游读取的变量一一对应，键名保持一致，
// 这样上游新增引擎时这一层不用跟着改。
function translate(cfg) {
  const out = {};
  const scalar = {
    engine: 'MCP_SEARCH_ENGINE',
    maxResults: 'MCP_MAX_RESULTS',
    safeSearch: 'MCP_SAFE_SEARCH',
    lang: 'MCP_LANG',
    bingMarket: 'MCP_BING_MARKET',
    browserFetch: 'MCP_BROWSER_FETCH',
    allowFakeIpCidrs: 'MCP_ALLOW_FAKE_IP_CIDRS',
    degoogInstances: 'MCP_DEGOOG_INSTANCES',
    searxngInstances: 'MCP_SEARXNG_INSTANCES',
    searxngBearerToken: 'MCP_SEARXNG_BEARER_TOKEN',
    maxResponseChars: 'MCP_MAX_RESPONSE_CHARS',
    cacheDir: 'RESEARCH_CACHE_DIR',
  };
  for (const [key, name] of Object.entries(scalar)) {
    const value = cfg?.[key];
    if (value === undefined || value === null || value === '') continue;
    out[name] = Array.isArray(value) ? value.join(',') : String(value);
  }

  // keys 直接以环境变量名为键：{ "BRAVE_API_KEY": "...", "GOOGLE_CSE_ID": "..." }。
  // 引擎 → 变量名的对应表在上游，这一层不重复维护。
  for (const [name, value] of Object.entries(cfg?.keys || {})) {
    if (typeof value === 'string' && value.trim() !== '') out[name] = value.trim();
  }

  if (typeof cfg?.proxy === 'string' && cfg.proxy.trim() !== '') {
    out.http_proxy = cfg.proxy.trim();
    out.https_proxy = cfg.proxy.trim();
  }
  return out;
}
