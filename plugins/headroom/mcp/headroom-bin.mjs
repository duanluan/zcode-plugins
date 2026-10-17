// headroom 可执行文件定位：PATH 优先（桌面启动的 ZCode 常缺用户级 PATH），兜底扫常见安装位置。
// 逻辑与 launch.mjs 内的一致；抽出来给 ui-server.mjs 复用（launch.mjs 保持独立不动）。

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, platform } from 'node:os';

export function findHeadroom() {
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
