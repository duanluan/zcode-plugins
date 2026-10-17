// headroom 压缩记录面板：压缩节省总览（savings 台账）+ 按哈希取回压缩前的原文。
// 数据经 headroom-ui 服务的 hr_savings_overview / hr_retrieve 工具读取。

import type { App } from "@modelcontextprotocol/ext-apps";
import { callToolJson, callToolText, connectPage, escapeHtml, fmtBigTokens, fmtInt, updateContextSafe } from "../../../ui-common/zcode-page";

interface SavingsWindow {
  tokens_saved?: number;
  tokens_before?: number;
  cost_usd?: number;
  calls?: number;
  savings_percent?: number;
  new_input_savings_percent?: number;
}

interface SavingsReport {
  top_model?: string;
  lifetime?: SavingsWindow;
  windows?: Record<string, SavingsWindow>;
}

interface CompressionItem {
  hash: string;
  createdAt: string;
  expiresAtMs: number | null;
  preview: string;
  bytes: number;
}

interface DayAgg {
  date: string;
  saved: number;
  cost: number;
  calls: number;
}

interface ModelAgg {
  model: string;
  saved: number;
  calls: number;
}

interface CompressionInfo {
  avgRatio: number | null;
  bestRatio: number | null;
  samples: number;
}

const WINDOW_LABELS: Record<string, string> = {
  today: "今天",
  last_7_days: "近 7 天",
  last_30_days: "近 30 天",
};

let app: App;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function usd(v: number | undefined): string {
  return typeof v === "number" ? `$${v.toFixed(2)}` : "—";
}

function cardHtml(label: string, w: SavingsWindow): string {
  return `<div class="card">
  <div class="label">${escapeHtml(label)}</div>
  <div class="value">省 ${fmtBigTokens(w.tokens_saved ?? 0)} <small style="font-size:12px;">token</small></div>
  <div class="sub">${usd(w.cost_usd)} · ${fmtInt(w.calls ?? 0)} 次调用</div>
</div>`;
}

function sameWindow(a?: SavingsWindow, b?: SavingsWindow): boolean {
  if (!a || !b) return false;
  return a.tokens_saved === b.tokens_saved && a.cost_usd === b.cost_usd && a.calls === b.calls;
}

async function loadOverview() {
  $("err").textContent = "";
  $("msg").textContent = "加载中…";
  try {
    const data = await callToolJson<SavingsReport>(app, "hr_savings_overview", { days: 30 });
    const parts: string[] = [];
    // savings 台账没有分模型统计：累计/各窗口都覆盖全部模型，top_model 只是调用最多的那个，
    // 单独放在提示行说明，不挂在任何一张卡上当限定词。台账只覆盖近一段时期时
    // 近 30 天与累计完全相同，此时隐藏 30 天卡避免两张重复卡
    if (data.lifetime) parts.push(cardHtml("累计", data.lifetime));
    for (const [key, win] of Object.entries(data.windows || {})) {
      if (!win || typeof win.tokens_saved !== "number") continue;
      if (key === "last_30_days" && sameWindow(win, data.lifetime)) continue;
      parts.push(cardHtml(WINDOW_LABELS[key] || key, win));
    }
    $("cards").innerHTML = parts.join("") || "";
    $("msg").textContent = parts.length === 0 ? "savings 台账还没有数据" : "";
    const topModel = (data.top_model ? `统计覆盖全部模型，调用最多的是 ${data.top_model}。` : "") + " 费用按牌价估算（省 token × 模型输入单价），非实付金额。";
    $("modelnote").textContent = topModel;
  } catch (e) {
    $("msg").textContent = "";
    $("err").textContent = String((e as Error).message || e);
  }
}

// —— 图表：每日节省柱状 + 按模型/客户端分布 + 压缩率（纯 CSS，无图表库）——
async function loadCharts() {
  try {
    const data = await callToolJson<{
      days: DayAgg[];
      models: ModelAgg[];
      compression: CompressionInfo;
      note?: string;
    }>(app, "hr_daily_savings", { days: 14 });
    renderDaily(data.days || [], data.compression, data.note);
    renderModels(data.models || []);
  } catch (e) {
    $("daily").innerHTML = `<div class="hint" style="margin:2px;">图表不可用：${escapeHtml(String((e as Error).message || e))}</div>`;
  }
}

