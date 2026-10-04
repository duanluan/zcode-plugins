// zcode-vision 共享库：配置、供应商解析、视觉调用、链执行、缓存。
// 使用方：hooks/vision-hook.mjs（UserPromptSubmit 钩子与 --test）、hooks/vision-mcp.mjs（vision_ask 追问工具）。
// 修改此处需同时跑回归：node plugins/zcode-vision/test/run.mjs。

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
// 默认两级（chainMode: fallback，依次尝试到成功）：glm-session 跟随当前会话所用供应商
// （识别模型优先用 PREFERRED_VISION_MODELS 映射表）→ glm-flash 用 GLM 订阅（coding plan）
// 的 Anthropic 兼容端点直连兜底，无需标准 API 余额。
// 赠送额度级 trust-build 暂不进默认：ZCode 网关不放行无人值守调用（ADR-0002）；
// 想试可手动加回（useProvider: 'builtin:bigmodel-start-plan'，配 timeoutMs 短超时快速降级）。
// format: "anthropic"=Anthropic Messages；"openai"=OpenAI Chat Completions。
export const DEFAULT_CONFIG = {
  enabled: true,
  chainMode: 'fallback', // fallback=依次尝试到成功为止；pipeline=逐级加工（描述→校对→提炼）
  chain: ['glm-session', 'glm-flash'],
  proxies: [
    {
      // 跟随当前会话所用供应商（任务索引反查 providerId；无会话上下文时取最近会话）。
      // baseUrl/apiKey/format 由该供应商配置自动填充；model 优先用映射表，未命中用本字段
      name: 'glm-session',
      useProvider: 'session',
      model: 'glm-5.3-flash',
      prompt: DEFAULT_PROMPT,
    },
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
  // 单次视觉调用超时（代理可单独用 timeoutMs 覆盖）。实测 MiMo 等视觉上游冷启动 40~105 秒，
  // 60 秒会把慢的那次掐掉导致降级，故默认放宽到 120 秒（钩子总预算 165 秒内兜得住）
  apiTimeoutMs: 120000,
  compressThresholdKB: 1024, // 超过该大小的图先压缩再识别（最长边固定 2000、JPEG85）；0 = 不压缩
  skipAfterFailures: 4, // 连续失败多少次后暂时跳过该代理；0 = 不跳过
  skipMinutes: 30, // 跳过多久后重试；期间任一次成功即清零计数
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

// 历史默认模板（只用于识别「从未自定义过」的旧配置并自动升级）：
// v1 = 单代理 glm-flash 直连（升级为现行默认两级）。v2 两级默认（glm-session → glm-flash）
// 与现行默认一致、无需升级，故不在表内——放进去会让每次加载都触发一次无意义的写盘。
const LEGACY_DEFAULTS = [
  {
    chain: ['glm-flash'],
    proxies: [
      {
        name: 'glm-flash',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        model: 'glm-5.3-flash',
        apiKey: '',
        format: 'anthropic',
        prompt: DEFAULT_PROMPT,
      },
    ],
  },
];

// 键序无关的深比较：面板/命令重写过（键顺序变化）但内容仍是旧默认的配置也能识别为「未自定义」
function deepEqualUnordered(a, b) {
  const canon = (v) =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export function loadConfig() {
  const onDisk = readJson(CONFIG_PATH);
  if (!onDisk) {
    // 首跑生成模板（含默认两级链），用户可用 /vision-setup 或 zcode-pro 面板修改
    try {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      atomicWrite(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    } catch (e) {
      log(`写入配置模板失败：${e.message}`);
    }
    return { ...DEFAULT_CONFIG };
  }
  // 旧默认（chain/proxies 从未改过，且仍为默认 fallback 模式）自动升级为新默认；
  // 用户改过任何一处（换了模型、填了 key、调过链、改过模式）都不动，保持文件为准
  if (
    (onDisk.chainMode || 'fallback') === 'fallback' &&
    LEGACY_DEFAULTS.some((l) => deepEqualUnordered(onDisk.chain, l.chain) && deepEqualUnordered(onDisk.proxies, l.proxies))
  ) {
    const upgraded = { ...DEFAULT_CONFIG, ...onDisk, chain: DEFAULT_CONFIG.chain, proxies: DEFAULT_CONFIG.proxies };
    try {
      atomicWrite(CONFIG_PATH, `${JSON.stringify(upgraded, null, 2)}\n`);
      log('配置为未自定义的旧默认模板，已自动升级为默认两级链：glm-session → glm-flash');
    } catch (e) {
      log(`升级旧默认配置失败：${e.message}`);
    }
    return upgraded;
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

// 调用超时：单代理 timeoutMs 优先（如赠送额度级 10 秒快速失败），否则全局 apiTimeoutMs，再否则默认值
function timeoutOf(proxy, cfg) {
  if (Number(proxy?.timeoutMs) > 0) return Number(proxy.timeoutMs);
  if (Number(cfg?.apiTimeoutMs) > 0) return Number(cfg.apiTimeoutMs);
  return DEFAULT_CONFIG.apiTimeoutMs;
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
  const timeoutMs = timeoutOf(proxy, cfg);
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
  } catch (e) {
    // 定时器掐断的请求在 fetch/json 各阶段都表现为 AbortError，统一翻译成可操作的提示
    const knob = Number(proxy.timeoutMs) > 0 ? 'timeoutMs' : 'apiTimeoutMs';
    if (ctrl.signal.aborted) {
      throw new Error(`识别超时（${Math.round(timeoutMs / 1000)} 秒，${knob}）：可重试或缩短问题；经常超时可调大 ${knob}，或换不经 headroom 的直连代理`);
    }
    throw e;
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
    const entry = { id, name: p?.name || id, aliases: [], kind: p?.kind, baseURL: p?.options?.baseURL, apiKey: p?.options?.apiKey, models: Object.keys(p?.models || {}) };
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
      models: [...new Set([...(r.config?.personalModelIds || []), ...(r.config?.modelOrder || [])])],
    };
    list.push(entry);
    byId.set(r.providerId, entry);
  }
  return list;
}

// api.type（接口类型）缺失时的格式兜底：代理条目下拉框的 format 优先，其次按接口地址
// 推断（路径含 /anthropic 视为 Anthropic 兼容），最后按 openai（与 callProxy 的缺省一致）。
// 模板向导创建的供应商可能不写 api.type（如 Xiaomi MiMo），缺字段不该直接失败。
function formatFromHint(explicit, baseUrl) {
  const f = String(explicit || '').trim().toLowerCase();
  if (f === 'anthropic' || f === 'anthropic-messages') return 'anthropic';
  if (f === 'openai') return 'openai';
  return /\/anthropic(\/|$)/i.test(String(baseUrl || '')) ? 'anthropic' : 'openai';
}

// 首选视觉模型映射表（ADR-0001）：跟随供应商时优先使用的视觉小模型。
// match 对供应商 id/名称/别名做精确或正则匹配；值为该供应商模型列表里的视觉小模型 id。
// 未命中映射的供应商用识别代理条目自己的 model 字段。
export const PREFERRED_VISION_MODELS = [
  { match: [/^xiaomi-mimo$/i, /^Xiaomi MiMo$/i], model: 'mimo-v2.6-flash' },
  { match: [/^builtin:bigmodel-start-plan$/], model: 'GLM-5.3-Flash' }, // Trust Build 家模型 id 是大写
  { match: [/^builtin:(bigmodel|zai)/, /^BigModel/i, /^Z\.ai/i], model: 'glm-5.3-flash' },
];

// 命中映射表 → 返回该供应商模型列表里的精确写法（各家大小写不同，列表未知则原样返回）；
// 列表已知但不含该模型、或未命中映射 → 返回 null（调用方回退代理条目自己的 model）
export function preferredModelOf(hit) {
  const names = [hit.id, hit.name, ...(hit.aliases || [])];
  const rule = PREFERRED_VISION_MODELS.find((r) =>
    r.match.some((m) => names.some((n) => (m instanceof RegExp ? m.test(String(n)) : m === n))),
  );
  if (!rule) return null;
  const list = hit.models || [];
  if (!list.length) return rule.model;
  return list.find((x) => String(x).toLowerCase() === rule.model.toLowerCase()) || null;
}

// 把 useProvider 引用解析为该供应商的 baseUrl/apiKey/格式；解析失败抛错（带原因）。
// fallbackFormat 传代理条目下拉框选的格式，仅在供应商缺 api.type 时使用。
export function resolveProviderRef(ref, sessionId, fallbackFormat) {
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
  if (!hit.baseURL) throw new Error(`供应商 ${label(hit)} 未配置 baseURL`);
  if (!hit.apiKey || !String(hit.apiKey).trim()) throw new Error(`供应商 ${label(hit)} 未配置 API key`);
  if (!kind) log(`供应商 ${label(hit)} 缺 api.type（接口类型），格式改用兜底推断`);
  return {
    baseUrl: String(hit.baseURL),
    apiKey: String(hit.apiKey).trim(),
    format: kind ? (isAnthropic ? 'anthropic' : 'openai') : formatFromHint(fallbackFormat, hit.baseURL),
    providerName: hit.name,
    providerId: hit.id,
    preferredModel: preferredModelOf(hit),
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
        // 代理条目的 format（下拉框）作为兜底传入：供应商缺 api.type 时用它判断请求格式；
        // model 优先用映射表给的首选视觉模型，未命中用代理条目自己的 model
        const r = resolveProviderRef(proxy.useProvider, sessionId, proxy.format);
        return {
          ...proxy,
          baseUrl: r.baseUrl,
          apiKey: r.apiKey,
          format: r.format,
          model: r.preferredModel || proxy.model,
          __provider: r.providerName,
        };
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

// —— 连续失败跳过（ADR-0002）：某代理连续失败满 skipAfterFailures 次后，暂时跳过 skipMinutes 分钟，
// 期间任一次成功即清零计数。状态随缓存文件存盘，钩子每次是新进程也能跨消息生效。 ——

export function skipThresholdsOf(cfg) {
  // 显式 0 = 不跳过（recordProxyFailure 里 count>0 才设跳过期）；缺省或非法值回落默认
  const count = Number(cfg?.skipAfterFailures);
  const minutes = Number(cfg?.skipMinutes);
  return {
    count: cfg?.skipAfterFailures !== undefined && Number.isFinite(count) && count >= 0 ? count : DEFAULT_CONFIG.skipAfterFailures,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_CONFIG.skipMinutes,
  };
}

// 在跳过期返回截止时间戳，否则 null
export function skipUntilOf(cache, name) {
  const until = Number(cache?.skip?.[name]?.skipUntil) || 0;
  return until > Date.now() ? until : null;
}

export function recordProxyFailure(cache, name, count, minutes) {
  const s = (cache.skip ||= {});
  const cur = (s[name] ||= { consecutiveFailures: 0, skipUntil: 0 });
  cur.consecutiveFailures += 1;
  if (count > 0 && cur.consecutiveFailures >= count) cur.skipUntil = Date.now() + minutes * 60 * 1000;
}

export function recordProxySuccess(cache, name) {
  if (cache?.skip?.[name]) delete cache.skip[name];
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
  const { count, minutes } = skipThresholdsOf(cfg);
  const cache = loadCache();
  const skipNote = (proxy, until) =>
    errors.push(
      `${usedLabel(proxy)}: 连续失败 ${cache.skip?.[proxy.name]?.consecutiveFailures ?? count} 次，暂时跳过至 ${new Date(until).toLocaleTimeString('zh-CN', { hour12: false })}（skipAfterFailures/skipMinutes 可配）`,
    );
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
      // pipeline 语义是逐级加工、失败即停：跳过期的代理同样按失败停（Q10 决策）
      const until = skipUntilOf(cache, proxy.name);
      if (until) {
        skipNote(proxy, until);
        return { desc: '', used: lastName, errors };
      }
      const prompt = proxy.prompt || DEFAULT_PROMPT;
      const useImage = !prev; // 第一步带图；后续步纯文本加工
      const finalPrompt = prompt.includes('{prev}') ? prompt.replaceAll('{prev}', prev) : prev ? `${prompt}\n\n${prev}` : prompt;
      try {
        prev = await callProxy({ ...proxy, prompt: finalPrompt }, useImage ? { imageB64: imageBuf.toString('base64'), mime } : {}, cfg);
        lastName = usedLabel(proxy);
        recordProxySuccess(cache, proxy.name);
        saveCache(cache);
      } catch (e) {
        errors.push(`${proxy.name}: ${e.message}`);
        recordProxyFailure(cache, proxy.name, count, minutes);
        saveCache(cache);
        return { desc: '', used: lastName, errors };
      }
    }
    return { desc: prev, used: lastName, errors };
  }
  // fallback：依次尝试到成功为止；连续失败过多的代理暂时跳过（ADR-0002）
  for (const proxy of chainProxies) {
    if (proxy.__missing) {
      errors.push(`链中代理「${proxy.name}」未定义`);
      continue;
    }
    if (proxy.__resolveError) {
      errors.push(`${proxy.name}: ${proxy.__resolveError}`);
      continue;
    }
    const until = skipUntilOf(cache, proxy.name);
    if (until) {
      skipNote(proxy, until);
      continue;
    }
    try {
      const desc = await callProxy(proxy, { imageB64: imageBuf.toString('base64'), mime }, cfg);
      recordProxySuccess(cache, proxy.name);
      saveCache(cache);
      return { desc, used: usedLabel(proxy), errors };
    } catch (e) {
      errors.push(`${proxy.name}: ${e.message}`);
      recordProxyFailure(cache, proxy.name, count, minutes);
      saveCache(cache);
    }
  }
  return { desc: '', used: '', errors };
}

// 追问：对指定图片回答一个针对性问题（vision_ask 工具用）。
// 依次尝试链中可用代理到成功为止（fallback，不跑 pipeline 全链）；结果按「链指纹+图+问题」缓存。
// 压缩阈值：未配置回落默认 1MB；显式 0 = 禁用压缩；其他非法值也回落默认
export function compressThresholdBytesOf(cfg) {
  if (cfg?.compressThresholdKB === undefined) return DEFAULT_CONFIG.compressThresholdKB * 1024;
  const kb = Number(cfg.compressThresholdKB);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : DEFAULT_CONFIG.compressThresholdKB * 1024;
}

export async function askImage(cfg, imageFile, question) {
  const { buf, mime } = await prepareImage(imageFile, compressThresholdBytesOf(cfg));
  const chainProxies = resolveChainProxies(cfg, null);
  const usable = chainProxies.filter((p) => !p.__missing && !p.__resolveError);
  if (!usable.length) {
    throw new Error(`链中无可用代理：${chainProxies.map((p) => p.__resolveError || `${p.name} 未定义`).join('；')}`);
  }
  const fp = chainFingerprint(chainProxies);
  const cache = loadCache();
  const key = createHash('sha256').update(fp).update(buf).update(`\nQ:${question}`).digest('hex');
  const hit = cache.entries[key];
  if (hit?.desc) return { desc: hit.desc, used: hit.model || usable[0].name, cached: true };
  const errors = [];
  const { count, minutes } = skipThresholdsOf(cfg);
  for (const proxy of usable) {
    const until = skipUntilOf(cache, proxy.name);
    if (until) {
      errors.push(`${usedLabelOf(proxy)}: 连续失败过多，暂时跳过至 ${new Date(until).toLocaleTimeString('zh-CN', { hour12: false })}`);
      continue;
    }
    try {
      const desc = await callProxy({ ...proxy, prompt: question }, { imageB64: buf.toString('base64'), mime }, cfg);
      cache.entries[key] = { desc, model: usedLabelOf(proxy), at: Date.now() };
      recordProxySuccess(cache, proxy.name);
      saveCache(cache);
      return { desc, used: usedLabelOf(proxy), cached: false };
    } catch (e) {
      errors.push(`${usedLabelOf(proxy)}: ${e.message}`);
      log(`vision_ask ${usedLabelOf(proxy)} 失败：${e.message}`);
      recordProxyFailure(cache, proxy.name, count, minutes);
      saveCache(cache);
    }
  }
  throw new Error(`所有代理均失败：${errors.join('；')}`);
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
