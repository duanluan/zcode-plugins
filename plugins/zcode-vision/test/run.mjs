// zcode-vision 回归测试：node ui-plugins/zcode-vision/test/run.mjs
// 覆盖：格式兜底、首选视觉模型映射、连续失败跳过、主模型感知（flash 跳过/forceIntercept）、
// 默认模板与旧配置升级、真实配置解析。
// 涉及读盘的测试用假 HOME 起子进程（inFakeHome），不碰真实的 ~/.zcode 配置。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as lib from '../hooks/vision-lib.mjs';

const LIB = fileURLToPath(new URL('../hooks/vision-lib.mjs', import.meta.url));
const require_ = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const asyncTests = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // 异步用例：登记，末尾统一等待后判定
      asyncTests.push(r.then(
        () => { passed += 1; console.log(`✓ ${name}`); },
        (e) => { failed += 1; console.log(`✗ ${name}\n  ${e.message}`); },
      ));
      return;
    }
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${name}\n  ${e.message}`);
  }
}

// 假 HOME 跑一段 lib 代码并返回结果；setup(dir) 可先写入配置文件
function inFakeHome(setup, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-test-'));
  fs.mkdirSync(path.join(dir, '.zcode', 'v2'), { recursive: true });
  if (setup) setup(dir);
  const script = `
import * as lib from ${JSON.stringify(LIB)};
Promise.resolve().then(async () => { ${body} }).then(
  (r) => console.log(JSON.stringify({ ok: true, r })),
  (e) => console.log(JSON.stringify({ ok: false, e: String((e && e.message) || e) })),
);
`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: dir },
    encoding: 'utf8',
    timeout: 30000,
  });
  const res = JSON.parse(out.trim().split('\n').pop());
  if (!res.ok) throw new Error(`子进程报错：${res.e}`);
  return { result: res.r, dir };
}

// 往假 HOME 写一个供应商（config.json 的 provider.<id>）
const writeProvider =
  (id, extra = {}) =>
  (dir) => {
    const cfg = {
      provider: {
        [id]: {
          name: extra.name || id,
          kind: extra.kind,
          options: { baseURL: extra.baseURL ?? 'https://api.example.com/v1', apiKey: extra.apiKey ?? 'sk-test' },
          models: extra.models || {},
        },
      },
    };
    fs.writeFileSync(path.join(dir, '.zcode', 'v2', 'config.json'), JSON.stringify(cfg));
  };

const writeVisionCfg = (cfg) => (dir) => {
  fs.writeFileSync(path.join(dir, '.zcode', 'zcode-vision.json'), JSON.stringify(cfg));
};

// —— 格式兜底（api.type 缺失/异常时不失败） ——

t('格式兜底：缺 api.type 且地址含 /anthropic → anthropic', () => {
  const { result } = inFakeHome(writeProvider('p1', { baseURL: 'https://x.example/api/anthropic' }), `
    return lib.resolveProviderRef('p1', null);`);
  assert.equal(result.format, 'anthropic');
});

t('格式兜底：缺 api.type 且普通地址 → openai', () => {
  const { result } = inFakeHome(writeProvider('p1', { baseURL: 'https://x.example/v1' }), `
    return lib.resolveProviderRef('p1', null);`);
  assert.equal(result.format, 'openai');
});

t('格式兜底：缺 api.type 时用代理条目 format 下拉值兜底', () => {
  const { result } = inFakeHome(writeProvider('p1', { baseURL: 'https://x.example/v1' }), `
    return {
      a: (await lib.resolveProviderRef('p1', null, 'anthropic')).format,
      b: (await lib.resolveProviderRef('p1', null, 'anthropic-messages')).format,
      c: (await lib.resolveProviderRef('p1', null, 'openai')).format,
    };`);
  assert.deepEqual(result, { a: 'anthropic', b: 'anthropic', c: 'openai' });
});

t('格式兜底：api.type=anthropic-messages → anthropic', () => {
  const { result } = inFakeHome(writeProvider('p1', { kind: 'anthropic-messages', baseURL: 'https://x.example/v1' }), `
    return lib.resolveProviderRef('p1', null);`);
  assert.equal(result.format, 'anthropic');
});

t('格式兜底：openai-responses 格式明确报「暂不支持」', () => {
  const { result } = inFakeHome(writeProvider('p1', { kind: 'openai-responses' }), `
    try { await lib.resolveProviderRef('p1', null); return 'no-throw'; } catch (e) { return e.message; }`);
  assert.match(result, /暂不支持/);
});

t('格式兜底：其他 api.type 按 openai 处理', () => {
  const { result } = inFakeHome(writeProvider('p1', { kind: 'openai-chat-completions' }), `
    return lib.resolveProviderRef('p1', null);`);
  assert.equal(result.format, 'openai');
});

t('格式兜底：缺 baseURL / 缺 API key 分别报明确错误', () => {
  const { result } = inFakeHome((dir) => {
    fs.writeFileSync(
      path.join(dir, '.zcode', 'v2', 'config.json'),
      JSON.stringify({
        provider: {
          'p-noUrl': { name: 'p-noUrl', options: { baseURL: '', apiKey: 'sk-test' }, models: {} },
          'p-noKey': { name: 'p-noKey', options: { baseURL: 'https://x.example/v1', apiKey: '' }, models: {} },
        },
      }),
    );
  }, `
    const grab = async (id) => { try { await lib.resolveProviderRef(id, null); return 'no-throw'; } catch (e) { return e.message; } };
    return { a: await grab('p-noUrl'), b: await grab('p-noKey') };
