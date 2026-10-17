#!/usr/bin/env node
// 生成本地市场目录 dist/local-marketplace/：marketplace.json + plugins/ 构建产物。
// 用途：整份拷到别的机器（如 Windows 虚拟机），在 ZCode 插件市场「新增」里填该目录的
// 绝对路径，即可不推送 GitHub 直接安装测试。市场名保持 duanluan-zcode-plugins 不变，
// 之后该机器改从 GitHub 市场源更新时，插件安装身份可以延续，不会出现两份安装。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "local-marketplace");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, "marketplace.json"), path.join(out, "marketplace.json"));
fs.cpSync(path.join(root, "plugins"), path.join(out, "plugins"), { recursive: true });

console.log(`✓ 本地市场已生成：${out}`);
console.log("  先 pnpm build 再跑本脚本可带上最新产物；整份目录拷到目标机器后，");
console.log("  在 ZCode 插件市场「新增」里填该目录的绝对路径即可安装。");
