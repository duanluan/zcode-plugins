#!/usr/bin/env node
// PreToolUse(Bash) 钩子（跨平台 node 实现，移植自 rtk-pretooluse.sh）：
// 把"是否值得改写"完全交给 rtk 自己判断（rtk rewrite 是官方声明的 hooks 唯一
// 事实来源），本脚本只负责把改写结果以 deny 提示的形式递给模型（ZCode 钩子
// schema 不支持 updatedInput 改写，deny-with-suggestion 与 rtk 官方对 Copilot
// CLI 的做法一致）。
// 契约：stdin 收到 hook JSON；exit 0 = 放行；exit 2 = 拦截，stderr 作为提示传给模型。
// 同一会话同一条命令最多提醒（拦截）一次：首次拦截给出 rtk 改写建议，原样重跑即放行，
// 兑现"仅是提醒"的承诺。提醒记录存 ${RTK_DIR:-~/.zcode-rtk}/reminded/<hash>，超 128 条清最旧一半。
// fail-open：rtk 未装、解析失败、模式 off、已套 rtk、命令已限量（管道接 head/tail/
// wc/grep/awk/sed -n，或单独使用 head/tail/wc/sed -n）、输出进文件/变量、
// 下载到文件（wget 恒如此；curl 带 -o/-O/--output）、输出已丢弃（裸 >/dev/null）、
// 低价值命令（纯副作用或输出极小，如 git add/commit/push、mkdir/cp 等，整条命令
// 逐段全命中才放行）时一律放行。

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path, { delimiter } from 'node:path';
import { homedir, platform } from 'node:os';
import process from 'node:process';

const WIN = platform() === 'win32';
const HOME = homedir();
const stateDir = process.env.RTK_DIR || path.join(HOME, '.zcode-rtk');

const GIT_MUTATIONS = new Set(['add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch',
  'restore', 'stash', 'reset', 'merge', 'rebase', 'cherry-pick', 'apply', 'am', 'clean', 'init']);
const PLAIN_MUTATIONS = new Set(['mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod', 'chown',
  'kill', 'cd', 'export', 'sleep', 'true', 'false', 'unset']);

let input = '';
try { input = readFileSync(0, 'utf8'); } catch { /* stdin 读不到 → 放行 */ }
if (!input.trim()) process.exit(0);

const cmd = (() => {
  try { return String((JSON.parse(input).tool_input || {}).command || ''); } catch { return ''; }
})();
if (!cmd) process.exit(0);

// 定位 rtk：桌面启动的 ZCode 环境可能不含用户级 PATH（~/.local/bin 等），
// PATH 找不到时扫描常见安装位置；仍找不到则放行（fail-open）。
// Windows 只认 rtk.exe（.bat/.cmd 直接 spawn 会抛 EINVAL，Node 18+ 安全限制）。
const RTK = findRtk();
if (!RTK) process.exit(0);

// 模式开关：hint（默认）= 改写建议；off = 完全放行
try {
  const stateFile = path.join(stateDir, 'mode');
  if (!existsSync(stateFile)) { mkdirSync(stateDir, { recursive: true }); writeFileSync(stateFile, 'hint'); }
  if (readFileSync(stateFile, 'utf8').trim() === 'off') process.exit(0);
} catch { /* 状态读不了 → 继续（fail-open 朝提醒方向） */ }

// 已套 rtk（含完整路径）或已管道限量的命令放行
if (/(^|[\s;&|\/])rtk(\s|$)|\|\s*(head|tail|wc|grep|awk|sed -n)\b/.test(cmd)) process.exit(0);

// 输出被当作数据使用时不改写（压缩摘要写进文件/变量会损坏数据）：
// 剔除丢弃 stdout 的重定向（>/dev/null、1>/dev/null）后，剩余仍含重定向或命令替换
// （含 2>/dev/null——stderr 丢弃但 stdout 仍在，按数据用途处理以免误拦）则放行；
// 剔除过说明输出根本不会进上下文，压缩无意义，也放行
const noSink = cmd.replace(/[01]?>+\s*\/dev\/null/g, '');
if (noSink.includes('>') || noSink.includes('$(') || noSink.includes('`')) process.exit(0);
if (noSink !== cmd) process.exit(0);

// 下载到文件的命令 stdout 为空，压缩无意义：wget 恒下载到文件，curl 仅在
// -o/--output/-O 指定输出文件时 → 放行
if (/(^|[\s;&|])wget(\s|$)/.test(cmd)) process.exit(0);
if (/(^|[\s;&|])curl(\s|$)/.test(cmd) &&
    /(^|\s)--output([\s=]|$)|(^|\s)-[a-zA-Z]*o\s|(^|\s)-[a-zA-Z]*O(\s|$)/.test(cmd)) process.exit(0);