`);
  assert.match(result.a, /未配置 baseURL/);
  assert.match(result.b, /未配置 API key/);
});

// —— 登录账号供应商：id 归一化 + 凭据解密 ——

t('归一化：account:individual/team ≡ builtin:coding-plan', () => {
  const n = lib.normalizeProviderIdForMatch;
  assert.equal(n('account:bigmodel-individual-coding-plan'), n('builtin:bigmodel-coding-plan'));
  assert.equal(n('account:bigmodel-team-coding-plan'), n('builtin:bigmodel-coding-plan'));
  assert.equal(n('account:bigmodel-start-plan'), n('builtin:bigmodel-start-plan'));
  assert.equal(n('95e62afc-0000'), '95e62afc-0000'); // 普通供应商 id 不动
});

t('解密：官方 enc:v1 格式往返；坏值返回空串', () => {
  const { createCipheriv, randomBytes } = require_('node:crypto');
  const secret = `zcode-credential-fallback:${process.platform}:${os.homedir()}:${os.userInfo().username}`;
  const key = require_('node:crypto').createHash('sha256').update(secret).digest();
  const enc = (v) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
    return 'enc:v1:' + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  };
  assert.equal(lib.decryptCredentialValue(enc('token-abc')), 'token-abc');
  assert.equal(lib.decryptCredentialValue('plain'), 'plain');
  assert.equal(lib.decryptCredentialValue('enc:v1:garbage'), '');
  assert.equal(lib.decryptCredentialValue(''), '');
});

// —— 跟随会话时的模型优先级：自定义模型属于跟随到的供应商时优先于映射表 ——

// 假 HOME 里造一张任务索引（含最近会话的 providerId/modelId），子进程解析链
function withFakeTasksIndex(providerId, modelId, proxyModel, expect, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-prio-'));
  fs.mkdirSync(path.join(dir, '.zcode', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.zcode', 'v2', 'config.json'), JSON.stringify({
    provider: { 'builtin:bigmodel-coding-plan': { name: 'BigModel', kind: 'anthropic',
      options: { baseURL: 'https://x.example/api/anthropic', apiKey: 'sk-test' },
      models: { 'glm-5.3-flash': {}, 'GLM-5.3': {} } } },
  }));
  const dbPath = path.join(dir, '.zcode', 'v2', 'tasks-index.sqlite');
  const { DatabaseSync } = require_('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tasks (task_id TEXT, model TEXT, deleted INTEGER DEFAULT 0, updated_at INTEGER)');
  db.prepare('INSERT INTO tasks (task_id, model, updated_at) VALUES (?, ?, 1)').run('sess_t1', providerId + '/' + modelId);
  db.close();
  const script = `
