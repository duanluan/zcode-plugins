#!/usr/bin/env node
// ocr-ui MCP 服务（UI Plugin）：为评审结果提供内嵌卡片页面。
// /ocr-delegate-review 的评审意见本来只存在于对话文本里；本服务提供 ocr_render_review
// 工具让模型把结构化评审条目（finding）写入数据目录，工具结果附 _meta.ui 指向
// ui://open-code-review/panel.html——桌面端展示可交互面板（分组、勾选已处理、
// 未处理项交回对话）；文本输出同时保留全部意见（ADR-0003，旧客户端不受影响）。
// 协议：stdio 上的 MCP（JSON-RPC 2.0，按行分隔），手写实现。

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_INFO = { name: 'ocr-ui', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
const PANEL_URI = 'ui://open-code-review/panel.html';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 宿主提供插件数据目录（.mcp.json 里注入 ${ZCODE_PLUGIN_DATA}）；没给时落到用户目录
const DATA_DIR = process.env.ZCODE_PLUGIN_DATA || path.join(homedir(), '.zcode', 'open-code-review-ui');

const SEVERITIES = ['high', 'medium', 'low'];
const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };

const TOOLS = [
  {
    name: 'ocr_render_review',
    description:
      '把结构化代码评审结果渲染成可交互面板（桌面端 ZCode ≥ 3.15.1 展示；旧客户端读文本输出，内容一致）。' +
      '评审（如 /ocr-delegate-review）产出意见后调用本工具，用户可在面板里按严重级查看、勾选已处理、把未处理项交回对话。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '评审标题（如「fix-login 分支评审」），可选' },
        ref: { type: 'string', description: '评审范围（如 commit sha、分支名、工作区），可选' },
        findings: {
          type: 'array',
          description: '评审条目列表',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: '文件路径' },
              line: { type: 'number', description: '行号（可省）' },
              severity: { type: 'string', enum: SEVERITIES, description: '严重级：high=明显 bug/安全/数据丢失，medium=合理担忧/性能建议，low=疑似误报' },
              summary: { type: 'string', description: '一句话结论' },
              detail: { type: 'string', description: '详细说明与修复建议（可省）' },
            },
            required: ['file', 'severity', 'summary'],
          },
        },
      },
      required: ['findings'],
    },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['model', 'app'] } },
  },
  {
    name: 'ocr_get_review',
    description: '读取已渲染的评审结果（默认最近一次），供面板恢复显示（只给页面用）。',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: { type: 'string', description: '评审 ID（缺省取最近一次）' },
      },
    },
    _meta: { ui: { visibility: ['app'] } },
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: 'ocr 评审面板', mimeType: 'text/html;profile=mcp-app', description: '按严重级分组展示评审条目，勾选已处理，未处理项可交回对话' },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 校验并规整一条 finding；不合规则返回 { error }
function normalizeFinding(raw, idx) {
  if (!raw || typeof raw !== 'object') return { error: `findings[${idx}] 不是对象` };
  const file = String(raw.file || '').trim();
  const summary = String(raw.summary || '').trim();
  const severity = String(raw.severity || '').trim();
  if (!file) return { error: `findings[${idx}].file 缺失` };
  if (file.length > 512) return { error: `findings[${idx}].file 超长（>512 字符）` };
  if (!summary) return { error: `findings[${idx}].summary 缺失` };
  if (summary.length > 500) return { error: `findings[${idx}].summary 超长（>500 字符）` };
  if (!SEVERITIES.includes(severity)) return { error: `findings[${idx}].severity 必须是 ${SEVERITIES.join('/')}` };
  const line = Number(raw.line);
  const detail = raw.detail === undefined || raw.detail === null ? '' : String(raw.detail);
  if (detail.length > 8000) return { error: `findings[${idx}].detail 超长（>8000 字符）` };
  return {
    value: {
      file,
      line: Number.isInteger(line) && line > 0 ? line : null,
      severity,
      summary,
      detail,
    },
  };
}

