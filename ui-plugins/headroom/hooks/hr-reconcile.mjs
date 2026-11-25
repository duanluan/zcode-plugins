#!/usr/bin/env node
// 供应商登记对账（SessionStart 钩子 ensure/start/restart 时执行一次）：
// ZCode 侧供应商的 baseUrl 指向本地路由 8787，路由器就按 key 的 sha256 查路由表；
// 界面里换了 key、或供应商接了路由却没登记，请求会被路由器 502 拒掉，而且只有用户
// 主动跑 /hr-join 才能修。这里把“指本地路由的供应商”和 headroom.json 的 providers
// 对一遍：
//   key 变了  → 自动改 keyHash（上游沿用登记记录，不重新推断）
//   未登记    → 只提示，不写入（见下方“为什么不自动补”）
//
// 为什么不自动补登记：能拿到原上游的地方只有 zcode-pro 的 zcodepro.json
// headroomRoutes[id].direct，但那是 headroom 的默认转发地址（GLM 官方），
// 对每个供应商写的都是同一个值（helper.mjs 的 HEADROOM_DIRECT_URL），不是该供应商
// 的真实上游。照它补登记会把 A 供应商的 key 送到 B 的上游，比不修更糟。
// 没有可靠来源时就只提示用户跑 /hr-join——它会问用户真实上游。
//
// 判定规则：只有 baseUrl 指向本地路由端口的供应商参与对账；直连（真实上游地址）
// 的一律不碰——那是用户“不走压缩”的选择。
//
// 写入遵循 ADR-0008：只改 providers，其余键原样保留；读失败时拒绝写入（不能以空
// 对象为底重写，否则 router/instances/kompressBackend 全丢）；用 writeFileAtomic
// （临时文件 + rename）避免钩子超时被强杀时写坏文件。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configFile, writeFileAtomic } from './headroom-lib.mjs';

// ZCode 数据根：与 zcode-pro paths.mjs 的 resolveDataRootDir 同语义
const dataRoot = () => path.join((process.env.ZCODE_DATA_BASE_DIR || '').trim() || homedir(), '.zcode');

// 自测（HR_HEADROOM_CONFIG）时，供应商配置与提示文件都落在测试目录，不碰真机。
// 变量未设置时必须返回空串（早期写成 path.dirname(undefined) 会直接抛错，
// 而这是没设该变量的真机上的常规路径）
const testRoot = () => (process.env.HR_HEADROOM_CONFIG ? path.dirname(process.env.HR_HEADROOM_CONFIG) : '');

const configPathIn = (name) => (testRoot() ? path.join(testRoot(), name) : path.join(dataRoot(), name));
const providerConfigFile = () => (testRoot() ? path.join(testRoot(), 'v2', 'provider_config.json') : path.join(dataRoot(), 'v2', 'provider_config.json'));
const zcodeConfigFile = () => (testRoot() ? path.join(testRoot(), 'v2', 'config.json') : path.join(dataRoot(), 'v2', 'config.json'));
export const noticeFile = () => configPathIn('hr-reconcile-notice.json');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 读 JSON：文件不存在返回 undefined（与“存在但读坏”区分开——后者必须拒绝写入）
function readJson(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined; // ENOENT 等：当作没有
  }
  try {
    return JSON.parse(text);
  } catch {
    return null; // 存在但解析失败
  }
}