// 低价值命令白名单 + 自带限量的读取命令：整条命令每段（按 &&/||/;/换行
// 切分，引号内不切）都命中才放行——拦它们没有任何压缩收益，deny 反而会误导模型把
// 正常命令拆散重跑，或逼它绕路 rtk proxy 重跑。两类命中条件：
// ① 自带限量读取：head/tail/wc、sed -n 段首使用（head -12、sed -n '1,10p' 等），
//    模型已自限输出规模，改写成 rtk read 反而可能丢行；du 带 -s/--summarize
//    时每个对象只出一行，同此；
// ② 低价值命令：git 变更类子命令（add/commit/push/branch 新建删除等，兼容
//    -C/-c/--opt=val 全局前缀）与 mkdir/cp/sleep 等纯副作用命令；git 的列举形态
//    （branch -a、config --list、tag、stash list 等，输出可能很长）除外。
// 用户可在 ${RTK_DIR:-~/.zcode-rtk}/whitelist 追加自定义条目（每行 name 或
// git:name，# 注释，非法行忽略；git:name 不做形态检查，直接放行该子命令）。
// 分词失败或不识别 → 不放行，落回 rtk 判断（与旧版 python 崩溃时行为一致）。
if (allSegmentsPass(cmd, path.join(stateDir, 'whitelist'))) process.exit(0);

// 由 rtk 判断：rc=3 且输出非空 = 有等价改写；rc=1 / 无输出 = rtk 认为不必改写
const rw = spawnSync(RTK, ['rewrite', cmd], { timeout: 8000, encoding: 'utf8', windowsHide: true });
if (rw.status !== 3) process.exit(0);
const rewritten = String(rw.stdout || '').trim();
if (!rewritten || rewritten === cmd) process.exit(0);

// 一次性提醒：本会话同命令提醒过（记录存在）→ 放行；记录写不进去 → 也放行
// （拦一条无法兑现"重跑放行"承诺的命令没有意义）
let session = '';
try { session = String((JSON.parse(input).session_id) || ''); } catch { /* 已在前面解析过，不会到这 */ }
const hash = createHash('sha256').update(`${session}\n${cmd}`).digest('hex');
const remindedDir = path.join(stateDir, 'reminded');
try {
  if (existsSync(path.join(remindedDir, hash))) process.exit(0);
  mkdirSync(remindedDir, { recursive: true });
  writeFileSync(path.join(remindedDir, hash), '');
} catch { process.exit(0); }

// 提醒记录防无限增长：超过 128 条时清掉最旧的一半
try {
  const entries = readdirSync(remindedDir)
    .map((f) => ({ f, m: statSync(path.join(remindedDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (entries.length > 128) {
    for (const { f } of entries.slice(64)) unlinkSync(path.join(remindedDir, f));
  }
} catch { /* 清理失败不影响本次提醒 */ }

process.stderr.write(
  `[rtk] 提醒（不是禁止执行）：这条命令的输出可压缩 60-90%，两种做法任选其一：\n` +
  `  1. 执行等价命令：${rewritten}\n` +
  `  2. 原样重跑本命令：直接放行\n` +
  `同一命令仅提醒一次；/rtk off 可关闭提醒。\n` +
  `压缩结果若缺关键行：先按输出尾部提示 rtk recall <hash> --grep <关键字> 取回（不重跑）；确需完整原文再 rtk proxy <原命令>（会真正重跑）。\n`);
process.exit(2);

// ===========================================================================

function findRtk() {
  const names = WIN ? ['rtk.exe'] : ['rtk'];
  const isExec = (p) => { try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; } };
  const hit = (dirs) => {
    for (const d of dirs) {
      for (const n of names) {
        const p = path.join(d, n);
        if (existsSync(p) && isExec(p)) return p;
      }
    }
    return null;
  };
  // 先 PATH（含桌面应用环境常缺的用户级目录兜底清单），与旧版 sh 的查找顺序一致
  const fromPath = hit(String(process.env.PATH || '').split(delimiter).filter(Boolean));
  if (fromPath) return fromPath;
  const dirs = [path.join(HOME, '.local', 'bin'), path.join(HOME, 'miniforge3', 'bin'), '/usr/local/bin', '/usr/bin'];
  if (WIN) dirs.push(path.join(HOME, '.cargo', 'bin'), path.join(HOME, '.local', 'share', 'rtk', 'bin'));
  return hit(dirs);
}

// —— 命令分段与低价值判定（移植自旧版内嵌 python；语义见上方注释） ——

// 按 &&/||/;/换行切分（引号内不切），与旧版 python split_top 一致
function splitTop(cmdStr) {
  const segs = [];
  let buf = '';
  let q = null;
  for (let i = 0; i < cmdStr.length; i++) {
    const ch = cmdStr[i];
    if (q) {
      buf += ch;
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmdStr.length) { buf += cmdStr[i + 1]; i++; }
    } else if (ch === '"' || ch === "'") {
      q = ch; buf += ch;
    } else if (ch === '\\') {
      buf += ch;
      if (i + 1 < cmdStr.length) { buf += cmdStr[i + 1]; i++; }
    } else if (cmdStr.startsWith('&&', i) || cmdStr.startsWith('||', i)) {
      segs.push(buf); buf = ''; i++;
    } else if (ch === ';' || ch === '\n' || ch === '\r') {
      segs.push(buf); buf = '';
    } else {
      buf += ch;
    }
  }
  segs.push(buf);
  return segs;
}

// python shlex.split（POSIX 模式）的等价实现：引号分组、反斜杠转义；
// 引号不闭合等异常返回 null（对应 ValueError → 不放行，落回 rtk 判断）
function shlexSplit(s) {
  const toks = [];
  let tok = '';
  let hasTok = false;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) { q = null; continue; }
      if (ch === '\\' && q === '"' && i + 1 < s.length && ('"\\'.includes(s[i + 1]))) { tok += s[i + 1]; i++; continue; }
      tok += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch; hasTok = true;
    } else if (ch === '\\') {
      if (i + 1 >= s.length) return null; // 行尾裸反斜杠
      tok += s[i + 1]; i++; hasTok = true;
    } else if (/\s/.test(ch)) {
      if (hasTok) { toks.push(tok); tok = ''; hasTok = false; }
    } else {
      tok += ch; hasTok = true;
    }
  }
  if (q) return null; // 引号不闭合
  if (hasTok) toks.push(tok);
  return toks;
}

