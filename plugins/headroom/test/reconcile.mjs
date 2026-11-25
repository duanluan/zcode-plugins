// hr-reconcile 回归测试：node ui-plugins/headroom/test/reconcile.mjs
// 零依赖，全绿退出码 0。
//
// 用假目录隔离：HR_HEADROOM_CONFIG 指到临时目录，reconcile 的供应商配置、
// zcodepro 记录、提示文件都落在这个目录下，不碰真实 ~/.zcode。
// 覆盖：
//   - 直连供应商不参与对账
//   - 已登记且哈希一致 → 不动
//   - 已登记但 key 变了 → 只更新 keyHash，上游不变
//   - 未登记 → 一律只提示，不猜上游（zcodepro 的 direct 是 GLM 固定地址）
//   - 条目缺上游 → 记为 incomplete-record，也不猜
//   - providerOrder 之外的残留定义不处理；providerOrder 为空时不捞回已删的
//   - headroom.json 损坏时拒绝写入，原文件与其余键保持原样
//   - 对账无问题时清理上一轮残留的提示文件

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/hr-reconcile.mjs', import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// 临时目录统一登记，跑完删掉（/tmp 是 tmpfs，反复跑测试不清理会占内存）
const dirs = [];
process.on('exit', () => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

let failed = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`✓ ${name}`);
  else {
    failed += 1;
    console.log(`✗ ${name}${extra ? `\n  ${extra}` : ''}`);
  }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);

