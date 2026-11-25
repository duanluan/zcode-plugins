#!/usr/bin/env node
// 组装后的补漏：公共构建器在复制时按文件名排除 package.json（那是为了去掉插件自己的
// 源码清单），但 vendor/ 里上游包的 package.json 是运行时资产——上游用它读自己的版本号
// （lib/mcp_server.js 的 packageVersion()），缺了会让 serverInfo.version 变成 0.0.0。
// 这里把它补回产物目录。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const src = process.env.PLUGIN_SRC_DIR;
const out = process.env.PLUGIN_OUT_DIR;
if (!src || !out) {
  console.error('需要 PLUGIN_SRC_DIR 与 PLUGIN_OUT_DIR');
  process.exit(1);
}

const from = path.join(src, 'vendor', 'dsh-free-search', 'package.json');
if (!existsSync(from)) {
  console.error(`缺少上游包清单：${from}`);
  process.exit(1);
}
const to = path.join(out, 'vendor', 'dsh-free-search', 'package.json');
mkdirSync(path.dirname(to), { recursive: true });
copyFileSync(from, to);
console.log('✓ vendor/dsh-free-search/package.json 已补回产物');
