// vision 图片卡片：内嵌在 vision_ask 工具结果里，显示被识别的图片与问答，
// 支持在图上框选区域、把选区引用为下一轮对话的附加上下文（updateModelContext）。
// 事件处理要先注册再 connect，并保留连接前收到的初始结果（SDK 要求，避免丢首帧）。

import type { App } from "@modelcontextprotocol/ext-apps";
import { callToolJson, connectPage, renderMarkdown, updateContextSafe } from "../../../ui-common/zcode-page";

interface AskResult {
  image_path?: string;
  question?: string;
  desc?: string;
  used?: string;
  cached?: boolean;
}

let app: App;
let latest: AskResult | null = null;
let region: { x: number; y: number; w: number; h: number } | null = null;
let imageLoaded = false; // 图片区展开时才拉图，默认收着不看的不浪费一次请求

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(text: string) {
  $("placeholder").style.display = "none";
  $("err").textContent = text;
}

// 图片与框选引用区默认收起（问答文字保持直接可读）；新结果到达时回到收起态
function setToolsCollapsed(collapsed: boolean) {
  $("tools").classList.toggle("collapsed", collapsed);
  const toggle = $("tools-toggle");
  toggle.textContent = collapsed ? "显示图片与框选引用" : "收起图片与框选";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed && !imageLoaded) void loadImage();
}

function render() {
  if (!latest) return;
  $("err").textContent = "";
  $("placeholder").style.display = "none";
  $("card").style.display = "block";
  $("q").textContent = latest.question || "";
  $("meta").textContent = latest.used ? `${latest.used}${latest.cached ? " · 缓存命中" : ""}` : "";
  $("a").innerHTML = renderMarkdown(latest.desc || "");
  $("path").textContent = latest.image_path || "";
  imageLoaded = false;
  setToolsCollapsed(true);
}

async function loadImage() {
  if (!latest?.image_path) return;
  try {
    const data = await callToolJson<{ dataUrl: string }>(app, "vision_image_data", { image_path: latest.image_path });
    $<HTMLImageElement>("img").src = data.dataUrl;
  } catch (e) {
    $("err").textContent = `图片加载失败：${(e as Error).message || e}`;
  }
}

// —— 框选：相对图片显示尺寸的百分比（等比缩放下与原图百分比一致）——
function setupSelection() {
  const wrap = $("wrap");
  const img = $("img");
  const sel = $("sel");
  let startX = 0;
  let startY = 0;
  let dragging = false;

  const point = (e: MouseEvent) => {
    const r = img.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1),
      y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1),
    };
  };

  wrap.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    const p = point(e);
    startX = p.x;
    startY = p.y;
    region = null;
    sel.style.display = "block";
    Object.assign(sel.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: "0%", height: "0%" });
  });
  wrap.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const p = point(e);
    const x = Math.min(startX, p.x);
    const y = Math.min(startY, p.y);
    const w = Math.abs(p.x - startX);
    const h = Math.abs(p.y - startY);
    Object.assign(sel.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
  });
  const finish = (e: MouseEvent) => {
    if (!dragging) return;
    dragging = false;
    const p = point(e);
    const rect = {
      x: Math.min(startX, p.x),
      y: Math.min(startY, p.y),
      w: Math.abs(p.x - startX),
      h: Math.abs(p.y - startY),
    };
    if (rect.w < 0.01 || rect.h < 0.01) {
      // 视为点击：取消选区
      sel.style.display = "none";
      region = null;
      return;
    }
    region = rect;
  };
  wrap.addEventListener("mouseup", finish);
  wrap.addEventListener("mouseleave", (e) => finish(e as MouseEvent));
}

async function reference() {
  if (!latest?.image_path) return;
  const path = latest.image_path;
  let contentText: string;
  if (region) {
    const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
    contentText =
      `【zcode-vision 框选引用】图片：${path}。用户在图上框选了区域（相对原图左上角的百分比）：` +
      `x=${pct1(region.x)}，y=${pct1(region.y)}，宽=${pct1(region.w)}，高=${pct1(region.h)}。` +
      `接下来的提问针对该选区内容。`;
  } else {
    contentText = `【zcode-vision 图片引用】图片：${path}。接下来的提问针对这张图片。`;
  }
  try {
    const r = await updateContextSafe(app, {
      content: [{ type: "text", text: contentText }],
      ...(region ? { structuredContent: { image_path: path, region } } : {}),
    });
    if (r.ok) {
      $("status").textContent = "已附加到输入区，接着提问即可";
      setTimeout(() => { $("status").textContent = ""; }, 4000);
    } else {
      $("err").textContent = `引用失败：${r.error}`;
    }
  } catch (e) {
    $("err").textContent = `引用失败：${(e as Error).message || e}`;
  }
}

async function main() {
  app = await connectPage("vision-card", "1.0.0", (a) => {
    // 初始结果可能在连接完成前送达：先挂事件、保留最近一份。
    // 成功结果带 structuredContent；失败/取消结果没有数据，给出明确提示而不是一直占位。
    a.ontoolresult = (params) => {
      const p = params as {
        structuredContent?: AskResult;
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      const sc = p.structuredContent;
      if (sc && typeof sc.image_path === "string") {
        latest = sc;
        render();
        return;
      }
      if (p.isError) {
        const text = (p.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n");
        showError(`vision_ask 调用失败：${text || "未知错误"}`);
      }
    };
    a.ontoolcancelled = () => {
      showError("vision_ask 调用已取消");
    };
  });
  setupSelection();
  $("ref").addEventListener("click", () => void reference());
  $("tools-toggle").addEventListener("click", () => setToolsCollapsed($("tools").classList.contains("collapsed")));
  render();
}

void main().catch((e) => {
  const el = document.getElementById("err");
  if (el) el.textContent = `页面初始化失败：${(e as Error).message || e}`;
});
