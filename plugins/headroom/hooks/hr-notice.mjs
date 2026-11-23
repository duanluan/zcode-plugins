#!/usr/bin/env node
// SessionStart 钩子：把上一轮供应商登记对账的结果告诉模型，由模型在会话开头转达用户。
//
// 必须做成独立钩子条目：SessionStart 钩子只有在 stdout 整段以 { 开头时才按 JSON 解析
// （ZCode 的 parseHookStdout），而 ensure-proxy.mjs 的 stdout 是人读状态行，混在一起
// 会让整个 JSON 失效。这里只在有结果时输出一行合法 JSON，否则静默退出 0。
//
// 输出格式（SessionStart 认可的写法）：
//   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { noticeFile } from './hr-reconcile.mjs';

// 提示有效期：超过这个时间的结果不再转达（旧会话恢复时别翻出几天前的记录）
const MAX_AGE_MS = 10 * 60 * 1000;

function readNotice() {
  const file = noticeFile();
  if (!existsSync(file)) return null;
  try {
    const n = JSON.parse(readFileSync(file, 'utf8'));
    const at = Date.parse(n?.at);
    if (!Number.isFinite(at) || Date.now() - at > MAX_AGE_MS) return null;
    return n;
  } catch {
    return null;
  }
}

// 生成给模型看的一段说明；没有问题返回空串
export function noticeText(n) {
  if (!n) return '';
  const fixed = Array.isArray(n.fixed) ? n.fixed : [];
  const pending = Array.isArray(n.pending) ? n.pending : [];
  if (!fixed.length && !pending.length) return '';

  const lines = ['headroom 供应商登记对账结果（本次会话启动时自动执行）：'];
  if (fixed.length) {
    const items = fixed.map((x) => (x.action === 'key'
      ? `${x.name}：密钥已变更，已更新本地路由登记`
      : `${x.name}：已补登记本地路由`));
    lines.push(`- 已自动修复：${items.join('；')}`);
  }
  if (pending.length) {
    const names = pending.map((x) => x.name).join('、');
    const conflict = pending.some((x) => x.reason === 'key-conflict');
    lines.push(`- 需要用户处理：${names} 指向本地压缩路由但无法自动登记${conflict ? '（有供应商与其他条目共用同一密钥，路由会分不清，需换成各自的密钥）' : ''}。告诉用户运行 /hr-join 接入，不要自行执行命令。`);
  }
  lines.push('以上无需再次执行，只需向用户简要说明结果。');
  return lines.join('\n');
}

function main() {
  const n = readNotice();
  const text = noticeText(n);
  if (!text) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch {
    // 钩子任何失败都不该挡住会话启动
  }
  // 用 exitCode 而不是 process.exit()：后者在 stdout 是管道时会截断未 flush 的缓冲，
  // 提示内容一长（多个供应商）就变成不完整 JSON，ZCode 解析失败后整条静默丢弃
  process.exitCode = 0;
}