import * as lib from ${JSON.stringify(LIB)};
const cfg = { chain: ['p'], proxies: [{ name: 'p', useProvider: 'session', model: ${JSON.stringify(proxyModel)} }] };
const r = await lib.resolveChainProxies(cfg, null);
console.log(JSON.stringify({ model: r[0].model, err: r[0].__resolveError }));
`;
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 30000,
  });
  const res = JSON.parse(out.trim().split('\n').pop());
  assert.equal(res.err, undefined, name + ' 解析失败: ' + res.err);
  assert.equal(res.model, expect, name);
}

t('跟随会话 + 自定义模型属于该供应商 → 用自定义（不被映射表抢占）', () => {
  withFakeTasksIndex('builtin:bigmodel-coding-plan', 'glm-5.3', 'GLM-5.3', 'GLM-5.3', '自定义优先');
});

t('跟随会话 + 自定义模型不属于该供应商 → 映射表首选（跨供应商修正）', () => {
  withFakeTasksIndex('builtin:bigmodel-coding-plan', 'glm-5.3', 'mimo-v2.6-flash', 'glm-5.3-flash', '映射表修正');
});

// —— 首选视觉模型映射表（ADR-0001） ——

t('映射表：Xiaomi MiMo（id/名称）→ mimo-v2.6-flash', () => {
  assert.equal(
    lib.preferredModelOf({ id: 'xiaomi-mimo', name: 'Xiaomi MiMo', models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'] }),
    'mimo-v2.6-flash',
  );
  assert.equal(lib.preferredModelOf({ id: 'other', name: 'Xiaomi MiMo' }), 'mimo-v2.6-flash');
});

t('映射表：Trust Build → GLM-5.3-Flash（该家模型 id 是大写）', () => {
  assert.equal(lib.preferredModelOf({ id: 'builtin:bigmodel-start-plan', name: 'Trust Build', models: [] }), 'GLM-5.3-Flash');
});

t('映射表：智谱系 → glm-5.3-flash（id/名称/别名都能匹配）', () => {
  assert.equal(lib.preferredModelOf({ id: 'builtin:bigmodel-coding-plan', name: 'x', models: [] }), 'glm-5.3-flash');
  assert.equal(lib.preferredModelOf({ id: 'p9', name: 'Z.ai Max', models: [] }), 'glm-5.3-flash');
  assert.equal(lib.preferredModelOf({ id: 'p9', name: 'n', aliases: ['BigModel-Max1'], models: [] }), 'glm-5.3-flash');
});

t('映射表：大小写归一到供应商模型列表里的精确写法', () => {
  assert.equal(lib.preferredModelOf({ id: 'builtin:bigmodel-start-plan', models: ['GLM-5.3-Flash'] }), 'GLM-5.3-Flash');
  assert.equal(lib.preferredModelOf({ id: 'BigModel-cn', models: ['GLM-5.3-Flash', 'glm-4.5v'] }), 'GLM-5.3-Flash');
});

t('映射表：未命中或列表不含该模型 → null（回退代理条目 model）', () => {
  assert.equal(lib.preferredModelOf({ id: 'openai', name: 'OpenAI', models: ['gpt-5'] }), null);
  assert.equal(lib.preferredModelOf({ id: 'xiaomi-mimo', models: ['mimo-v2.6-pro'] }), null);
});

// —— 连续失败跳过（ADR-0002） ——

t('跳过阈值：默认 2 次 / 30 分钟；显式 0 = 不跳过；非法回落默认', () => {
  assert.deepEqual(lib.skipThresholdsOf({}), { count: 2, minutes: 30 });
  assert.deepEqual(lib.skipThresholdsOf({ skipAfterFailures: 2, skipMinutes: 5 }), { count: 2, minutes: 5 });
  assert.deepEqual(lib.skipThresholdsOf({ skipAfterFailures: 0, skipMinutes: -1 }), { count: 0, minutes: 30 });
  assert.deepEqual(lib.skipThresholdsOf({ skipAfterFailures: 'x' }), { count: 2, minutes: 30 });
  assert.equal(lib.compressThresholdBytesOf({}), 1024 * 1024);
  assert.equal(lib.compressThresholdBytesOf({ compressThresholdKB: 0 }), 0);
  assert.equal(lib.compressThresholdBytesOf({ compressThresholdKB: 'x' }), 1024 * 1024);
});

t('跳过机制：满次数设跳过期，count=0 永不跳过，成功清零', () => {
  const cache = { entries: {} };
  for (let i = 0; i < 3; i += 1) lib.recordProxyFailure(cache, 'a', 4, 30);
  assert.equal(lib.skipUntilOf(cache, 'a'), null);
  lib.recordProxyFailure(cache, 'a', 4, 30);
  const until = lib.skipUntilOf(cache, 'a');
  assert.ok(until && until > Date.now(), '满 4 次应设跳过期');
  lib.recordProxySuccess(cache, 'a');
  assert.equal(lib.skipUntilOf(cache, 'a'), null);
  for (let i = 0; i < 5; i += 1) lib.recordProxyFailure(cache, 'b', 0, 30);
  assert.equal(lib.skipUntilOf(cache, 'b'), null);
});

t('跳过机制：过期的跳过期不再生效', () => {
  const cache = { entries: {}, skip: { c: { consecutiveFailures: 4, skipUntil: Date.now() - 1000 } } };
  assert.equal(lib.skipUntilOf(cache, 'c'), null);
});

// —— 主模型感知（flash 跳过 / forceIntercept） ——

t('主模型判断：flash 系 → flash；能看图的 → vision；认不出 → unknown', () => {
  assert.equal(lib.mainModelKind('glm-5.3-flash'), 'flash');
  assert.equal(lib.mainModelKind('mimo-v2.6-flash'), 'flash');
  assert.equal(lib.mainModelKind('GLM-5.3-Flash'), 'flash');
  assert.equal(lib.mainModelKind('xiaomi-mimo/mimo-v2.6-flash'), 'flash');
  assert.equal(lib.mainModelKind('mimo-v2.6-pro'), 'vision');
  assert.equal(lib.mainModelKind('glm-4.5v'), 'vision');
  assert.equal(lib.mainModelKind('qwen2.5-vl-72b'), 'vision');
  assert.equal(lib.mainModelKind('glm-5.3'), 'unknown');
  assert.equal(lib.mainModelKind('deepseek-v3'), 'unknown');
  assert.equal(lib.mainModelKind(''), 'unknown');
  // 真实任务索引里 model 列带 $ 档位标签（如 "mimo-v2.6-pro$enabled"），判断前要剥掉
  assert.equal(lib.mainModelKind('mimo-v2.6-pro$enabled'), 'vision');
  assert.equal(lib.mainModelKind('xiaomi-mimo/glm-5.3-flash$max'), 'flash');
  assert.equal(lib.mainModelKind('glm-5.3$max'), 'unknown');
});

t('主模型跳过：flash 永远跳过；能看图看 forceIntercept（默认 true 照常识别）', () => {
  assert.equal(lib.skipByMainModel({ forceIntercept: true }, 'mimo-v2.6-flash'), true);
  assert.equal(lib.skipByMainModel({ forceIntercept: true }, 'mimo-v2.6-pro'), false);
  assert.equal(lib.skipByMainModel({ forceIntercept: false }, 'mimo-v2.6-pro'), true);
  assert.equal(lib.skipByMainModel({}, 'mimo-v2.6-pro'), false); // 缺省 = true
  assert.equal(lib.skipByMainModel({ forceIntercept: false }, 'glm-5.3'), false); // 纯文本照常识别
  assert.equal(lib.skipByMainModel({ forceIntercept: false }, null), false); // 认不出照常识别
});

t('会话模型：tasks.model 列拆出 providerId / modelId', () => {
  let DatabaseSync = null;
  try {
    DatabaseSync = require_('node:sqlite').DatabaseSync;
  } catch {
    /* 旧 node 没有 node:sqlite，跳过（lib 有 sqlite3 CLI 回退但这里不建库） */
  }
  if (!DatabaseSync) {
    console.log('  （node:sqlite 不可用，跳过）');
    return;
  }
  const { result } = inFakeHome(
    (dir) => {
      const db = new DatabaseSync(path.join(dir, '.zcode', 'v2', 'tasks-index.sqlite'));
      db.exec('CREATE TABLE tasks (task_id TEXT, model TEXT, updated_at INTEGER)');
      db.prepare('INSERT INTO tasks VALUES (?,?,?)').run('sess_a', 'xiaomi-mimo/mimo-v2.6-flash$enabled', 1);
      db.close();
    },
    `return { p: lib.sessionProviderId('sess_a'), m: lib.sessionModelId('sess_a'), none: lib.sessionModelId('sess_z') };`,
  );
  assert.equal(result.p, 'xiaomi-mimo');
  assert.equal(result.m, 'mimo-v2.6-flash');
  assert.equal(result.none, null);
});

// —— 默认模板与旧配置升级 ——

const legacyV1 = () => ({
  chain: ['glm-flash'],
  proxies: [
    {
      name: 'glm-flash',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.3-flash',
      apiKey: '',
      format: 'anthropic',
      prompt: lib.DEFAULT_PROMPT,
    },
  ],
});
const legacyV2 = () => ({
  chain: ['glm-session', 'glm-flash'],
  proxies: [
    { name: 'glm-session', useProvider: 'session', model: 'glm-5.3-flash', prompt: lib.DEFAULT_PROMPT },
    ...legacyV1().proxies,
  ],
});

t('默认模板：无配置文件时生成默认单级 session 并写盘', () => {
  const { result, dir } = inFakeHome(null, `return lib.loadConfig();`);
  assert.deepEqual(result.chain, ['session']);
  assert.equal(result.proxies.length, 1);
  assert.equal(result.proxies[0].useProvider, 'session');
  assert.equal(result.proxies[0].model, ''); // 留空 = 会话当前模型
  const written = JSON.parse(fs.readFileSync(path.join(dir, '.zcode', 'zcode-vision.json'), 'utf8'));
  assert.equal(written.proxies.length, 1);
  assert.equal(written.skipAfterFailures, 2);
  assert.equal(written.skipMinutes, 30);
  assert.equal(written.forceIntercept, true);
});

t('旧配置升级：v1 单代理默认 → 单级 session', () => {
  const { result } = inFakeHome(writeVisionCfg(legacyV1()), `return lib.loadConfig();`);
  assert.deepEqual(result.chain, ['session']);
  assert.equal(result.proxies.length, 1);
});

t('旧配置升级：未自定义的 v2 两级默认自动升级为单级 session', () => {
  const { result } = inFakeHome(writeVisionCfg(legacyV2()), `return lib.loadConfig();`);
  assert.deepEqual(result.chain, ['session']);
  assert.equal(result.proxies.length, 1);
  assert.equal(result.proxies[0].useProvider, 'session');
  assert.equal(result.proxies[0].model, '');
});

t('旧配置升级：改过的配置保持原样（换模型/改模式都不动）', () => {
  const custom = legacyV2();
  custom.proxies.find((p) => p.name === 'glm-flash').model = 'glm-4.5v';
  const { result } = inFakeHome(writeVisionCfg(custom), `return lib.loadConfig();`);
  assert.equal(result.proxies.find((p) => p.name === 'glm-flash').model, 'glm-4.5v');
  assert.deepEqual(result.chain, ['glm-session', 'glm-flash']);
  const piped = legacyV2();
  piped.chainMode = 'pipeline';
  const r2 = inFakeHome(writeVisionCfg(piped), `return lib.loadConfig();`).result;
  assert.equal(r2.chainMode, 'pipeline');
});

// —— 真实配置（读本机 ~/.zcode，验证真实供应商可解析） ——

t('真实配置：链中代理全部解析成功（无 __missing/__resolveError）', async () => {
  const cfg = lib.loadConfig();
  const cps = await lib.resolveChainProxies(cfg, null);
  assert.ok(cps.length >= 2, '链至少两级');
  for (const p of cps) {
    assert.ok(!p.__missing, `${p.name} 未定义`);
    assert.ok(!p.__resolveError, `${p.name}: ${p.__resolveError}`);
    assert.ok(p.baseUrl && p.apiKey, `${p.name} 缺 baseUrl/apiKey`);
  }
});

t('真实配置：xiaomi-mimo 解析出首选视觉模型 mimo-v2.6-flash', async () => {
  const r = await lib.resolveProviderRef('xiaomi-mimo', null);
  assert.equal(r.preferredModel, 'mimo-v2.6-flash');
  assert.ok(['anthropic', 'openai'].includes(r.format));
});

await Promise.all(asyncTests);
console.log(`\n${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
