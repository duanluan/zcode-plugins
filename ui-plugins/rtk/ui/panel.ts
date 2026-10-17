// rtk 输出记录面板：列出最近的 rtk 压缩记录，点开查看被省略的完整输出，支持过滤。
// 数据经 rtk-ui 服务的 rtk_recent_outputs / rtk_read_output 工具读取。

import type { App } from "@modelcontextprotocol/ext-apps";
import { callToolJson, connectPage, escapeHtml, fmtInt, updateContextSafe } from "../../../ui-common/zcode-page";

interface RtkItem {
  hash: string;
  command: string;
  lines: number;
  hidden: number;
  bytes?: number | null;
  truncated?: boolean;
  createdAt?: string | null;
  origText?: string;
}

let app: App;
let items: RtkItem[] = [];
let current: RtkItem | null = null;
let fullMode = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function loadList() {
  $("err").textContent = "";
  $("msg").textContent = "加载中…";
  try {
    const data = await callToolJson<{ items: RtkItem[] }>(app, "rtk_recent_outputs", { limit: 300 });
    items = [...(data.items || [])].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    $("msg").textContent = items.length === 0 ? "没有记录（先跑几条命令，或确认 rtk 已安装：/rtk-setup）" : "";
  } catch (e) {
    $("msg").textContent = "";
    $("err").textContent = String((e as Error).message || e);
  }
  renderList();
}

function renderList() {
  const kw = $<HTMLInputElement>("filter").value.trim().toLowerCase();
  const shown = kw
    ? items.filter((it) => it.command.toLowerCase().includes(kw) || it.hash.startsWith(kw))
    : items;
  $("count").textContent = kw ? `${shown.length}/${items.length}` : `${items.length}`;
  const html = shown
    .map((it) => {
      const time = fmtRowTime(it.createdAt);
      const size = typeof it.bytes === "number"
        ? ` · 约 ${fmtBytes(it.bytes)}`
        : (it.origText ? ` · 原文约 ${escapeHtml(it.origText)}B` : "");
      return `<button class="row" data-hash="${escapeHtml(it.hash)}" title="hash ${escapeHtml(it.hash)}（rtk 紧凑命令名，下划线代替空格等字符）${it.truncated ? " · 原始输出被 rtk 截断" : ""}">
  <span class="rtime">${time}</span>
  <span class="cmd" title="${escapeHtml(it.command)}">${escapeHtml(it.command)}</span>
  <span class="meta">省略 ${fmtInt(it.hidden)} 行${size}</span>
</button>`;
    })
    .join("");
  $("list").innerHTML = html;
  for (const el of Array.from(document.querySelectorAll(".row"))) {
    el.addEventListener("click", () => openDetail(String((el as HTMLElement).dataset.hash)));
  }
}

async function openDetail(hash: string) {
  const it = items.find((x) => x.hash === hash) || { hash, command: "", lines: 0, hidden: 0, bytes: null, truncated: false, createdAt: null };
  current = it;
  fullMode = false;
  $("list").style.display = "none";
  $("detail").style.display = "flex";
  $("filter").style.display = "none";
  // 计数徽章是列表的记录总数，与当前详情无关，详情视图隐藏避免误读成"第 N 条"
  $("count").style.display = "none";
  $("d-hash").textContent = it.hash;
  $("d-cmd").textContent = it.command;
  $<HTMLInputElement>("d-grep").value = "";
  await loadDetail();
}

async function loadDetail() {
  if (!current) return;
  $("d-text").textContent = "加载中…";
  $("truncnote").textContent = "";
  const args: Record<string, unknown> = { hash: current.hash };
  if (fullMode) args.full = true;
  const grep = $<HTMLInputElement>("d-grep").value.trim();
  if (grep) args.grep = grep;
  try {
    const data = await callToolJson<{ text: string; truncated: boolean }>(app, "rtk_read_output", args);
    $("d-text").textContent = data.text || "（空）";
    if (data.truncated) $("truncnote").textContent = "输出超过 1 MiB，已截断；可在终端用 rtk recall 查看全部。";
    if (!grep && !fullMode && !data.text.trim()) {
      $("truncnote").textContent = "这条记录没有省略行（输出没被压缩截断），点“全文”看完整输出。";
    }
  } catch (e) {
    $("d-text").textContent = "";
    $("err").textContent = String((e as Error).message || e);
  }
}

function backToList() {
  current = null;
  $("detail").style.display = "none";
  $("list").style.display = "flex";
  $("filter").style.display = "";
  $("count").style.display = "";
  $("err").textContent = "";
}

// 引用到对话：把当前显示的输出作为下一轮附加上下文（updateModelContext）。
// 上下文体积有限，超过 16000 个字符截断并在文内注明完整获取方式
const QUOTE_CAP = 16000;

async function quoteToConversation() {
  if (!current) return;
  const text = $("d-text").textContent || "";
  if (!text.trim()) {
    flash("没有可引用的内容");
    return;
  }
  const truncated = text.length > QUOTE_CAP;
  const body = truncated ? text.slice(0, QUOTE_CAP) : text;
  const meta = `【rtk 输出记录】命令 ${current.command}（hash ${current.hash}）${
    fullMode ? "完整输出" : "被省略的行"
  }${truncated ? `，前 ${QUOTE_CAP} 个字符（完整内容可在 rtk 输出记录面板查看）` : ""}如下：`;
  const r = await updateContextSafe(app, { content: [{ type: "text", text: `${meta}\n${body}` }] });
  if (r.ok) flash("已附加到输入区，接着提问即可");
  else $("err").textContent = `引用失败：${r.error}`;
}

async function copyOutput() {
  const text = $("d-text").textContent || "";
  if (!text.trim()) {
    flash("没有可复制的内容");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    flash("已复制");
    return;
  } catch {
    // clipboard API 不可用时退回 execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) flash("已复制");
    else $("err").textContent = "复制失败：请手动选中文本复制";
  } catch {
    $("err").textContent = "复制失败：请手动选中文本复制";
  }
}

function fmtRowTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x: number) => String(x).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  return d.getFullYear() !== now.getFullYear() ? `${String(d.getFullYear()).slice(2)}-${md} ${hm}` : `${md} ${hm}`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function flash(msg: string) {
  const el = $("truncnote");
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
}

async function main() {
  app = await connectPage("rtk-outputs-panel", "1.0.0");
  $("refresh").addEventListener("click", () => void loadList());
  $("filter").addEventListener("input", renderList);
  $("back").addEventListener("click", backToList);
  $("d-grep-btn").addEventListener("click", () => void loadDetail());
  $("d-grep").addEventListener("keydown", (e) => { if (e.key === "Enter") void loadDetail(); });
  $("d-full").addEventListener("click", () => { fullMode = true; void loadDetail(); });
  $("d-omitted").addEventListener("click", () => { fullMode = false; void loadDetail(); });
  $("d-quote").addEventListener("click", () => void quoteToConversation());
  $("d-copy").addEventListener("click", () => void copyOutput());
  // 活页面会跨打开/关闭保留：面板重新显示（宿主上下文变化）时自动刷新列表，避免陈旧数据
  const prevCtx = app.onhostcontextchanged;
  app.onhostcontextchanged = (p) => {
    prevCtx?.(p);
    if (!current) void loadList();
  };
  await loadList();
}

void main().catch((e) => {
  const el = document.getElementById("err");
  if (el) el.textContent = `页面初始化失败：${(e as Error).message || e}`;
});
