#!/usr/bin/env node
// SessionStart：rtk 升级后官方提示词（~/.claude/RTK.md）可能变化，
// 与 ~/.zcode/AGENTS.md 中同步块不一致时自动重同步。静默、幂等、fail-open。
// （跨平台 node 实现，移植自 sync-rtk-prompt.sh 的内嵌 python）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

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
    const inner = endIdx >= 0 ? rest.slice(0, endIdx) : rest;
    if (inner.trim() === body) process.exit(0); // 已一致，不写盘
    const post = endIdx >= 0 ? rest.slice(endIdx + end.length) : '';
    next = pre + start + '\n' + body + '\n' + end + post;
  } else {
    next = (old.trim() ? old.replace(/\s+$/, '') + '\n\n' : '') + start + '\n' + body + '\n' + end + '\n';
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, next, 'utf8');
} catch { /* 一切异常静默放行（fail-open） */ }
process.exit(0);
