#!/usr/bin/env node
// 把 ui-plugins/<名>/ 源码组装成 plugins/<名>/ 安装产物（对齐上游 zai-org/zcode-plugins 结构）。
//
// 规则：
// - 根 marketplace.json 条目、plugins/<名>/.zcode-plugin/plugin.json、ui-plugins/<名>/package.json
//   三处版本号必须完全一致，不一致直接失败。
// - 复制时排除源码开发文件（ui/、scripts/、package.json、tsconfig.json、锁文件、node_modules/）。
// - 插件若有 scripts/build.mjs（如页面构建），复制后以插件目录为 cwd 执行，
//   环境变量 PLUGIN_OUT_DIR 指向 plugins/<名>/，构建产物（dist/）写在那里。
// - 产物目录最后写入 build-info.json 作为完成标记。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.join(root, "ui-plugins");
const OUT_ROOT = path.join(root, "plugins");

// 不进安装产物的源码开发文件/目录（相对插件源码根的名字）
const EXCLUDE_NAMES = new Set([
  "node_modules",
  "ui",
  "scripts",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  ".DS_Store",
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const marketplace = readJson(path.join(root, "marketplace.json"));
const marketVersions = new Map(marketplace.plugins.map((p) => [p.name, p.version]));

const names = fs
  .readdirSync(SRC_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (names.length === 0) {
  console.error("ui-plugins/ 下没有插件源码");
  process.exit(1);
}

const failed = [];
for (const name of names) {
  const src = path.join(SRC_ROOT, name);
  const out = path.join(OUT_ROOT, name);

  // 三处版本号一致性校验
  const marketVer = marketVersions.get(name);
  if (!marketVer) {
    console.error(`✗ ${name}：根 marketplace.json 里没有这个插件的条目`);
    failed.push(name);
    continue;
  }
  const srcPkgPath = path.join(src, "package.json");
  const manifestPath = path.join(src, ".zcode-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`✗ ${name}：缺少 .zcode-plugin/plugin.json`);
    failed.push(name);
    continue;
  }
  const srcVer = readJson(srcPkgPath).version;
  const manifestVer = readJson(manifestPath).version;
  if (!(marketVer === srcVer && srcVer === manifestVer)) {
    console.error(
      `✗ ${name}：三处版本号不一致（marketplace=${marketVer} 源码 package.json=${srcVer} plugin.json=${manifestVer}）`,
    );
    failed.push(name);
    continue;
  }

  // 清空重建产物目录（plugins/marketplace.json 等仓库级文件不在插件目录内，不受影响）
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(src, out);

  // 页面构建：ui/panel.ts + ui/panel.html → dist/panel.html（esbuild 打包 + 内联成单文件）
  const pageTs = path.join(src, "ui", "panel.ts");
  const pageHtml = path.join(src, "ui", "panel.html");
  if (fs.existsSync(pageTs) || fs.existsSync(pageHtml)) {
    if (!(fs.existsSync(pageTs) && fs.existsSync(pageHtml))) {
      console.error(`✗ ${name}：ui/ 下 panel.ts 与 panel.html 必须同时存在`);
      failed.push(name);
      continue;
    }
    const esbuild = await import("esbuild");
    const built = await esbuild.build({
      entryPoints: [pageTs],
      bundle: true,
      format: "iife",
      target: "es2022",
      minify: true,
      charset: "utf8",
      write: false,
      legalComments: "none",
      logLevel: "silent",
    });
    const js = built.outputFiles.map((f) => f.text).join("\n");
    const html = fs.readFileSync(pageHtml, "utf8");
    const marker = "/*__APP_JS__*/";
    if (!html.includes(marker)) {
      console.error(`✗ ${name}：ui/panel.html 里缺少 /*__APP_JS__*/ 内联占位符`);
      failed.push(name);
      continue;
    }
    fs.mkdirSync(path.join(out, "dist"), { recursive: true });
    // replace 传函数：js 里的 $&、$1 之类不能被当替换模式解释
    fs.writeFileSync(path.join(out, "dist", "panel.html"), html.replace(marker, () => js));
  }

  // 插件自带构建（页面打包等）
  const pluginBuild = path.join(src, "scripts", "build.mjs");
  if (fs.existsSync(pluginBuild)) {
    const res = spawnSync("node", ["scripts/build.mjs"], {
      cwd: src,
      stdio: "inherit",
      env: { ...process.env, PLUGIN_OUT_DIR: out, PLUGIN_SRC_DIR: src },
    });
    if (res.status !== 0) {
      console.error(`✗ ${name}：scripts/build.mjs 失败（退出码 ${res.status}）`);
      failed.push(name);
      continue;
    }
  }

  // 完成标记（上游同款）
  fs.writeFileSync(
    path.join(out, "build-info.json"),
    JSON.stringify({ name, version: srcVer, builtAt: new Date().toISOString(), source: `../../ui-plugins/${name}` }, null, 2) + "\n",
  );
  console.log(`✓ ${name} ${srcVer} → plugins/${name}/`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} 个插件构建失败：${failed.join("、")}`);
  process.exit(1);
}
