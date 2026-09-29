#!/usr/bin/env node
// zcode-vision UserPromptSubmit 钩子：主模型收不到图片时（例如 glm-5.3 不支持图片输入），
// 把本轮消息里的图片交给可配置的视觉代理链识别（默认用 GLM 订阅 key 直连 glm-5.3-flash，
// 不跟随会话供应商；代理可设 useProvider 跟随当前会话供应商或指定供应商），
// 识别文字以 additionalContext 注入本轮对话。识别不改写消息、不阻断，失败只在注入文本里说明。
// 共享逻辑在 vision-lib.mjs（vision-mcp.mjs 的追问工具同用一份）。
//
// 直接运行（/vision test 用）：node vision-hook.mjs --test [图片路径]
//   不给路径则取最近会话目录里最新的一张图。
//
// 约定：
// - 钩子拿不到会话所用模型，无法只在「主模型不支持图片」时触发；有图片附件即识别注入。
// - 配置唯一事实来源 ~/.zcode/zcode-vision.json（/vision-* 命令与 zcode-pro 面板编辑同一文件）。

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_PROMPT,
  IMAGE_CACHE_ROOT,
  callProxy,
  loadConfig,
  resolveChainProxies,
  runChain,
  sniffMime,
} from './vision-lib.mjs';

// 钩子总超时 180s（hooks.json），留 15s 余量自行收尾，避免被强杀后一点输出都没有
const OVERALL_DEADLINE_MS = 165000;

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
  const lines = [
    `[zcode-vision] 用户本轮发送了 ${results.length} 张图片（钩子无法感知主模型是否支持图片）。` +
      `以下为视觉代理${models.size ? `（${[...models].join(' → ')}）` : ''}生成的识别文字，请当作图片内容使用：`,
    '',
  ];
  results.forEach((r, i) => {
    lines.push(`[图${i + 1} · ${r.file}${r.cached ? ' · 缓存命中' : ''}]`);
    if (r.desc) lines.push(r.desc.trim());
    else lines.push(`（识别失败：${(r.errors || []).join('；') || '未知原因'}——可请用户改用文字描述，或 /vision status 检查配置）`);
    lines.push('');
  });
  // 图片完整路径在上面已随 [图N] 给出；追问细节优先走 vision_ask 工具（模型可自主调用）
  lines.push('（对任一图片需要更多细节时，可调用 vision_ask 工具：传入该图片的完整路径与你的问题，对原图定向追问，无需请用户重发图片。）');
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

  const { loadCache, saveCache, chainFingerprint } = await import('./vision-lib.mjs');
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
    const { createHash } = await import('node:crypto');
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
      (await import('./vision-lib.mjs')).log(`识别失败 ${file}: ${errors.join(' | ')}`);
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
  import('./vision-lib.mjs').then((lib) => lib.log(`未捕获异常：${e?.stack || e}`));
  if (process.argv.includes('--test')) {
    console.error(`测试失败：${e?.message || e}`);
    process.exit(1);
  }
  process.exit(0);
});
