// rtk 可执行文件定位（共享模块）：hooks/rtk-pretooluse.mjs 与 mcp/rtk-ui.mjs 共用。
// 桌面启动的 ZCode 环境可能不含用户级 PATH（~/.local/bin 等），PATH 找不到时扫描常见安装位置。
// Windows 只认 rtk.exe（.bat/.cmd 直接 spawn 会抛 EINVAL，Node 18+ 安全限制）。

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir, platform } from 'node:os';

export function findRtk() {
  const win = platform() === 'win32';
  const names = win ? ['rtk.exe'] : ['rtk'];
  const isExec = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  const dirs = String(process.env.PATH || '').split(delimiter).filter(Boolean);
  const home = homedir();
  dirs.push(join(home, '.local', 'bin'), join(home, 'miniforge3', 'bin'), '/usr/local/bin', '/usr/bin');
  if (win) dirs.push(join(home, '.cargo', 'bin'), join(home, '.local', 'share', 'rtk', 'bin'));
  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (existsSync(p) && isExec(p)) return p;
    }
  }
  return null;
}
