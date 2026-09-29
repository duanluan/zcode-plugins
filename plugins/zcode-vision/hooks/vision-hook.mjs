#!/usr/bin/env node
// zcode-vision UserPromptSubmit 钩子：主模型收不到图片时（例如 glm-5.3 不支持图片输入），
// 把本轮消息里的图片交给可配置的视觉代理链识别（默认用 GLM 订阅 key 直连 glm-5.3-flash，
// 不跟随会话供应商；代理可设 useProvider 跟随当前会话供应商或指定供应商），
// 识别文字以 additionalContext 注入本轮对话。识别不改写消息、不阻断，失败只在注入文本里说明。
//
// 直接运行（/vision test 用）：
//   node vision-hook.mjs --test [图片路径]     # 不给路径则取最近会话目录里最新的一张图
//
// 约定：
// - 钩子拿不到会话所用模型，无法只在「主模型不支持图片」时触发；有图片附件即识别注入。
// - 配置唯一事实来源 ~/.zcode/zcode-vision.json（/vision-* 命令与 zcode-pro 面板编辑同一文件）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.zcode', 'zcode-vision.json');
const CACHE_PATH = path.join(HOME, '.zcode', 'zcode-vision-cache.json');
const LOG_PATH = path.join(HOME, '.zcode-vision.log');
const IMAGE_CACHE_ROOT = path.join(HOME, '.zcode', 'cli', 'image-cache');

const DEFAULT_PROMPT =
  '请详细描述这张图片的全部内容；若是界面或图表截图，请说明布局、文字与关键数据。';
// 默认走 GLM 订阅（coding plan）的 Anthropic 兼容端点：与主模型同一供应商同一 key 来源，
// 无需标准 API 余额。format: "anthropic"=Anthropic Messages；"openai"=OpenAI Chat Completions。
const DEFAULT_CONFIG = {
  enabled: true,
  chainMode: 'fallback', // fallback=依次尝试到成功为止；pipeline=逐级加工（描述→校对→提炼）
  chain: ['glm-flash'],
  proxies: [
    {
      name: 'glm-flash',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.3-flash',
      apiKey: '', // 留空依次尝试：环境变量 GLM_API_KEY → ~/.zcode/v2/config.json 里 bigmodel 供应商的 key
      format: 'anthropic',
      prompt: DEFAULT_PROMPT,
    },
  ],
  pollMs: 3000, // 等内联图片落盘的最长时间
  apiTimeoutMs: 60000, // 单次视觉调用超时
};
// 钩子总超时 180s（hooks.json），留 15s 余量自行收尾，避免被强杀后一点输出都没有
const OVERALL_DEADLINE_MS = 165000;
const MAX_CACHE_ENTRIES = 200;