// 本地路由判定：从 headroom.json 的 router.port 取端口（默认 8787），
// 与 hr-multi / zcode-pro 的判定保持一致（host 认 127.0.0.1 与 localhost）
function localRouterMatcher() {
  let port = 8787;
  try {
    const cfg = JSON.parse(readFileSync(configFile(), 'utf8'));
    const p = Number(cfg?.router?.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
  } catch { /* 用默认 */ }
  const re = new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${port}/?$`, 'i');
  return (url) => re.test(url);
}

// 上游格式：优先 providerRules 里已有的 api.type（/hr-join 接入时会显式写，
// 因为地址改成 127.0.0.1 后不再带协议线索），其次按地址猜
function formatOf(upstream, apiType) {
  const t = str(apiType).toLowerCase();
  if (t.includes('anthropic')) return 'anthropic';
  if (t.includes('openai')) return 'openai';
  return /anthropic/i.test(upstream) ? 'anthropic' : 'openai';
}

// —— 读 ZCode 侧：providerRules 优先，config.json 的 options 回退 ——
// 存活与否以 providerOrder 为准（界面删掉的供应商定义会残留在 config.json）。
// providerOrder 是空数组时就是“一个都没有”，不能退化成并集把已删的捞回来。
function readZcodeProviders() {
  const pc = readJson(providerConfigFile());
  const cfg = readJson(zcodeConfigFile());
  const rules = pc?.config?.providerConfigRules?.providerRules;
  const order = pc?.config?.providerOrder;
  const providersMap = (cfg && typeof cfg === 'object' && cfg.provider && typeof cfg.provider === 'object') ? cfg.provider : {};

  const ruleById = new Map();
  if (Array.isArray(rules)) {
    for (const r of rules) {
      if (r && typeof r.providerId === 'string') ruleById.set(r.providerId, r);
    }
  }

  // 只有 providerOrder 根本不存在（旧配置）时才回退到并集
  const ids = Array.isArray(order)
    ? order.filter((x) => typeof x === 'string')
    : [...new Set([...ruleById.keys(), ...Object.keys(providersMap)])];

  const out = [];
  for (const id of ids) {
    if (id.startsWith('builtin:')) continue; // 自带供应商走内部 OAuth，不参与路由
    if (!Object.hasOwn(providersMap, id) && !ruleById.has(id)) continue;
    const rule = ruleById.get(id);
    const prov = providersMap[id];
    const baseURL = str(rule?.config?.api?.baseUrl) || str(prov?.options?.baseURL);
    const apiKey = str(rule?.config?.access?.apiKey) || str(prov?.options?.apiKey);
    const name = str(rule?.providerName) || str(prov?.name) || id;
    if (!baseURL || !apiKey) continue;
    out.push({ id, name, baseURL, apiKey, apiType: rule?.config?.api?.type });
  }
  return out;
}

function readProviders() {
  const cfg = readJson(configFile());
  if (cfg === null) {
    // 存在但读坏：调用方必须中止，不能拿空对象继续
    const err = new Error('headroom.json 存在但无法解析');
    err.code = 'config-unreadable';
    throw err;
  }
  if (!cfg || typeof cfg !== 'object') return [];
  return Array.isArray(cfg.providers) ? cfg.providers : [];
}

// 写回：重新读一次配置再按 id 合并，只改本次动过的条目，其余键与条目原样保留。
// entry 是整条替换（残缺条目补全时用），同 id 已存在就覆盖，避免重复条目。
// 读失败直接抛错——绝不能以空对象为底重写，那会丢掉 router/instances/kompressBackend。
function writeProviders(updates) {
  const fresh = readJson(configFile());
  if (fresh === null || fresh === undefined || typeof fresh !== 'object') {
    const err = new Error('headroom.json 读取失败或已损坏，拒绝写入');
    err.code = 'config-unreadable';
    throw err;
  }
  const list = Array.isArray(fresh.providers) ? fresh.providers : [];
  for (const u of updates) {
    const i = list.findIndex((p) => p && p.id === u.id);
    if (u.entry) {
      if (i >= 0) list[i] = u.entry;
      else list.push(u.entry);
    } else if (i >= 0) {
      list[i] = { ...list[i], ...u.patch };
    }
  }
  fresh.providers = list;
  writeFileAtomic(configFile(), JSON.stringify(fresh, null, 2) + '\n');
}

function backupConfig() {
  try {
    writeFileAtomic(`${configFile()}.hr-reconcile.bak`, readFileSync(configFile(), 'utf8'));
  } catch {
    /* 备份失败不阻塞对账：写入本身是原子的 */
  }
}

/**
 * 对账主流程。返回 { fixed:[{id,name,action}], pending:[{id,name,reason}], unchanged }
 * 不抛异常：钩子里任何失败只记日志，不能挡住代理启动。
 */
export function reconcileProviders() {
  const fixed = [];
  const pending = [];
  let unchanged = 0;

  let stored;
  let zcode;
  try {
    stored = readProviders();
    zcode = readZcodeProviders();
  } catch (err) {
    console.error(`hr-reconcile: 读取配置失败，跳过对账：${err?.message || err}`);
    return { fixed, pending, unchanged, failed: true };
  }

  const isLocal = localRouterMatcher();
  const targets = zcode.filter((p) => isLocal(p.baseURL));
  if (!targets.length) return { fixed, pending, unchanged };

  const byId = new Map();
  for (const p of stored) if (p && typeof p.id === 'string') byId.set(p.id, p);

  // —— 冲突检查 ——
  // 路由器按 keyHash 查表（同哈希后写覆盖前写），两个不同上游共用同一 key 会让其中
  // 一个的请求被送到对方上游。判定要用“变更之后的最终归属”，不能边遍历边改表：
  //   - 先算每个目标供应商改完之后会用的 keyHash
  //   - 没参与对账的已登记条目（直连的、已被删的）保持原 keyHash 占用
  //   - 同一哈希被多个 id 认领时，只让第一个改，其余转 pending(key-conflict)
  const finalHashFor = (t) => sha256(t.apiKey); // 参与对账的都是用当前 key
  const targetIds = new Set(targets.map((t) => t.id));
  const claims = new Map(); // hash -> [id...]
  const claim = (hash, id) => {
    if (!claims.has(hash)) claims.set(hash, []);
    claims.get(hash).push(id);
  };
  // 不在对账范围里的条目：保持原样占用
  for (const p of stored) {
    if (!p || typeof p.id !== 'string' || typeof p.keyHash !== 'string') continue;
    if (targetIds.has(p.id)) continue;
    claim(p.keyHash, p.id);
  }
  // 参与对账的：有完整上游的按当前 key 认领；其余不认领（不会写入）
  const completeById = new Map();
  for (const t of targets) {
    const existing = byId.get(t.id);
    if (existing && typeof existing.id === 'string' && str(existing.upstream)) {
      completeById.set(t.id, existing);
      claim(finalHashFor(t), t.id);
    }
  }

  const updates = [];
  for (const t of targets) {
    const hash = finalHashFor(t);
    const existing = completeById.get(t.id);

    if (existing) {
      // 有完整上游的条目：只维护 keyHash（上游是接入时的真实上游，不能拿别处猜）
      const holders = claims.get(hash) || [];
      if (holders.length > 1) {
        // 同一 key 被多个供应商同时认领：只让第一个（按 providerOrder 顺序）改，
        // 其余提示用户各自换 key，避免路由串线
        const first = targets.find((x) => completeById.has(x.id) && finalHashFor(x) === hash);
        if (!first || first.id !== t.id) {
          pending.push({ id: t.id, name: t.name, reason: 'key-conflict' });
          continue;
        }
      }
      if (existing.keyHash === hash) {
        unchanged += 1;
        continue;
      }
      const patch = { keyHash: hash };
      if (existing.name !== t.name) patch.name = t.name;
      if (!str(existing.format)) patch.format = formatOf(existing.upstream, t.apiType);
      updates.push({ id: t.id, patch });
      fixed.push({ id: t.id, name: t.name, action: 'key' });
      continue;
    }

    // 没登记、或条目缺上游：没有可靠来源确定真实上游，只提示
    pending.push({ id: t.id, name: t.name, reason: byId.has(t.id) ? 'incomplete-record' : 'not-registered' });
  }

  if (updates.length) {
    try {
      backupConfig();
      writeProviders(updates);
    } catch (err) {
      console.error(`hr-reconcile: 写入 headroom.json 失败，本次未改动：${err?.message || err}`);
      // 写失败＝实际没修好，不能上报 fixed，也不能当作“没有问题”
      return { fixed: [], pending, unchanged, failed: true };
    }
  }

  return { fixed, pending, unchanged };
}

function clearNotice() {
  const file = noticeFile();
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch (err) {
    console.error(`hr-reconcile: 清理旧提示失败：${err?.message || err}`);
  }
}

/**
 * 对账并写提示文件：有问题写，确认没有问题时清掉上一轮残留。
 * failed=true（读/写配置失败）时什么都不做——既不能当成“已修好”删掉旧提示，
 * 也不能拿不完整的结果覆盖它；上一轮的提示继续有效。
 */
export function reconcileAndNotify() {
  const r = reconcileProviders();
  if (r.failed) return r;
  if (r.fixed.length || r.pending.length) {
    const notice = { at: new Date().toISOString(), ...r };
    try {
      writeFileAtomic(noticeFile(), JSON.stringify(notice, null, 2) + '\n');
    } catch (err) {
      console.error(`hr-reconcile: 写提示文件失败：${err?.message || err}`);
    }
  } else {
    clearNotice();
  }
  return r;
}

// 直跑入口（自测用）：node hooks/hr-reconcile.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(reconcileAndNotify()));
}
