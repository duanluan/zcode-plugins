// zcode-vision 共享库：配置、供应商解析、视觉调用、链执行、缓存。
// 使用方：hooks/vision-hook.mjs（UserPromptSubmit 钩子与 --test）、hooks/vision-mcp.mjs（vision_ask 追问工具）。
// 修改此处需同时跑 /tmp/vision-test/run.mjs 回归。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
export const HOME = os.homedir();
export const CONFIG_PATH = path.join(HOME, '.zcode', 'zcode-vision.json');
export const CACHE_PATH = path.join(HOME, '.zcode', 'zcode-vision-cache.json');
export const LOG_PATH = path.join(HOME, '.zcode-vision.log');
export const IMAGE_CACHE_ROOT = path.join(HOME, '.zcode', 'cli', 'image-cache');

export const DEFAULT_PROMPT =
  '请详细描述这张图片的全部内容。若是界面或图表截图，请先把所有错误、警告、异常状态逐字引用出来（含完整原文），再描述整体布局、文字与关键数据。';
// 默认走 GLM 订阅（coding plan）的 Anthropic 兼容端点：用订阅 key 直连，
// 无需标准 API 余额。format: "anthropic"=Anthropic Messages；"openai"=OpenAI Chat Completions。
export const DEFAULT_CONFIG = {
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
  compressThresholdKB: 1024, // 超过该大小的图先压缩再识别（最长边固定 2000、JPEG85）；0 = 不压缩
};
export const MAX_CACHE_ENTRIES = 200;