// 造一个隔离目录并写入场景配置，返回 { dir, run, read, readNotice }
function scenario({ zcodeProviders, providerRules, providerOrder, headroom, zcodepro }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-reconcile-test-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'v2'), { recursive: true });

  if (providerOrder || providerRules) {
    fs.writeFileSync(path.join(dir, 'v2', 'provider_config.json'), JSON.stringify({
      config: {
        providerOrder: providerOrder || [],
        providerConfigRules: { providerRules: providerRules || [] },
      },
    }, null, 2));
  }
  if (zcodeProviders) {
    fs.writeFileSync(path.join(dir, 'v2', 'config.json'), JSON.stringify({ provider: zcodeProviders }, null, 2));
  }
  if (headroom) {
    fs.writeFileSync(path.join(dir, 'headroom.json'), JSON.stringify(headroom, null, 2));
  }
  if (zcodepro) {
    fs.writeFileSync(path.join(dir, 'zcodepro.json'), JSON.stringify(zcodepro, null, 2));
  }

  const run = () => {
    const out = execFileSync(process.execPath, [HOOK], {
      env: { ...process.env, HR_HEADROOM_CONFIG: path.join(dir, 'headroom.json'), ZCODE_DATA_BASE_DIR: '' },
      encoding: 'utf8',
      timeout: 30000,
    });
    return JSON.parse(out.trim().split('\n').pop());
  };
  const read = (name = 'headroom.json') => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const readNotice = () => {
    const f = path.join(dir, 'hr-reconcile-notice.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  return { dir, run, read, readNotice };
}

const PROXY = 'http://127.0.0.1:8787';

// —— 1. 直连供应商：不进对账，不写任何东西 ——
{
  const s = scenario({
    providerOrder: ['p-direct'],
    providerRules: [{ providerId: 'p-direct', providerName: '直连', config: { access: { apiKey: 'k1' }, api: { baseUrl: 'https://api.example.com' } } }],
    headroom: { providers: [], router: { port: 8787 } },
  });
  const r = s.run();
  eq('直连供应商：无修复无待办', [r.fixed.length, r.pending.length], [0, 0]);
  eq('直连供应商：providers 仍为空', s.read().providers, []);
  ok('直连供应商：不写提示文件', s.readNotice() === null);
}

// —— 2. 已登记且哈希一致：不动 ——
{
  const key = 'my-key-1';
  const s = scenario({
    providerOrder: ['p1'],
    providerRules: [{ providerId: 'p1', providerName: '供应商 1', config: { access: { apiKey: key }, api: { baseUrl: PROXY } } }],
    headroom: {
      providers: [{ id: 'p1', name: '供应商 1', upstream: 'https://up.example.com/v1', format: 'openai', keyHash: sha256(key), origBaseURL: 'https://up.example.com/v1' }],
      router: { port: 8787 },
    },
  });
  const r = s.run();
  eq('哈希一致：无修复', r.fixed.length, 0);
  eq('哈希一致：unchanged=1', r.unchanged, 1);
  eq('哈希一致：条目未变', s.read().providers, [{ id: 'p1', name: '供应商 1', upstream: 'https://up.example.com/v1', format: 'openai', keyHash: sha256(key), origBaseURL: 'https://up.example.com/v1' }]);
  ok('哈希一致：不写提示文件', s.readNotice() === null);
}

// —— 3. key 变了：只更新 keyHash，上游沿用 ——
{
  const newKey = 'my-key-NEW';
  const s = scenario({
    providerOrder: ['p1'],
    providerRules: [{ providerId: 'p1', providerName: '供应商 1', config: { access: { apiKey: newKey }, api: { baseUrl: PROXY } } }],
    headroom: {
      providers: [{ id: 'p1', name: '供应商 1', upstream: 'https://up.example.com/v1', format: 'openai', keyHash: sha256('my-key-OLD'), origBaseURL: 'https://up.example.com/v1' }],
      router: { port: 8787 },
      instances: { 'openai|https://up.example.com/v1': 28792 },
    },
    // 即使能推断出别的上游，key 变更也不该换上游
    zcodepro: { headroomRoutes: { p1: { proxy: PROXY, direct: 'https://other.example.com/v1' } } },
  });
  const r = s.run();
  eq('key 变更：记一条 key 修复', r.fixed.map((x) => x.action), ['key']);
  const after = s.read();
  eq('key 变更：keyHash 已更新', after.providers[0].keyHash, sha256(newKey));
  eq('key 变更：上游沿用原记录', after.providers[0].upstream, 'https://up.example.com/v1');
  eq('key 变更：其他键保留（instances）', after.instances, { 'openai|https://up.example.com/v1': 28792 });
  eq('key 变更：router 保留', after.router, { port: 8787 });
  const n = s.readNotice();
  ok('key 变更：提示文件写了 fixed', n && n.fixed.length === 1 && n.fixed[0].action === 'key');
}

// —— 4. 未登记的供应商：即使 zcodepro 里有记录也不自动补（那里的 direct 是 GLM
//       固定地址，不是该供应商的真实上游，照它补会把 key 送到错误的上游）——
{
  const key = 'brand-new-key';
  const s = scenario({
    providerOrder: ['p2'],
    providerRules: [{ providerId: 'p2', providerName: '供应商 2', config: { access: { apiKey: key }, api: { baseUrl: PROXY } } }],
    headroom: { providers: [], router: { port: 8787 } },
    zcodepro: { headroomRoutes: { p2: { proxy: PROXY, direct: 'https://open.bigmodel.cn/api/anthropic' } } },
  });
  const r = s.run();
  eq('未登记：不自动补', r.fixed.length, 0);
  eq('未登记：记为 not-registered', r.pending.map((x) => x.reason), ['not-registered']);
  eq('未登记：providers 仍为空', s.read().providers, []);
  const n = s.readNotice();
  ok('未登记：提示文件写了 pending', n && n.pending.length === 1);
}

// —— 5. 未登记且推不出上游：不写入，记 pending ——
{
  const s = scenario({
    providerOrder: ['p3'],
    providerRules: [{ providerId: 'p3', providerName: '供应商 3', config: { access: { apiKey: 'k3' }, api: { baseUrl: PROXY } } }],
    headroom: { providers: [], router: { port: 8787 } },
  });
  const r = s.run();
  eq('推不出：pending 一条', r.pending.map((x) => x.id), ['p3']);
  eq('推不出：providers 仍为空', s.read().providers, []);
  const n = s.readNotice();
  ok('推不出：提示文件写了 pending', n && n.pending.length === 1 && n.pending[0].reason === 'not-registered');
}

// —— 6. providerOrder 之外的残留定义不处理 ——
{
  const s = scenario({
    providerOrder: ['keep'],
    providerRules: [
      { providerId: 'keep', providerName: '在用', config: { access: { apiKey: 'keep-key' }, api: { baseUrl: PROXY } } },
      { providerId: 'stale', providerName: '残留', config: { access: { apiKey: 'stale-key' }, api: { baseUrl: PROXY } } },
    ],
    headroom: { providers: [], router: { port: 8787 } },
  });
  const r = s.run();
  eq('残留定义：只处理 providerOrder 里的', r.pending.map((x) => x.id), ['keep']);
}

// —— 7. 回退：provider_config 缺失时读 config.json 的 options ——
{
  const key = 'cfgkey';
  const s = scenario({
    headroom: { providers: [], router: { port: 8787 } },
    zcodeProviders: {
      legacy: { name: '老供应商', options: { baseURL: PROXY, apiKey: key } },
      directOne: { name: '直连', options: { baseURL: 'https://x.example.com', apiKey: 'x' } },
    },
    providerOrder: ['legacy', 'directOne'],
  });
  const r = s.run();
  eq('回退 config.json：老供应商进待办', r.pending.map((x) => x.id), ['legacy']);
  eq('回退 config.json：直连项不参与', s.read().providers.length, 0);
}

// —— 8. 尾部带斜杠的 8787 也算本地路由 ——
{
  const s = scenario({
    providerOrder: ['p4'],
    providerRules: [{ providerId: 'p4', providerName: '带斜杠', config: { access: { apiKey: 'k4' }, api: { baseUrl: `${PROXY}/` } } }],
    headroom: { providers: [], router: { port: 8787 } },
  });
  const r = s.run();
  eq('尾斜杠地址也参与对账', r.pending.map((x) => x.id), ['p4']);
}

// —— 9. 残缺条目（缺 upstream）→ 不猜上游，只提示 ——
{
  const s = scenario({
    providerOrder: ['p5'],
    providerRules: [{ providerId: 'p5', providerName: '残缺条目', config: { access: { apiKey: 'k5new' }, api: { baseUrl: PROXY } } }],
    // 历史脏数据：有 id 和 keyHash，但没有 upstream
    headroom: { providers: [{ id: 'p5', name: '残缺条目', keyHash: sha256('k5old') }], router: { port: 8787 } },
  });
  const r = s.run();
  eq('残缺条目：记为 incomplete-record', r.pending.map((x) => x.reason), ['incomplete-record']);
  eq('残缺条目：不写入不产生重复', s.read().providers.length, 1);
}

// —— 10. 完整条目哈希一致：不因外部记录改上游 ——
{
  const key = 'same';
  const s = scenario({
    providerOrder: ['p6'],
    providerRules: [{ providerId: 'p6', providerName: '完整', config: { access: { apiKey: key }, api: { baseUrl: PROXY } } }],
    headroom: { providers: [{ id: 'p6', name: '完整', upstream: 'https://keep.example.com/v1', format: 'openai', keyHash: sha256(key), origBaseURL: 'https://keep.example.com/v1' }], router: { port: 8787 } },
    zcodepro: { headroomRoutes: { p6: { direct: 'https://other.example.com/v1' } } },
  });
  const r = s.run();
  eq('完整条目：unchanged', r.unchanged, 1);
  eq('完整条目：上游不动', s.read().providers[0].upstream, 'https://keep.example.com/v1');
}

// —— 11. providerOrder 为空数组：视为没有存活供应商（不能把已删的捞回来）——
{
  const s = scenario({
    providerOrder: [],
    providerRules: [{ providerId: 'deleted', providerName: '已删除', config: { access: { apiKey: 'dk' }, api: { baseUrl: PROXY } } }],
    headroom: { providers: [], router: { port: 8787 } },
    zcodepro: { headroomRoutes: { deleted: { direct: 'https://open.bigmodel.cn/api/anthropic' } } },
  });
  const r = s.run();
  eq('空 providerOrder：不处理任何供应商', [r.fixed.length, r.pending.length], [0, 0]);
  eq('空 providerOrder：不写入', s.read().providers, []);
}

// —— 12. headroom.json 损坏：拒绝写入，原文件保持原样、其余键不丢，且标记失败 ——
{
  const s = scenario({
    providerOrder: ['p7'],
    providerRules: [{ providerId: 'p7', providerName: '损坏测试', config: { access: { apiKey: 'k7' }, api: { baseUrl: PROXY } } }],
  });
  // 写一份截断的坏配置（含 router 等键，验证不会被清掉）
  const broken = '{"providers":[{"id":"p7","upstream":"https://x/v1","format":"openai","keyHash":"old"}],"router":{"port":8787},"kompressBackend":"cpu"';
  fs.writeFileSync(path.join(s.dir, 'headroom.json'), broken);
  const r = s.run();
  // failed 标记是这条保护的关键特征：去掉保护（按空对象兜底）时它会是 undefined，
  // 只断言“原文件未变”抓不到——坏 JSON 兜底成空对象后同样不会写
  eq('损坏配置：标记 failed', r.failed, true);
  eq('损坏配置：不报 fixed', r.fixed.length, 0);
  eq('损坏配置：原文件逐字节未变', fs.readFileSync(path.join(s.dir, 'headroom.json'), 'utf8'), broken);
  ok('损坏配置：kompressBackend 仍在原文里', fs.readFileSync(path.join(s.dir, 'headroom.json'), 'utf8').includes('kompressBackend'));
}

// —— 12b. 配置损坏时保留上一轮提示（不能把“没检查成”当成“没问题”）——
{
  const s = scenario({
    providerOrder: ['p7b'],
    providerRules: [{ providerId: 'p7b', providerName: '损坏+旧提示', config: { access: { apiKey: 'k' }, api: { baseUrl: PROXY } } }],
  });
  fs.writeFileSync(path.join(s.dir, 'headroom.json'), '{ 坏掉的 json');
  const oldNotice = JSON.stringify({ at: '2026-01-01T00:00:00Z', fixed: [], pending: [{ id: 'old', name: '旧', reason: 'not-registered' }], unchanged: 0 });
  fs.writeFileSync(path.join(s.dir, 'hr-reconcile-notice.json'), oldNotice);
  s.run();
  eq('损坏配置：旧提示保留', s.readNotice()?.pending?.[0]?.id, 'old');
}

// —— 13. 对账无问题时清理上一轮残留的提示 ——
{
  const s = scenario({
    providerOrder: ['p8'],
    providerRules: [{ providerId: 'p8', providerName: '正常', config: { access: { apiKey: 'k8' }, api: { baseUrl: PROXY } } }],
    headroom: {
      providers: [{ id: 'p8', name: '正常', upstream: 'https://ok.example.com/v1', format: 'openai', keyHash: sha256('k8'), origBaseURL: 'https://ok.example.com/v1' }],
      router: { port: 8787 },
    },
  });
  // 预置一份上一轮的旧提示
  fs.writeFileSync(path.join(s.dir, 'hr-reconcile-notice.json'), JSON.stringify({ at: '2026-01-01T00:00:00Z', fixed: [], pending: [{ id: 'old', name: '旧', reason: 'not-registered' }], unchanged: 0 }));
  s.run();
  ok('无问题时清理旧提示文件', s.readNotice() === null);
}

// —— 14. 两个供应商被改成同一 key：不写入，记为 key-conflict（否则路由串线）——
{
  const s = scenario({
    providerOrder: ['a', 'b'],
    providerRules: [
      { providerId: 'a', providerName: 'A', config: { access: { apiKey: 'SAME' }, api: { baseUrl: PROXY } } },
      { providerId: 'b', providerName: 'B', config: { access: { apiKey: 'SAME' }, api: { baseUrl: PROXY } } },
    ],
    headroom: {
      providers: [
        { id: 'a', name: 'A', upstream: 'https://a-up/v1', format: 'openai', keyHash: sha256('oldA'), origBaseURL: 'https://a-up/v1' },
        { id: 'b', name: 'B', upstream: 'https://b-up/v1', format: 'openai', keyHash: sha256('oldB'), origBaseURL: 'https://b-up/v1' },
      ],
      router: { port: 8787 },
    },
  });
  const r = s.run();
  const after = s.read();
  const hashes = after.providers.map((p) => p.keyHash);
  ok('同 key 冲突：不产生重复 keyHash', new Set(hashes).size === hashes.length, `实际 ${JSON.stringify(hashes)}`);
  ok('同 key 冲突：至少一方进 pending 且原因是 key-conflict',
    r.pending.some((x) => x.reason === 'key-conflict'), JSON.stringify(r.pending));
}

// —— 15. unchanged 条目占着同一哈希时，另一个改到该 key 不能造成重复 ——
// a 由 X 改成 Y、b 保持 X：a 让出 X 后 b 独占，不算冲突，两条哈希仍不同。
// 这里守住的是“不产生重复”，不要求报 conflict。
{
  const s = scenario({
    providerOrder: ['a', 'b'],
    providerRules: [
      { providerId: 'a', providerName: 'A', config: { access: { apiKey: 'Y' }, api: { baseUrl: PROXY } } },
      { providerId: 'b', providerName: 'B', config: { access: { apiKey: 'X' }, api: { baseUrl: PROXY } } },
    ],
    headroom: {
      providers: [
        { id: 'a', name: 'A', upstream: 'https://a-up/v1', format: 'openai', keyHash: sha256('X'), origBaseURL: 'https://a-up/v1' },
        { id: 'b', name: 'B', upstream: 'https://b-up/v1', format: 'openai', keyHash: sha256('X'), origBaseURL: 'https://b-up/v1' },
      ],
      router: { port: 8787 },
    },
  });
  const r = s.run();
  const after = s.read();
  const hashes = after.providers.map((p) => p.keyHash);
  ok('unchanged 占位：不产生重复 keyHash', new Set(hashes).size === hashes.length, `实际 ${JSON.stringify(hashes.map((h) => h.slice(0, 6)))}`);
  eq('unchanged 占位：a 换成新 key', after.providers.find((p) => p.id === 'a').keyHash, sha256('Y'));
  eq('unchanged 占位：b 保持原 key', after.providers.find((p) => p.id === 'b').keyHash, sha256('X'));
}

// —— 16. 三个供应商里两个要改成同一 key：只让第一个改，另一个进 conflict ——
{
  const s = scenario({
    providerOrder: ['a', 'b', 'c'],
    providerRules: [
      { providerId: 'a', providerName: 'A', config: { access: { apiKey: 'Y' }, api: { baseUrl: PROXY } } },
      { providerId: 'b', providerName: 'B', config: { access: { apiKey: 'X' }, api: { baseUrl: PROXY } } },
      { providerId: 'c', providerName: 'C', config: { access: { apiKey: 'X' }, api: { baseUrl: PROXY } } },
    ],
    headroom: {
      providers: [
        { id: 'a', name: 'A', upstream: 'https://a-up/v1', format: 'openai', keyHash: sha256('X'), origBaseURL: 'https://a-up/v1' },
        { id: 'b', name: 'B', upstream: 'https://b-up/v1', format: 'openai', keyHash: sha256('X'), origBaseURL: 'https://b-up/v1' },
        { id: 'c', name: 'C', upstream: 'https://c-up/v1', format: 'openai', keyHash: sha256('Z'), origBaseURL: 'https://c-up/v1' },
      ],
      router: { port: 8787 },
    },
  });
  const r = s.run();
  const after = s.read();
  const hashes = after.providers.map((p) => p.keyHash);
  ok('三方冲突：不产生重复 keyHash', new Set(hashes).size === hashes.length, `实际 ${JSON.stringify(hashes.map((h) => h.slice(0, 6)))}`);
  ok('三方冲突：后改的一方进 conflict', r.pending.some((x) => x.reason === 'key-conflict'), JSON.stringify(r.pending));
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