function reviewText(review) {
  const lines = [
    `评审面板已生成：共 ${review.findings.length} 条` +
      `（高 ${review.counts.high} / 中 ${review.counts.medium} / 低 ${review.counts.low}）` +
      `${review.ref ? `，范围：${review.ref}` : ''}。`,
  ];
  if (review.title) lines.push(`标题：${review.title}`);
  lines.push('');
  for (const sev of SEVERITIES) {
    const group = review.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    lines.push(`【${SEVERITY_LABEL[sev]}】`);
    for (const f of group) {
      lines.push(`- ${f.file}${f.line ? `:${f.line}` : ''} — ${f.summary}`);
      if (f.detail) lines.push(`  ${f.detail.replace(/\r?\n/g, '\n  ')}`);
    }
    lines.push('');
  }
  lines.push('桌面端（≥3.15.1）会在上方展示可交互面板；可在面板勾选已处理、把未处理项交回对话。');
  return lines.join('\n');
}

let latestReviewId = null;

function saveReview(review) {
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, `${review.id}.json`), JSON.stringify(review));
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify({ id: review.id }));
  latestReviewId = review.id;
  // 只保留最近 20 份，旧的清掉（评审 id 是"毫秒时间戳 base36 + 随机串"，字母开头，
  // 按字典序排即时间序；latest.json 索引文件与 .bak 备份不参与）
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => !f.endsWith('.bak') && f !== 'latest.json' && /^[a-z0-9]{8,}\.json$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - 20))) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* ignore */ }
  }
}

function loadReview(idWanted) {
  try {
    const id = idWanted || latestReviewId || JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'latest.json'), 'utf8')).id;
    const file = path.join(DATA_DIR, `${id}.json`);
    if (!/^[a-z0-9]+$/i.test(id) || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function handleCall(name, args) {
  if (name === 'ocr_render_review') {
    const rawFindings = Array.isArray(args?.findings) ? args.findings : [];
    if (rawFindings.length === 0) return textResult('findings 不能为空（至少一条评审条目）', true);
    if (rawFindings.length > 200) return textResult(`findings 太多（${rawFindings.length} 条，上限 200）`, true);
    const findings = [];
    for (let i = 0; i < rawFindings.length; i++) {
      const r = normalizeFinding(rawFindings[i], i);
      if (r.error) return textResult(r.error, true);
      findings.push(r.value);
    }
    findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of findings) counts[f.severity] += 1;
    const review = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      title: String(args?.title || '').slice(0, 200),
      ref: String(args?.ref || '').slice(0, 200),
      createdAt: new Date().toISOString(),
      counts,
      findings,
    };
    saveReview(review);
    return {
      content: [{ type: 'text', text: reviewText(review) }],
      structuredContent: { reviewId: review.id, title: review.title, ref: review.ref, counts, findings },
    };
  }
  if (name === 'ocr_get_review') {
    const review = loadReview(String(args?.reviewId || '').trim() || undefined);
    if (!review) return textResult('没有已保存的评审结果（先让模型调 ocr_render_review）', true);
    // 统一补 reviewId 字段（存储文件里的主键叫 id），页面按它匹配勾选状态
    return { content: [{ type: 'text', text: 'ok' }], structuredContent: { reviewId: review.id, ...review } };
  }
  return textResult(`未知工具：${name}`, true);
}

async function dispatch(msg) {
  const { id, method } = msg;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      return rpcResult(id, await handleCall(msg.params?.name, msg.params?.arguments));
    } catch (e) {
      return rpcResult(id, textResult(`调用失败：${e?.message || e}`, true));
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
        return rpcError(id, -32002, `页面资源读取失败（${
          fs.existsSync(file) ? '权限/IO 错误' : '产物缺失，请在插件仓库跑 pnpm build 后重装插件'
        }）：${e?.message || e}`);
      }
    }
    return rpcError(id, -32002, `未知资源：${uri}`);
  }
  if (method === 'ping') return rpcResult(id, {});
  if (id === undefined || id === null) return null;
  return rpcError(id, -32601, `method not found: ${method}`);
}

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
    void dispatch(msg).then((resp) => {
      if (resp) process.stdout.write(`${JSON.stringify(resp)}\n`);
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