export function log(msg) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 512 * 1024) {
      fs.unlinkSync(LOG_PATH);
    }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [zcode-vision] ${msg}\n`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function loadConfig() {
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

export function completionsUrl(baseUrl) {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  if (u.endsWith('/chat/completions')) return u;
  return `${u}/chat/completions`;
}

export function messagesUrl(baseUrl) {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  if (u.endsWith('/messages')) return u;
  if (u.endsWith('/v1')) return `${u}/messages`;
  return `${u}/v1/messages`;
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

export function sniffMime(buf, file) {
  if (buf.length > 12) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    if (buf.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  }
  return MIME_BY_EXT[path.extname(file).toLowerCase()] || 'image/png';
}

// 单次视觉调用。cfg 提供超时（apiTimeoutMs）；追问场景 prompt 由调用方给。
export async function callProxy(proxy, { imageB64, mime, text }, cfg) {
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
  const timeoutMs = Number(cfg?.apiTimeoutMs) > 0 ? Number(cfg.apiTimeoutMs) : DEFAULT_CONFIG.apiTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

// —— 供应商跟随：useProvider = "session"（当前会话所用供应商）或供应商名/ID ——

// 会话 → 供应商：tasks.model 列格式 "<providerId>/<modelId>"。
// sessionId 为空（/vision test 与 MCP 追问无会话上下文）时取最近一个会话的供应商。
export function sessionProviderId(sessionId) {
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

// 供应商来源两张表：~/.zcode/v2/config.json 的 provider.<id>（优先）与
// ~/.zcode/v2/provider_config.json 的 providerRules（桌面端「新供应商」向导写这里，id 形如 new-provider）。
export function providerTables() {
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

// 把 useProvider 引用解析为该供应商的 baseUrl/apiKey/格式；解析失败抛错（带原因）。
export function resolveProviderRef(ref, sessionId) {
  const providers = providerTables();
  const label = (p) => `${p.name}（${p.id}）`;
  let hit = null;
  if (ref === 'session') {
    const id = sessionProviderId(sessionId);
    hit = id ? providers.find((p) => p.id === id) : null;
    if (!hit) {
      const names = providers.map(label).join('、');
      throw new Error(`未能定位会话所用的供应商（任务索引无记录或供应商不存在；无会话上下文时取最近会话）；可用供应商：${names || '无'}`);
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

// 展开代理链：useProvider 解析成实际 baseUrl/apiKey/format；解析失败记入 __resolveError（调用时报给用户）
export function resolveChainProxies(cfg, sessionId) {
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

export function chainFingerprint(chainProxies) {
  const used = (chainProxies || [])
    .filter((p) => p && !p.__missing && !p.__resolveError)
    .map((p) => ({ name: p.name, baseUrl: p.baseUrl, model: p.model, format: p.format || 'openai', prompt: p.prompt || '' }));
  return createHash('sha256').update(JSON.stringify(used)).digest('hex');
}

export function loadCache() {
  const c = readJson(CACHE_PATH);
  return c && typeof c.entries === 'object' ? c : { version: 1, entries: {} };
}

export function saveCache(cache) {
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

export async function runChain(cfg, chainProxies, imageBuf, mime) {
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
        prev = await callProxy({ ...proxy, prompt: finalPrompt }, useImage ? { imageB64: imageBuf.toString('base64'), mime } : {}, cfg);
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
      const desc = await callProxy(proxy, { imageB64: imageBuf.toString('base64'), mime }, cfg);
      return { desc, used: usedLabel(proxy), errors };
    } catch (e) {
      errors.push(`${proxy.name}: ${e.message}`);
    }
  }
  return { desc: '', used: '', errors };
}

// 追问：对指定图片回答一个针对性问题（vision_ask 工具用）。
// 走链的第一个可用代理（追问要快，不跑 pipeline 全链）；结果按「链指纹+图+问题」缓存。
// 压缩阈值：未配置回落默认 1MB；显式 0 = 禁用压缩；其他非法值也回落默认
export function compressThresholdBytesOf(cfg) {
  if (cfg?.compressThresholdKB === undefined) return DEFAULT_CONFIG.compressThresholdKB * 1024;
  const kb = Number(cfg.compressThresholdKB);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : DEFAULT_CONFIG.compressThresholdKB * 1024;
}

export async function askImage(cfg, imageFile, question) {
  const { buf, mime } = await prepareImage(imageFile, compressThresholdBytesOf(cfg));
  const chainProxies = resolveChainProxies(cfg, null);
  const proxy = chainProxies.find((p) => !p.__missing && !p.__resolveError);
  if (!proxy) {
    throw new Error(`链中无可用代理：${chainProxies.map((p) => p.__resolveError || `${p.name} 未定义`).join('；')}`);
  }
  const fp = chainFingerprint(chainProxies);
  const cache = loadCache();
  const key = createHash('sha256').update(fp).update(buf).update(`\nQ:${question}`).digest('hex');
  const hit = cache.entries[key];
  if (hit?.desc) return { desc: hit.desc, used: hit.model || proxy.name, cached: true };
  const desc = await callProxy({ ...proxy, prompt: question }, { imageB64: buf.toString('base64'), mime }, cfg);
  cache.entries[key] = { desc, model: usedLabelOf(proxy), at: Date.now() };
  saveCache(cache);
  return { desc, used: usedLabelOf(proxy), cached: false };
}

// 大图预压缩：视觉上游限制原始图 ≤3.93MB、最长边 2000（超限被拒或被上游再压），
// 且大图 base64/传输/识别都慢（MCP 工具默认 30s 超时容易杀掉结果）。
// 超过阈值（thresholdBytes，默认 1MB，0 = 禁用）的图用 magick 缩到最长边 2000、
// JPEG 质量 85（UI 截图无透明通道，白底合成）；magick 不可用或压缩失败回退原图。返回 { buf, mime }。
export async function prepareImage(imageFile, thresholdBytes = 1024 * 1024) {
  const raw = fs.readFileSync(imageFile);
  if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0 || raw.length <= thresholdBytes) {
    return { buf: raw, mime: sniffMime(raw, imageFile) };
  }
  const tool = await new Promise((resolve) => {
    require_('node:child_process').execFile('sh', ['-c', 'command -v magick || command -v convert'], (err, out) =>
      resolve(!err && out ? out.trim().split('\n').pop() : null));
  });
  if (!tool) return { buf: raw, mime: sniffMime(raw, imageFile) };
  const out = await new Promise((resolve) => {
    const child = require_('node:child_process').execFile(
      tool,
      [imageFile, '-auto-orient', '-resize', '2000x2000>', '-background', 'white', '-alpha', 'remove', '-quality', '85', 'jpg:-'],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => resolve(err || !stdout.length ? null : stdout),
    );
    // magick 杀超时保险
    child.on('error', () => resolve(null));
  });
  return out ? { buf: out, mime: 'image/jpeg' } : { buf: raw, mime: sniffMime(raw, imageFile) };
}

function usedLabelOf(p) {
  return p.__provider ? `${p.name}·${p.__provider}` : p.name;
}