function fmtPct(v: number | null): string {
  return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—";
}

function renderDaily(days: DayAgg[], compression?: CompressionInfo, note?: string) {
  const box = $("daily");
  const detail = $("daydetail");
  if (days.length === 0) {
    box.innerHTML = `<div class="hint" style="margin:2px;">${escapeHtml(note || "暂无逐日数据")}</div>`;
    detail.textContent = "";
    return;
  }
  const max = Math.max(...days.map((d) => d.saved), 1);
  // 每根柱子都带日期；窄面板下用"日"（两位数），首柱与跨月处用"月-日"标出月份边界
  const label = (d: DayAgg, i: number) => {
    const [, mm, dd] = d.date.split("-");
    const prevMm = i > 0 ? days[i - 1].date.split("-")[1] : null;
    return mm !== prevMm ? `${mm}-${dd}` : dd;
  };
  box.innerHTML = days
    .map((d, i) => {
      const h = Math.max(Math.round((d.saved / max) * 82), d.saved > 0 ? 3 : 1);
      return `<div class="col${d.saved === 0 ? " empty" : ""}" data-i="${i}">
  <div class="bar" style="height:${h}px"></div>
  <div class="dlabel">${label(d, i)}</div>
</div>`;
    })
    .join("");
  // 原生 title 提示在插件沙箱里会被宿主吞掉，改用图下方的详情条：悬停/点击更新，默认显示峰值日
  const showDay = (d: DayAgg) => {
    detail.textContent = `${d.date}：省 ${fmtBigTokens(d.saved)} token · $${d.cost.toFixed(2)} · ${fmtInt(d.calls)} 次调用`;
  };
  for (const el of Array.from(box.querySelectorAll(".col"))) {
    const day = days[Number((el as HTMLElement).dataset.i)];
    el.addEventListener("mouseenter", () => showDay(day));
    el.addEventListener("click", () => showDay(day));
  }
  const peak = days.reduce((a, b) => (b.saved > a.saved ? b : a));
  showDay(peak);
  const rate = $("ratenote");
  rate.textContent = compression && compression.samples > 0
    ? `压缩率：整体 ${fmtPct(compression.avgRatio)} · 单次最好 ${fmtPct(compression.bestRatio)}（${fmtInt(compression.samples)} 次采样）`
    : "";
}

function renderModels(models: ModelAgg[]) {
  const box = $("models");
  const title = $("modelstitle");
  const active = models.filter((m) => m.saved > 0);
  const zeroRows = models.filter((m) => m.saved === 0);
  // 只有一个有效模型时"分布"没有信息量，整节隐藏；
  // 无节省模型的尾注并入顶部提示行，信息不丢
  if (active.length <= 1) {
    box.style.display = "none";
    title.style.display = "none";
    if (zeroRows.length > 0) {
      const calls = zeroRows.reduce((s, m) => s + m.calls, 0);
      $("modelnote").textContent += ` 近 14 天另有 ${zeroRows.length} 个模型无压缩节省（共 ${fmtInt(calls)} 次调用）。`;
    }
    return;
  }
  box.style.display = "";
  title.style.display = "";
  const max = Math.max(...active.map((m) => m.saved), 1);
  let html = active
    .map((m) => {
      const w = Math.max(Math.round((m.saved / max) * 100), 1);
      return `<div class="mrow" title="${escapeHtml(m.model)}：省 ${fmtBigTokens(m.saved)} token · ${fmtInt(m.calls)} 次">
  <span class="mname">${escapeHtml(m.model)}</span>
  <span class="mtrack"><span class="mfill" style="width:${w}%"></span></span>
  <span class="mnum">${fmtBigTokens(m.saved)} token · ${fmtInt(m.calls)} 次</span>
</div>`;
    })
    .join("");
  if (zeroRows.length > 0) {
    const calls = zeroRows.reduce((s, m) => s + m.calls, 0);
    html += `<div class="hint" style="margin:4px 0 0;">另有 ${zeroRows.length} 个模型近 14 天无压缩节省（共 ${fmtInt(calls)} 次调用）。</div>`;
  }
  box.innerHTML = html;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString("zh-CN", { hour12: false });
}

