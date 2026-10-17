// ocr 评审面板：内嵌在 ocr_render_review 工具结果里。按严重级分组展示评审条目（finding），
// 勾选已处理（状态存 widgetState，会话内重建可恢复），把未处理项作为下一轮附加上下文交回对话。

import type { App } from "@modelcontextprotocol/ext-apps";
import { EmptyResultSchema } from "@modelcontextprotocol/core";
import { callToolJson, connectPage, escapeHtml, renderMarkdown, updateContextSafe } from "../../../ui-common/zcode-page";

interface Finding {
  file: string;
  line: number | null;
  severity: "high" | "medium" | "low";
  summary: string;
  detail: string;
}

interface Review {
  reviewId: string;
  title: string;
  ref: string;
  counts: { high: number; medium: number; low: number };
  findings: Finding[];
}

const SEV_ORDER: Finding["severity"][] = ["high", "medium", "low"];
const SEV_LABEL: Record<Finding["severity"], string> = { high: "高", medium: "中", low: "低" };

let app: App;
let review: Review | null = null;
let checked = new Set<number>(); // finding 下标

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function widgetStateSupported(): boolean {
  const caps = app.getHostCapabilities() as { experimental?: Record<string, unknown> } | undefined;
  return Boolean(caps?.experimental?.["zcode/widgetState"]);
}

async function saveCheckedState() {
  if (!widgetStateSupported() || !review) return;
  try {
    await app.request(
      // 勾选状态带上 reviewId：新一次评审到达时不沿用上一次的勾选
      { method: "ui/set-widget-state", params: { widgetState: { reviewId: review.reviewId, checked: Array.from(checked) } } },
      EmptyResultSchema,
    );
  } catch {
    // 状态保存失败不影响使用，只是勾选不被记住
  }
}

function restoreCheckedState() {
  const ctx = app.getHostContext() as { widgetState?: { reviewId?: string; checked?: number[] } } | undefined;
  const saved = ctx?.widgetState;
  if (!review || saved?.reviewId !== review.reviewId || !Array.isArray(saved.checked)) return;
  checked = new Set(saved.checked.filter((n) => typeof n === "number"));
}

function showError(text: string) {
  $("placeholder").style.display = "none";
  $("err").textContent = text;
}

function render() {
  if (!review) return;
  $("err").textContent = "";
  $("placeholder").style.display = "none";
  $("panel").style.display = "block";
  $("title").textContent = review.title || "评审结果";
  $("ref").textContent = review.ref || "";
  const total = review.findings.length;
  const done = review.findings.filter((_, i) => checked.has(i)).length;
  $("summary").textContent = `共 ${total} 条（高 ${review.counts.high} / 中 ${review.counts.medium} / 低 ${review.counts.low}）· 已处理 ${done} · 未处理 ${total - done}`;
  const total2 = Math.max(total, 1);
  $("sevbar").innerHTML =
    `<span style="width:${(review.counts.high / total2) * 100}%;background:var(--high)"></span>` +
    `<span style="width:${(review.counts.medium / total2) * 100}%;background:var(--medium)"></span>` +
    `<span style="width:${(review.counts.low / total2) * 100}%;background:var(--low)"></span>`;

  const groups: string[] = [];
  for (const sev of SEV_ORDER) {
    const items = review.findings
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.severity === sev);
    if (items.length === 0) continue;
    const rows = items
      .map(
        ({ f, i }) => `<div class="finding${checked.has(i) ? " done" : ""}" data-idx="${i}">
  <input type="checkbox" ${checked.has(i) ? "checked" : ""} aria-label="已处理" />
  <div class="body">
    <div class="loc">${escapeHtml(f.file)}${f.line ? `:${f.line}` : ""}</div>
    <p class="summary-line">${escapeHtml(f.summary)}</p>
    ${f.detail ? `<details><summary>详情</summary><div class="detail">${renderMarkdown(f.detail)}</div></details>` : ""}
  </div>
</div>`,
      )
      .join("");
    groups.push(`<div class="group ${sev}"><h2>${SEV_LABEL[sev]} <span class="n">（${items.length}）</span></h2>${rows}</div>`);
  }
  $("groups").innerHTML = groups.join("");

  for (const el of Array.from(document.querySelectorAll(".finding input[type=checkbox]"))) {
    el.addEventListener("change", () => {
      const idx = Number((el.closest(".finding") as HTMLElement).dataset.idx);
      if ((el as HTMLInputElement).checked) checked.add(idx);
      else checked.delete(idx);
      (el.closest(".finding") as HTMLElement).classList.toggle("done", (el as HTMLInputElement).checked);
      $("summary").textContent = `共 ${review!.findings.length} 条（高 ${review!.counts.high} / 中 ${review!.counts.medium} / 低 ${review!.counts.low}）· 已处理 ${checked.size} · 未处理 ${review!.findings.length - checked.size}`;
      void saveCheckedState();
    });
  }
}

async function sendOpen() {
  if (!review) return;
  const open = review.findings.filter((_, i) => !checked.has(i));
  if (open.length === 0) {
    $("status").textContent = "全部条目已处理";
    return;
  }
  const lines = open.map((f, n) => `${n + 1}. [${SEV_LABEL[f.severity]}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.summary}`);
  const text = `【ocr 评审面板】以下 ${open.length} 条评审意见未处理：\n${lines.join("\n")}\n请逐条确认或修复。`;
  const r = await updateContextSafe(app, { content: [{ type: "text", text }] });
  if (r.ok) {
    $("status").textContent = "已附加到输入区，接着提问即可";
    setTimeout(() => { $("status").textContent = ""; }, 4000);
  } else {
    $("err").textContent = `交回对话失败：${r.error}`;
  }
}

async function main() {
  app = await connectPage("ocr-review-panel", "1.0.0", (a) => {
    // 初始结果可能在连接完成前送达：先挂事件、保留最近一份。
    // 校验失败/取消的结果没有数据，给出明确提示而不是一直占位。
    a.ontoolresult = (params) => {
      const p = params as {
        structuredContent?: Review;
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      const sc = p.structuredContent;
      if (sc && Array.isArray(sc.findings) && typeof sc.reviewId === "string") {
        review = sc;
        restoreCheckedState();
        render();
        return;
      }
      if (p.isError) {
        const text = (p.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
        showError(`ocr_render_review 调用失败：${text || "未知错误"}`);
      }
    };
    a.ontoolcancelled = () => {
      showError("ocr_render_review 调用已取消");
    };
  });
  $("send-open").addEventListener("click", () => void sendOpen());
  // 没收到初始结果时（比如卡片重建），取最近一次评审
  if (!review) {
    try {
      review = await callToolJson<Review>(app, "ocr_get_review", {});
      restoreCheckedState();
      render();
    } catch {
      // 没有历史评审就保持占位提示
    }
  }
}

void main().catch((e) => {
  const el = document.getElementById("err");
  if (el) el.textContent = `页面初始化失败：${(e as Error).message || e}`;
});
