#!/usr/bin/env node
// SessionStart：rtk 升级后官方提示词（~/.claude/RTK.md）可能变化，
// 与 ~/.zcode/AGENTS.md 中同步块不一致时自动重同步。静默、幂等、fail-open。
// （跨平台 node 实现，移植自 sync-rtk-prompt.sh 的内嵌 python）

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// 取 rtk 同步块之外的内容（前后两段拼起来），用来比对用户是否同时在编辑
function outsideBlock(text, start, end) {
  const i = text.indexOf(start);
  if (i < 0) return text;
  const rest = text.slice(i + start.length);
  const j = rest.indexOf(end);
  return text.slice(0, i) + (j >= 0 ? rest.slice(j + end.length) : '');
}

try {
  const src = path.join(homedir(), '.claude', 'RTK.md');
  if (!existsSync(src)) process.exit(0);
  const dst = path.join(homedir(), '.zcode', 'AGENTS.md');
  const body = readFileSync(src, 'utf8').trim();
  const start = '<!-- rtk:start -->';
  const end = '<!-- rtk:end -->';
  const old = existsSync(dst) ? readFileSync(dst, 'utf8') : '';
  let next;
  if (old.includes(start)) {
    const pre = old.slice(0, old.indexOf(start));
    const rest = old.slice(old.indexOf(start) + start.length);
    const endIdx = rest.indexOf(end);
    // 只剩开头标记（结束标记缺失，如手编删掉或被截断）：放弃本次同步——
    // 把标记之后的全部内容当同步块替换掉会吃掉用户内容（与 sh 版同款保护）
    if (endIdx < 0) process.exit(0);
    const inner = rest.slice(0, endIdx);
    if (inner.trim() === body) process.exit(0); // 已一致，不写盘
    const post = rest.slice(endIdx + end.length);
    next = pre + start + '\n' + body + '\n' + end + post;
  } else {
    next = (old.trim() ? old.replace(/\s+$/, '') + '\n\n' : '') + start + '\n' + body + '\n' + end + '\n';
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  // 写前重读一次：同步块之外的内容若和读时不一样（用户同时在编辑），放弃本次同步
  const fresh = existsSync(dst) ? readFileSync(dst, 'utf8') : '';
  if (outsideBlock(fresh, start, end) !== outsideBlock(old, start, end)) {
    console.error('[sync-rtk-prompt] AGENTS.md 同步块之外的内容在同步期间被改动，放弃本次同步');
    process.exit(0);
  }
  // 原子写：临时文件写完再改名，别的进程不会读到半截文件。改名目标取真实路径——
  // 直接 rename 到 dst 会把符号链接本身替换成普通文件（dotfiles 管理的链接会丢）
  let real = dst;
  try { real = realpathSync(dst); } catch { /* 文件还不存在：直接写 dst */ }
  const tmp = `${real}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, real);
} catch { /* 一切异常静默放行（fail-open） */ }
process.exit(0);
