// vision 图片卡片：内嵌在 vision_ask 工具结果里，显示被识别的图片与问答，
// 支持在图上框选区域、把选区引用为下一轮对话的附加上下文（updateModelContext）。
// 事件处理要先注册再 connect，并保留连接前收到的初始结果（SDK 要求，避免丢首帧）。

import type { App } from "@modelcontextprotocol/ext-apps";
import { callToolJson, connectPage, renderMarkdown, setupCardHeartbeat } from "../../../ui-common/zcode-page";

interface AskResult {
  image_path?: string;
  question?: string;
  desc?: string;
  used?: string;
  cached?: boolean;
}

let app: App;
let latest: AskResult | null = null;
let imageLoaded = false; // 图片区展开时才拉图，默认收着不看的不浪费一次请求

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(text: string) {
  $("placeholder").style.display = "none";
  $("err").textContent = text;
}

// 图片区默认收起（问答文字保持直接可读）；新结果到达时回到收起态。
// 追问不需要按钮：对话里直接提，模型会用 vision_ask 对原图定向追问
function setToolsCollapsed(collapsed: boolean) {
  $("tools").classList.toggle("collapsed", collapsed);
  const toggle = $("tools-toggle");
  toggle.textContent = collapsed ? "显示图片" : "收起图片";
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
  if (!app) { $("err").textContent = "宿主连接不可用，无法加载图片（历史会话查看时可能出现）"; return; }
  try {
    const data = await callToolJson<{ dataUrl: string }>(app, "vision_image_data", { image_path: latest.image_path });
    imageLoaded = true;
    $<HTMLImageElement>("img").src = data.dataUrl;
  } catch (e) {
    $("err").textContent = `图片加载失败：${(e as Error).message || e}`;
  }
}



async function main() {
  // 纯 DOM 的交互先挂好：历史会话查看时页面仍会渲染，但传输层可能连不上
  //（connectPage 挂起），折叠开关不能跟着失联
  // 注意取反：点击的语义是"切到另一个状态"，传当前状态进去等于原地不动
  //（首版就少写了这个 !，按钮从上线起点击无反应，E2E 程序化点击才抓到）
  $("tools-toggle").addEventListener("click", () => setToolsCollapsed(!$("tools").classList.contains("collapsed")));
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
  render();
  // 心跳进注册表（连接成功后才启动）：服务端据此掌握活卡数，达到 cardSandboxBudget
  // 预算时在 tools/list 停挂新卡片（见 zcode-page 的 setupCardHeartbeat 注释）
  setupCardHeartbeat((pageId) =>
    callToolJson(app, "vision_card_heartbeat", { sandboxId: pageId }).catch(() => {}));
}

void main().catch((e) => {
  const el = document.getElementById("err");
  if (el) el.textContent = `页面初始化失败：${(e as Error).message || e}`;
});
