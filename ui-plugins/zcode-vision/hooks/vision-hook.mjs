#!/usr/bin/env node
// zcode-vision UserPromptSubmit 钩子：主模型收不到图片时（例如 glm-5.3 不支持图片输入），
// 把本轮消息里的图片交给可配置的视觉代理链识别（默认单级：跟随当前会话所用供应商，
// 模型用会话当前模型或首选视觉模型映射；代理可用 useProvider 改为指定供应商，或自带
// baseUrl/key 直连）。默认 tool 模式注入指路文本、识别由模型调 vision_ask 完成（结果卡片
// 对用户可见）；interceptMode=inject 时后台预跑识别、全文以 additionalContext 注入本轮对话。
// 识别不改写消息、不阻断，失败只在注入文本里说明。
// 共享逻辑在 vision-lib.mjs（vision-mcp.mjs 的追问工具同用一份）。
//
// 直接运行（/vision test 用）：node vision-hook.mjs --test [图片路径]
//   不给路径则取最近会话目录里最新的一张图。
//
// 约定：
// - 主模型名从任务索引反查（tasks.model = "<providerId>/<modelId>"），按名字猜能力：
//   flash 小模型不触发（识别就是它自己）；能看图的主模型看 forceIntercept 选项（默认照常识别注入）。
// - 配置唯一事实来源 ~/.zcode/zcode-vision.json（/vision-* 命令与 zcode-pro 面板编辑同一文件）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMAGE_CACHE_ROOT,
  compressThresholdBytesOf,
  loadCache,
  loadConfig,
  log,
  saveCache,
  chainFingerprint,
  prepareImage,
  resolveChainProxies,
  runChain,
  sessionModelId,
  skipByMainModel,
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

// tool 模式：不在后台预跑识别，只注入指路文本让模型调 vision_ask——识别结果以工具
// 卡片展示给用户（钩子注入的纯文字不进界面，这是 ZCode 的显示规则，见 vision-lib）
function buildPointerContext(files) {
  const lines = [
    `[zcode-vision] 用户本轮发送了 ${files.length} 张图片。图片内容尚未识别：请先调用 vision_ask 工具识别，再回答用户的问题。`,
    '',
  ];
  files.forEach((f, i) => {
    lines.push(`[图${i + 1} · ${f}]`);
    lines.push(`调用参数：image_path="${f}"，question="请识别这张图片的全部内容"（固定问法，同图重发可命中缓存）。`);
  });
  lines.push('（识别结果会以卡片展示给用户，用户可展开查看；不要仅凭文件名猜测图片内容，也不要要求用户重发图片。）');
  return { additionalContext: lines.join('\n') };
}

function buildContext(results, models) {
  const ok = results.filter((r) => r.desc);
  const lines = [
    `[zcode-vision] 用户本轮发送了 ${results.length} 张图片。` +
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

  // 主模型感知：flash 小模型不触发（识别就是它自己，注入描述纯属重复）；
  // 其他能看图的主模型看 forceIntercept（默认 true = 照常拦截识别注入）
  const mainModel = sessionModelId(payload.session_id);
  if (skipByMainModel(cfg, mainModel)) {
    log(`主模型 ${mainModel || '未知'}：按规则跳过识别注入`);
    process.exit(0);
  }

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

  // tool 模式（默认）：钩子只做检测与指路，识别交给 vision_ask 工具——结果卡片对用户可见
  if (cfg.interceptMode !== 'inject') {
    process.stdout.write(JSON.stringify(buildPointerContext(uniq)));
    process.exit(0);
  }

  const cache = loadCache();
  const chainProxies = await resolveChainProxies(cfg, payload.session_id);
  const fp = chainFingerprint(chainProxies);
  const results = [];
  const models = new Set();
  for (const file of uniq) {
    if (Date.now() - started > OVERALL_DEADLINE_MS) {
      results.push({ file, desc: '', errors: ['超出钩子时间预算，本轮跳过'], cached: false });
      continue;
    }
    let buf;
    let mime;
    try {
      ({ buf, mime } = await prepareImage(file, compressThresholdBytesOf(cfg)));
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
    const { desc, used, errors } = await runChain(cfg, chainProxies, buf, mime);
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
// 内置测试图（320x120 PNG，灰底黑字“zcode-vision test / OK 1016”）：本机从没发过
// 图片时 image-cache 目录不存在或为空，测试按钮用它兜底，任何机器开箱可测
const TEST_IMAGE_B64 = [
    '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'
    ].join('');

function builtinTestImage() {
  const p = path.join(IMAGE_CACHE_ROOT, '..', 'zcode-vision-test.png');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(TEST_IMAGE_B64, 'base64'));
  } catch { /* 写不进就退 tmp */ return writeTmpTestImage(); }
  return p;
}

function writeTmpTestImage() {
  const p = path.join(fs.realpathSync?.(process.env.TMPDIR || '.') , 'zcode-vision-test.png');
  fs.writeFileSync(p, Buffer.from(TEST_IMAGE_B64, 'base64'));
  return p;
}

async function runTest(givenFile) {
  const cfg = loadConfig();
  let file = givenFile;
  if (!file) {
    // 目录不存在按空处理（readdirSync 会 ENOENT 崩掉）
    const sessions = fs.existsSync(IMAGE_CACHE_ROOT)
      ? fs
          .readdirSync(IMAGE_CACHE_ROOT)
          .filter((d) => d.startsWith('sess_'))
          .map((d) => path.join(IMAGE_CACHE_ROOT, d))
          .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
      : [];
    const all = sessions.flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => /^image-/.test(f))
        .map((f) => ({ p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })),
    );
    all.sort((a, b) => b.m - a.m);
    file = all[0]?.p || builtinTestImage();
  }
  if (!file || !fs.existsSync(file)) {
    console.error('未找到可用测试图片（可指定路径：--test <图片路径>）');
    process.exit(1);
  }
  console.error(`测试图片：${file}`);
  console.error(`链：${(cfg.chain || []).join(cfg.chainMode === 'pipeline' ? ' → ' : ' ⤵ 失败则 ')}`);
  const chainProxies = await resolveChainProxies(cfg, null);
  const { buf, mime } = await prepareImage(file, compressThresholdBytesOf(cfg));
  const t0 = Date.now();
  const { desc, used, errors } = await runChain(cfg, chainProxies, buf, mime);
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