async function loadRecent() {
  const box = $("recent");
  try {
    const data = await callToolJson<{ items: CompressionItem[]; note?: string }>(app, "hr_recent_compressions", {});
    const items = data.items || [];
    if (items.length === 0) {
      box.innerHTML = `<div class="hint">${escapeHtml(data.note || "最近没有可取回的压缩记录（条目存活约 30 分钟，过期自动消失）")}</div>`;
      return;
    }
    box.innerHTML = items
      .map(
        (it, i) => `<button class="rrow" data-i="${i}" title="哈希 ${escapeHtml(it.hash)}（点击取回）">
  <span class="rtime">${fmtTime(it.createdAt)}</span>
  <span class="rhash">${escapeHtml(it.hash.slice(0, 8))}…</span>
  <span class="rprev">${escapeHtml(it.preview) || `（${it.bytes} 字符）`}</span>
</button>`,
      )
      .join("");
    for (const el of Array.from(box.querySelectorAll(".rrow"))) {
      el.addEventListener("click", () => {
        const it = items[Number((el as HTMLElement).dataset.i)];
        $<HTMLInputElement>("hash").value = it.hash;
        void retrieve();
      });
    }
  } catch (e) {
    box.innerHTML = `<div class="hint">最近压缩列表不可用：${escapeHtml(String((e as Error).message || e))}</div>`;
  }
}

async function retrieve() {
  const hash = $<HTMLInputElement>("hash").value.trim();
  const result = $("result");
  $("err").textContent = "";
  if (!hash) {
    $("err").textContent = "请先填入压缩标记里的哈希";
    return;
  }
  result.style.display = "block";
  result.textContent = "取回中…";
  try {
    let text = await callToolText(app, "hr_retrieve", { hash });
    // headroom_retrieve 返回的是 JSON 包装（{"hash":...,"original_content":...}），解析出原文显示；非 JSON 就原样显示
    try {
      const parsed = JSON.parse(text) as { original_content?: string; content?: string };
      if (typeof parsed?.original_content === "string") text = parsed.original_content;
      else if (typeof parsed?.content === "string") text = parsed.content;
    } catch {
      // 不是 JSON，保持原样
    }
    result.textContent = text || "（空）";
    $("r-actions").style.display = "flex";
  } catch (e) {
    result.style.display = "none";
    $("r-actions").style.display = "none";
    $("err").textContent = String((e as Error).message || e);
  }
}

// 取回原文后可直接交给模型或复制——与 rtk 输出记录面板同一套交互
const QUOTE_CAP = 16000;

async function quoteRetrieved() {
  const text = $("result").textContent || "";
  if (!text.trim()) return;
  const truncated = text.length > QUOTE_CAP;
  const body = truncated ? text.slice(0, QUOTE_CAP) : text;
  const hash = $<HTMLInputElement>("hash").value.trim();
  const meta = `【headroom 压缩取回】hash ${hash} 的压缩前原文${truncated ? `，前 ${QUOTE_CAP} 个字符（完整内容可在 headroom 压缩记录面板查看）` : ""}如下：`;
  const r = await updateContextSafe(app, { content: [{ type: "text", text: `${meta}\n${body}` }] });
  if (r.ok) rFlash("已附加到输入区，接着提问即可");
  else $("err").textContent = `引用失败：${r.error}`;
}

async function copyRetrieved() {
  const text = $("result").textContent || "";
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    rFlash("已复制");
    return;
  } catch { /* 退回 execCommand */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) rFlash("已复制");
    else $("err").textContent = "复制失败：请手动选中文本复制";
  } catch {
    $("err").textContent = "复制失败：请手动选中文本复制";
  }
}

function rFlash(msg: string) {
  const el = $("r-status");
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
}

async function main() {
  app = await connectPage("headroom-panel", "1.0.0");
  $("refresh").addEventListener("click", () => { void loadOverview(); void loadRecent(); void loadCharts(); });
  $("go").addEventListener("click", () => void retrieve());
  $("r-copy").addEventListener("click", () => void copyRetrieved());
  $("r-quote").addEventListener("click", () => void quoteRetrieved());
  $<HTMLInputElement>("hash").addEventListener("keydown", (e) => { if (e.key === "Enter") void retrieve(); });
  await loadOverview();
  void loadCharts();
  await loadRecent();
}

void main().catch((e) => {
  const el = document.getElementById("err");
  if (el) el.textContent = `页面初始化失败：${(e as Error).message || e}`;
});
