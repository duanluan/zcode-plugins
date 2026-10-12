#!/usr/bin/env node
// MCP 服务启动器（跨平台）：找到 headroom 本体后优先经 bridge.mjs 单例桥启动
// `headroom mcp serve`，桥不可用时直接启动本体。替代旧版 .mcp.json 里的 /bin/sh -c
// 包装（Windows 无 /bin/sh；桌面启动的 ZCode 环境往往不含用户级 PATH，故主动按
// 常见位置查找）。找不到 headroom 时退出码 127。
//
// 由 .mcp.json 以 `node ${ZCODE_PLUGIN_ROOT}/mcp/launch.mjs` 拉起，stdio 即 MCP 传输层。

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const mcpDir = dirname(fileURLToPath(import.meta.url));

const bin = findHeadroom();
if (!bin) {
  console.error('headroom 未安装：请先 pip/uv 安装 headroom-ai（见 /hr-setup），再重启会话');
  process.exit(127);
}

const bridge = join(mcpDir, 'bridge.mjs');
// 单例桥：多会话复用同一份 mcp serve（桥不可用时直接启动本体）
const [command, argv] = existsSync(bridge)
  ? [process.execPath, [bridge, '--', bin, 'mcp', 'serve']]
  : [bin, ['mcp', 'serve']];
// windowsHide：Windows 上 headroom.exe 是控制台程序，不隐藏会弹黑窗
const child = spawn(command, argv, { stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* ignore */ } });
}
child.on('error', (err) => { console.error(String(err?.message || err)); process.exit(1); });
child.on('close', (code) => process.exit(code ?? 1));

// 按可执行性在 PATH 里找 headroom（桌面应用的环境常缺用户级 PATH，手动补常见位置）。
// Windows 只认 .exe：.bat/.cmd 直接 spawn 会抛 EINVAL（Node 18+ 安全限制）。
function findHeadroom() {
  const names = platform() === 'win32' ? ['headroom.exe'] : ['headroom'];
  const isExec = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p) && isExec(p)) return p;
    }
  }
  const home = homedir();
  const candidates = platform() === 'win32'
    ? [
        join(home, '.local', 'bin', 'headroom.exe'),
        join(home, 'miniforge3', 'Scripts', 'headroom.exe'),
        join(home, 'miniconda3', 'Scripts', 'headroom.exe'),
        join(home, 'anaconda3', 'Scripts', 'headroom.exe'),
        join(home, '.cargo', 'bin', 'headroom.exe'),
      ]
    : [
        join(home, '.local', 'bin', 'headroom'),
        join(home, 'miniforge3', 'bin', 'headroom'),
        join(home, '.cargo', 'bin', 'headroom'),
        '/usr/local/bin/headroom',
        '/usr/bin/headroom',
      ];
  return candidates.find((p) => existsSync(p) && isExec(p)) || null;
}