function log(msg) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 512 * 1024) {
      fs.unlinkSync(LOG_PATH);
    }
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} [zcode-vision] ${msg}\n`,
    );
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function loadConfig() {
  const onDisk = readJson(CONFIG_PATH);
  if (!onDisk) {
    // 首跑生成模板（含默认 GLM 代理），用户可用 /vision-setup 或 zcode-pro 面板修改
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      atomicWrite(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    } catch (e) {
      log(`写入配置模板失败：${e.message}`);
    }
    return { ...DEFAULT_CONFIG };
  }
  // 浅合并：文件里没写的键用默认值，proxies/chain 完全以文件为准
  return { ...DEFAULT_CONFIG, ...onDisk };
}

// API key 解析：代理显式值 → 环境变量 → ~/.zcode/v2/config.json 的 bigmodel 供应商 key
function resolveApiKey(proxy) {
  if (proxy.apiKey && proxy.apiKey.trim()) return proxy.apiKey.trim();
  for (const env of ['GLM_API_KEY', 'ZAI_API_KEY', 'VISION_API_KEY']) {
    const v = process.env[env];
    if (v && v.trim()) return v.trim();
  }
  try {
    const v2 = readJson(path.join(HOME, '.zcode', 'v2', 'config.json'));
    const providers = v2 && typeof v2.provider === 'object' ? v2.provider : {};
    const order = Object.keys(providers).sort((a, b) => {
      const rank = (id) =>
        id === 'builtin:bigmodel-coding-plan' ? 0 : id.includes('bigmodel') ? 1 : 2;
      return rank(a) - rank(b);
    });
    for (const id of order) {
      if (!id.includes('bigmodel')) break;
      const key = providers[id]?.options?.apiKey;
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
  } catch {
    /* 尽力而为 */
  }
  return '';
}

function completionsUrl(baseUrl) {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  if (u.endsWith('/chat/completions')) return u;
  return `${u}/chat/completions`;
}

// —— 供应商跟随：useProvider = "session"（当前会话所用供应商）或供应商名/ID ——
// 供应商定义在 ~/.zcode/v2/config.json 的 provider.<id>（name / kind / options.baseURL / options.apiKey）；
// 「当前会话所用供应商」从 tasks-index.sqlite 的 tasks.model 列（格式 "<providerId>/<modelId>"）按 task_id 查得。
// 会话 → 供应商：tasks.model 列格式 "<providerId>/<modelId>"。
// sessionId 为空（/vision test 无会话上下文）时取最近一个会话的供应商，让测试模式可用。
function sessionProviderId(sessionId) {
  const db = path.join(HOME, '.zcode', 'v2', 'tasks-index.sqlite');
  if (!fs.existsSync(db)) return null;
  const modelOf = (raw) => (raw && String(raw).includes('/') ? String(raw).split('/')[0] : null);
  try {
    // 优先 node:sqlite（Node ≥22.5）；不可用或库被占用时退回 sqlite3 CLI
    try {
      const { DatabaseSync } = require_('node:sqlite');
      const d = new DatabaseSync(db, { readOnly: true });
      const row = sessionId
        ? d.prepare('SELECT model FROM tasks WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1').get(sessionId)
        : d.prepare('SELECT model FROM tasks ORDER BY updated_at DESC LIMIT 1').get();
      d.close();
      return modelOf(row?.model);
    } catch { /* fall through */ }
    // CLI 回退：sessionId 内插进 SQL，先做白名单校验防注入（宿主生成的 id 形如 sess_<uuid>）
    if (sessionId && !/^[\w-]+$/.test(sessionId)) return null;
    const where = sessionId ? `WHERE task_id='${sessionId}' ` : '';
    const out = require_('node:child_process').execFileSync(
      'sqlite3',
      [db, `SELECT model FROM tasks ${where}ORDER BY updated_at DESC LIMIT 1;`],
      { encoding: 'utf8', timeout: 5000 },
    );
    return modelOf(out.trim());
  } catch {
    return null;
  }
}

// 把 useProvider 引用解析为该供应商的 baseUrl/apiKey/格式；解析失败抛错（带原因）。
// 供应商来源两张表：~/.zcode/v2/config.json 的 provider.<id>（优先）与
// ~/.zcode/v2/provider_config.json 的 providerRules（桌面端「新供应商」向导写这里，id 形如 new-provider）。
function providerTables() {
  const list = [];
  const byId = new Map();
  const v2 = readJson(path.join(HOME, '.zcode', 'v2', 'config.json')) || {};
  for (const [id, p] of Object.entries((v2 && typeof v2.provider === 'object' ? v2.provider : {}) || {})) {
    const entry = { id, name: p?.name || id, aliases: [], kind: p?.kind, baseURL: p?.options?.baseURL, apiKey: p?.options?.apiKey };
    list.push(entry);
    byId.set(id, entry);
  }
  const rules =
    readJson(path.join(HOME, '.zcode', 'v2', 'provider_config.json'))?.config?.providerConfigRules?.providerRules || [];
  for (const r of rules) {
    if (!r?.providerId) continue;
    // 同一 id 两张表都有（如 config.json 叫 BigModel、规则表叫 BigModel-Max1）：
    // 合并为一条（config.json 的连接信息优先），规则表里的名字保留为别名，按名引用也能找到
    const existing = byId.get(r.providerId);
    if (existing) {
      const alias = r.providerName || r.providerId;
      if (alias && alias !== existing.name && !existing.aliases.includes(alias)) existing.aliases.push(alias);
      continue;
    }
    const entry = {
      id: r.providerId,
      name: r.providerName || r.providerId,
      aliases: [],
      kind: r.config?.api?.type, // anthropic-messages / openai-responses / …
      baseURL: r.config?.api?.baseUrl,
      apiKey: r.config?.access?.apiKey,
    };
    list.push(entry);
    byId.set(r.providerId, entry);
  }
  return list;
}

function resolveProviderRef(ref, sessionId) {
  const providers = providerTables();
  const label = (p) => `${p.name}（${p.id}）`;
  let hit = null;
  if (ref === 'session') {
    const id = sessionProviderId(sessionId);
    hit = id ? providers.find((p) => p.id === id) : null;
    if (!hit) {
      const names = providers.map(label).join('、');
      throw new Error(`未能定位会话所用的供应商（任务索引无记录或供应商不存在；/vision test 模式取最近会话）；可用供应商：${names || '无'}`);
    }
  } else {
    // 两趟匹配：先按 id 精确（避免被列表靠前的同名条目抢占），再按名称/别名
    hit = providers.find((p) => p.id === ref)
      || providers.find((p) => p.name === ref || (p.aliases || []).includes(ref));
    if (!hit) {
      const names = providers.map(label).join('、');
      throw new Error(`未找到供应商「${ref}」；可用供应商：${names || '无'}`);
    }
  }
  const kind = String(hit.kind || '');
  const isAnthropic = kind === 'anthropic' || kind === 'anthropic-messages';
  if (!isAnthropic && kind.includes('responses')) {
    throw new Error(`供应商 ${label(hit)} 是 ${kind} 格式，视觉代理暂不支持（需 anthropic 或 OpenAI Chat Completions 兼容）`);
  }
  if (!kind) throw new Error(`供应商 ${label(hit)} 缺少格式信息，无法判断请求格式`);
  if (!hit.baseURL) throw new Error(`供应商 ${label(hit)} 未配置 baseURL`);
  if (!hit.apiKey || !String(hit.apiKey).trim()) throw new Error(`供应商 ${label(hit)} 未配置 API key`);
  return {
    baseUrl: String(hit.baseURL),
    apiKey: String(hit.apiKey).trim(),
    format: isAnthropic ? 'anthropic' : 'openai',
    providerName: hit.name,
  };
}

// 展开代理链：useProvider 解析成实际 baseUrl/apiKey/format；解析失败记入 proxy.__resolveError（调用时报给用户）
function resolveChainProxies(cfg, sessionId) {
  return (cfg.chain || [])
    .map((name) => {
      const proxy = (cfg.proxies || []).find((p) => p.name === name);
      if (!proxy) return { name, __missing: true };
      if (!proxy.useProvider) return { ...proxy };
      try {
        const r = resolveProviderRef(proxy.useProvider, sessionId);
        return { ...proxy, baseUrl: r.baseUrl, apiKey: r.apiKey, format: r.format, __provider: r.providerName };
      } catch (e) {
        return { ...proxy, __resolveError: e.message };
      }
    });
}

function messagesUrl(baseUrl) {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  if (u.endsWith('/messages')) return u;
  if (u.endsWith('/v1')) return `${u}/messages`;
  return `${u}/v1/messages`;
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

function sniffMime(buf, file) {
  if (buf.length > 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  }
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
}

async function callProxy(proxy, { imageB64, mime, text }) {
  const apiKey = resolveApiKey(proxy);
  if (!apiKey) throw new Error('无可用 API key（可在配置或 /vision-setup 里设置）');
  const prompt = text || proxy.prompt || DEFAULT_PROMPT;
  const anthropic = (proxy.format || 'openai') === 'anthropic';
  const url = anthropic ? messagesUrl(proxy.baseUrl) : completionsUrl(proxy.baseUrl);
  const headers = anthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const content = imageB64
    ? anthropic
      ? [
          { type: 'image', source: { type: 'base64', media_type: mime, data: imageB64 } },
          { type: 'text', text: prompt },
        ]
      : [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } },
          { type: 'text', text: prompt },
        ]
    : anthropic
      ? [{ type: 'text', text: prompt }]
      : prompt;
  const body = anthropic
    ? { model: proxy.model, max_tokens: 4096, messages: [{ role: 'user', content }] }
    : { model: proxy.model, messages: [{ role: 'user', content }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), apiTimeoutMsOf());
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    // Anthropic 返回 content 数组（可能含 thinking 块，只取 text）；OpenAI 返回 choices[0].message.content
    let desc;
    if (anthropic) {
      desc = (Array.isArray(data?.content) ? data.content : [])
        .filter((p) => p?.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim();
    } else {
      const msg = data?.choices?.[0]?.message?.content;
      desc = Array.isArray(msg)
        ? msg.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim()
        : typeof msg === 'string'
          ? msg.trim()
          : '';
    }
    if (!desc) throw new Error('模型返回空内容');
    return desc;
  } finally {
    clearTimeout(timer);
  }
}

let cfgRef = null;
function apiTimeoutMsOf() {
  return Number(cfgRef?.apiTimeoutMs) > 0 ? Number(cfgRef.apiTimeoutMs) : DEFAULT_CONFIG.apiTimeoutMs;
}

function chainFingerprint(chainProxies) {
  const used = (chainProxies || [])
    .filter((p) => p && !p.__missing && !p.__resolveError)
    .map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model, format: p.format || 'openai', prompt: p.prompt || '' }));
  return createHash('sha256').update(JSON.stringify(used)).digest('hex');
}

function loadCache() {
  const c = readJson(CACHE_PATH);
  return c && typeof c.entries === 'object' ? c : { version: 1, entries: {} };
}

function saveCache(cache) {
  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys
      .sort((a, b) => (cache.entries[a].at || 0) - (cache.entries[b].at || 0))
      .slice(0, keys.length - MAX_CACHE_ENTRIES)
      .forEach((k) => delete cache.entries[k]);
  }
  try {
    atomicWrite(CACHE_PATH, JSON.stringify(cache));
  } catch (e) {
    log(`写缓存失败：${e.message}`);
  }
}

async function runChain(cfg, chainProxies, imageBuf, mime) {
  const errors = [];
  const usedLabel = (p) => (p.__provider ? `${p.name}·${p.__provider}` : p.name);
  if (cfg.chainMode === 'pipeline') {
    let prev = '';
    let lastName = '';
    for (const proxy of chainProxies) {
      if (proxy.__missing) {
        errors.push(`链中代理「${proxy.name}」未定义`);
        continue;
      }
      if (proxy.__resolveError) {
        errors.push(`${proxy.name}: ${proxy.__resolveError}`);
        return { desc: '', used: lastName, errors };
      }
      const prompt = proxy.prompt || DEFAULT_PROMPT;
      const useImage = !prev; // 第一步带图；后续步纯文本加工
      const finalPrompt = prompt.includes('{prev}') ? prompt.replaceAll('{prev}', prev) : prev ? `${prompt}\n\n${prev}` : prompt;
      try {
        prev = await callProxy({ ...proxy, prompt: finalPrompt }, useImage ? { imageB64: imageBuf.toString('base64'), mime } : {});
        lastName = usedLabel(proxy);
      } catch (e) {
        errors.push(`${proxy.name}: ${e.message}`);
        return { desc: '', used: lastName, errors };
      }
    }
    return { desc: prev, used: lastName, errors };
  }
  // fallback：依次尝试到成功为止
  for (const proxy of chainProxies) {
    if (proxy.__missing) {
      errors.push(`链中代理「${proxy.name}」未定义`);
      continue;
    }
    if (proxy.__resolveError) {
      errors.push(`${proxy.name}: ${proxy.__resolveError}`);
      continue;
    }
    try {
      const desc = await callProxy(proxy, { imageB64: imageBuf.toString('base64'), mime });
      return { desc, used: usedLabel(proxy), errors };
    } catch (e) {
      errors.push(`${proxy.name}: ${e.message}`);
    }
  }
  return { desc: '', used: '', errors };
}

// 解析 attachmentsSummary：实测真实格式有三种值（ZCode 侧 summarizeTurnAttachments 生成）：
//   "1:image:/abs/path.png"  拖拽/按路径附加 → 直接读
//   "1:image:inline:123 chars"（推断的旧格式）→ 轮询 image-cache
//   "1:image:image.png"     粘贴图片（只给显示文件名，实际落盘在 image-cache）→ 轮询 image-cache
function parseImageAttachments(summary) {
  const paths = [];
  let cacheCount = 0;
  if (typeof summary === 'string' && summary.includes(':image:')) {
    for (const m of summary.matchAll(/(\d+):image:(\/[^\s,]+|inline:\d+[^\s,]*|[^\s,]+)/g)) {
      const v = m[2];
      if (v.startsWith('/')) paths.push(v);
      else cacheCount += 1; // inline 或裸文件名：图片本体都在会话 image-cache 目录里
    }
  }
  return { paths: [...new Set(paths)], cacheCount };
}

// 内联图片已物化到 ~/.zcode/cli/image-cache/<session_id>/（image-<hash>.png）。
// 钩子触发可能早于落盘，轮询等新文件；没等到则退回目录里最新的一张（同一张图重发的情形）。
function collectInlineImages(sessionId, pollMs) {
  const dir = path.join(IMAGE_CACHE_ROOT, sessionId || '');
  if (!sessionId || !fs.existsSync(dir)) return [];
  const listFiles = () => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /^image-.+\.(png|jpe?g|gif|webp|bmp)$/i.test(f))
        .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
    } catch {
      return [];
    }
  };
  const start = listFiles();
  const startNames = new Set(start.map((e) => e.file));
  const deadline = Date.now() + Math.max(0, Number(pollMs) || 0);
  let current = start;
  while (Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); // 同步 sleep 200ms
    current = listFiles();
    if (current.some((e) => !startNames.has(e.file))) {
      return current.filter((e) => !startNames.has(e.file)).map((e) => e.file);
    }
  }
  if (start.length > 0) {
    const newest = [...current].sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? [newest.file] : [];
  }
  return [];
}

function buildContext(results, models) {
  const ok = results.filter((r) => r.desc);
  const bad = results.filter((r) => !r.desc);
  const lines = [
    `[zcode-vision] 用户本轮发送了 ${results.length} 张图片（钩子无法感知主模型是否支持图片）。` +
      `以下为视觉代理${models.size ? `（${[...models].join(' → ')}）` : ''}生成的识别文字，请当作图片内容使用：`,
    '',
  ];
  results.forEach((r, i) => {
    lines.push(`[图${i + 1} · ${path.basename(r.file)}${r.cached ? ' · 缓存命中' : ''}]`);
    if (r.desc) lines.push(r.desc.trim());
    else lines.push(`（识别失败：${(r.errors || []).join('；') || '未知原因'}——可请用户改用文字描述，或 /vision status 检查配置）`);
    lines.push('');
  });
  if (!ok.length) lines.push('（所有图片均未识别成功；由 zcode-vision 注入，/vision off 可关闭）');
  return { additionalContext: lines.join('\n').trim() };
}

async function main() {
  const started = Date.now();
  // --test 模式：跑通识别链并把结果直接打印给用户
  if (process.argv.includes('--test')) {
    return runTest(process.argv.find((a, i) => i > 1 && !a.startsWith('--')));
  }

  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cfg = loadConfig();
  cfgRef = cfg;
  if (!cfg.enabled) process.exit(0);

  const { paths, cacheCount } = parseImageAttachments(payload.attachmentsSummary);
  if (!paths.length && !cacheCount) process.exit(0);

  const files = [];
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) files.push(p);
    } catch {
      /* 路径失效则忽略 */
    }
  }
  if (cacheCount > 0) files.push(...collectInlineImages(payload.session_id, cfg.pollMs));

  const uniq = [...new Set(files)];
  if (!uniq.length) {
    // 有图片标记却没拿到文件：也要让模型知道有图存在
    const out = {
      additionalContext:
        `[zcode-vision] 检测到 ${cacheCount + paths.length} 个图片附件，但未能定位图片文件（识别跳过）。` +
        '如需图片内容请让用户改用文字描述或重发图片。',
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  const cache = loadCache();
  const chainProxies = resolveChainProxies(cfg, payload.session_id);
  const fp = chainFingerprint(chainProxies);
  const results = [];
  const models = new Set();
  for (const file of uniq) {
    if (Date.now() - started > OVERALL_DEADLINE_MS) {
      results.push({ file, desc: '', errors: ['超出钩子时间预算，本轮跳过'], cached: false });
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      results.push({ file, desc: '', errors: [`读取失败：${e.message}`], cached: false });
      continue;
    }
    const key = createHash('sha256').update(fp).update(buf).digest('hex');
    const hit = cache.entries[key];
    if (hit?.desc) {
      results.push({ file, desc: hit.desc, errors: [], cached: true });
      if (hit.model) models.add(hit.model);
      continue;
    }
    const { desc, used, errors } = await runChain(cfg, chainProxies, buf, sniffMime(buf, file));
    if (desc) {
      cache.entries[key] = { desc, model: used, at: Date.now() };
      models.add(used);
    } else {
      log(`识别失败 ${file}: ${errors.join(' | ')}`);
    }
    results.push({ file, desc, errors, cached: false });
  }
  saveCache(cache);
  process.stdout.write(JSON.stringify(buildContext(results, models)));
  process.exit(0);
}

// ---- /vision test 与 zcode-pro「测试」按钮共用：找一张真实图片跑全链 ----
async function runTest(givenFile) {
  const cfg = loadConfig();
  cfgRef = cfg;
  let file = givenFile;
  if (!file) {
    const sessions = fs
      .readdirSync(IMAGE_CACHE_ROOT)
      .filter((d) => d.startsWith('sess_'))
      .map((d) => path.join(IMAGE_CACHE_ROOT, d))
      .filter((d) => fs.statSync(d).isDirectory());
    const all = sessions.flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => /^image-/.test(f))
        .map((f) => ({ p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })),
    );
    all.sort((a, b) => b.m - a.m);
    file = all[0]?.p;
  }
  if (!file || !fs.existsSync(file)) {
    console.error('未找到可用测试图片（可指定路径：--test <图片路径>）');
    process.exit(1);
  }
  console.error(`测试图片：${file}`);
  console.error(`链：${(cfg.chain || []).join(cfg.chainMode === 'pipeline' ? ' → ' : ' ⤵ 失败则 ')}`);
  const chainProxies = resolveChainProxies(cfg, null);
  const buf = fs.readFileSync(file);
  const t0 = Date.now();
  const { desc, used, errors } = await runChain(cfg, chainProxies, buf, sniffMime(buf, file));
  if (desc) {
    console.error(`成功（${used}，${((Date.now() - t0) / 1000).toFixed(1)}s）：\n${desc}`);
    process.exit(0);
  }
  console.error(`失败：${errors.join(' | ')}`);
  process.exit(1);
}

main().catch((e) => {
  // 钩子模式：任何未捕获异常都不阻断用户消息；--test 模式：明确报错并以失败退出
  log(`未捕获异常：${e?.stack || e}`);
  if (process.argv.includes('--test')) {
    console.error(`测试失败：${e?.message || e}`);
    process.exit(1);
  }
  process.exit(0);
});