function segIsPass(seg, userGit) {
  const toks = shlexSplit(seg);
  if (!toks || !toks.length) return false;
  // 自带限量的读取：模型已自限输出规模，压缩无收益
  if (['head', 'tail', 'wc'].includes(toks[0])) return true;
  if (toks[0] === 'sed' && toks.length > 1 && toks[1].startsWith('-n')) return true;
  // du 带汇总旗标（-s / --summarize）时每个对象只出一行
  if (toks[0] === 'du') {
    return toks.slice(1).some((t) => t === '--summarize' || (t.startsWith('-') && !t.startsWith('--') && t.includes('s')));
  }
  if (toks[0] === 'git') {
    let i = 1;
    while (i < toks.length) {
      const t = toks[i];
      if ((t === '-C' || t === '-c') && i + 1 < toks.length) i += 2;
      else if (t.startsWith('--') && t.includes('=')) i++;
      else break;
    }
    if (i >= toks.length) return false;
    const sub = toks[i];
    const rest = toks.slice(i + 1);
    if (userGit.has(sub)) return true; // 用户显式指定的 git 子命令优先，跳过形态检查
    if (sub === 'tag') {
      const listing = rest.some((t) => ['-l', '-n', '--list'].includes(t) || t.startsWith('-n'));
      return !listing && rest.some((t) => !t.startsWith('-'));
    }
    if (sub === 'stash') return !(rest.length === 1 && ['list', 'show'].includes(rest[0]));
    if (sub === 'branch') {
      // 列表形态（裸 branch / -a / --list …）不算；新建（首参是名字）
      // 与删除/重命名（-d/-D/-m/-M）才算
      if (rest.some((t) => ['-d', '-D', '-m', '-M', '--delete', '--move'].includes(t))) return true;
      return rest.length > 0 && !rest[0].startsWith('-');
    }
    if (sub === 'config') {
      if (rest.some((t) => t === '-l' || t === '--list')) return false;
      return rest.some((t) => !t.startsWith('-'));
    }
    if (sub === 'remote') {
      return rest.length > 0 && ['add', 'remove', 'rm', 'rename', 'set-url', 'prune', 'get-url', 'set-head'].includes(rest[0]);
    }
    if (sub === 'worktree') {
      return rest.length > 0 && ['add', 'remove', 'prune', 'repair', 'move', 'lock', 'unlock'].includes(rest[0]);
    }
    return GIT_MUTATIONS.has(sub);
  }
  return PLAIN_MUTATIONS.has(toks[0]);
}

function allSegmentsPass(cmdStr, wlFile) {
  // 用户自定义白名单：每行 name（匹配段首命令）或 git:name（匹配 git 子命令，
  // 优先于形态检查），# 开头注释；无法识别的行忽略
  const userGit = new Set();
  try {
    const lines = readFileSync(wlFile, 'utf8').split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^git:[A-Za-z0-9._-]+$/.test(line)) { userGit.add(line.slice(4)); GIT_MUTATIONS.add(line.slice(4)); }
      else if (/^[A-Za-z0-9._-]+$/.test(line)) PLAIN_MUTATIONS.add(line);
    }
  } catch { /* 白名单缺失/读不了：按默认清单判断 */ }
  const segs = splitTop(cmdStr).filter((s) => s.trim());
  return segs.length > 0 && segs.every((s) => segIsPass(s, userGit));
}
