// 交互页面共用客户端逻辑：连接宿主、调用插件服务工具、主题跟随。
// 页面经 esbuild 打包内联进 dist/panel.html（scripts/build-plugins.mjs），无运行时依赖。

import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

/**
 * 建立与宿主的连接：官方 App + PostMessageTransport，连接后应用主题并跟随变化。
 * 事件要先注册再 connect（SDK 要求，避免丢首帧通知）；需要预挂事件（如 ontoolresult
 * 保留初始结果）的页面用 configure 回调，它在 connect 之前执行。
 */
export async function connectPage(
  name: string,
  version: string,
  configure?: (app: App) => void,
): Promise<App> {
  const app = new App({ name, version }, { availableDisplayModes: ["inline", "fullscreen"] });
  app.onhostcontextchanged = () => applyTheme(app);
  if (configure) configure(app);
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  applyTheme(app);
  return app;
}

function applyTheme(app: App) {
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  syncLocale((ctx as { locale?: string } | undefined)?.locale);
}

/** 调用当前插件服务的工具，取结构化结果（structuredContent 优先，其次把文本按 JSON 解析）。 */
export async function callToolJson<T = unknown>(
  app: App,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await app.callServerTool({ name, arguments: args });
  const sc = (res as { structuredContent?: unknown }).structuredContent;
  if (!res.isError) {
    if (sc !== undefined) return sc as T;
    try {
      return JSON.parse(contentText(res)) as T;
    } catch {
      throw new Error(contentText(res) || "工具返回为空");
    }
  }
  throw new Error(contentText(res) || `工具 ${name} 调用失败`);
}

/** 调用当前插件服务的工具，取纯文本结果。 */
export async function callToolText(
  app: App,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.callServerTool({ name, arguments: args });
  const text = contentText(res);
  if (res.isError) throw new Error(text || `工具 ${name} 调用失败`);
  return text;
}

/**
 * 附加对话上下文（updateModelContext）的安全封装：宿主未声明该能力、或请求 8 秒无应答时
 * 返回明确错误，而不是让页面永远等下去（侧栏面板场景实测存在不应答的宿主）。
 */
export async function updateContextSafe(
  app: App,
  params: Parameters<App["updateModelContext"]>[0],
): Promise<{ ok: boolean; error?: string }> {
  const caps = app.getHostCapabilities() as { updateModelContext?: unknown } | undefined;
  if (!caps?.updateModelContext) return { ok: false, error: "当前宿主不支持附加对话上下文" };
  try {
    await Promise.race([
      app.updateModelContext(params),
      new Promise((_, reject) => setTimeout(() => reject(new Error("附加超时（8 秒无应答）")), 8000)),
    ]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

type ToolResultLike = {
  content?: Array<{ type: string; text?: string }>;
};

function contentText(res: ToolResultLike): string {
  if (!Array.isArray(res.content)) return "";
  return res.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // 中文界面按四位分组（万进制习惯：3531,3866），其他语言保持千进制三位分组
  if (zhLocale) {
    let s = String(Math.round(Math.abs(n)));
    const neg = n < 0 ? "-" : "";
    const parts: string[] = [];
    while (s.length > 4) {
      parts.unshift(s.slice(-4));
      s = s.slice(0, -4);
    }
    parts.unshift(s);
    return neg + parts.join(",");
  }
  return n.toLocaleString("en-US");
}

/**
 * 大数节省量的显示（ADR-0006）：中文且 ≥1 亿时用"1.xxxx 亿"，其余情况与 fmtInt 一致。
 */
export function fmtBigTokens(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (zhLocale && Math.abs(n) >= 1e8) {
    const y = (n / 1e8).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return `${y} 亿`;
  }
  return fmtInt(n);
}

// —— 语言环境：连接后取宿主 locale，未连上时先按浏览器语言兜底 ——
let zhLocale = (typeof navigator !== "undefined" && /^zh/i.test(navigator.language || ""));

function syncLocale(locale?: string) {
  if (locale) zhLocale = /^zh/i.test(locale);
}

/**
 * 转义后的小型 markdown 渲染：标题（#~####）、加粗、行内代码、无序/有序列表、
 * GFM 表格（表头 + |---| 分隔行 + 数据行）、段落。
 * 只支持识别回答这类简单文本，输入先整体转义，不会注入 HTML。
 */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split(/\r?\n/);
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const inline = (s: string) =>
    s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  // 表格分隔行：| --- | :---: | 之类的形态（首尾竖线可省）
  const isTableDelimiter = (l: string) =>
    /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(l) && l.includes("|");
  const splitRow = (l: string) =>
    l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    // 当前行含竖线且（跳过被模型插在表头与分隔行之间的一个空行后）下一行是
    // 分隔行 → 按 GFM 表格吃掉表头/分隔/连续数据行（标准 GFM 要求表头与分隔行
    // 相邻，但识别模型常在中间输出空行，展示层容忍）
    let delimIdx = -1;
    if (line.includes("|") && i + 1 < lines.length) {
      let d = i + 1;
      if (!lines[d].trim()) d++;
      if (d < lines.length && isTableDelimiter(lines[d].trim())) delimIdx = d;
    }
    if (delimIdx >= 0) {
      closeLists();
      const head = splitRow(line);
      out.push("<table><thead><tr>");
      for (const c of head) out.push(`<th>${inline(c)}</th>`);
      out.push("</tr></thead><tbody>");
      let j = delimIdx + 1;
      for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++) {
        out.push("<tr>");
        for (let k = 0; k < head.length; k++) out.push(`<td>${inline(splitRow(lines[j])[k] ?? "")}</td>`);
        out.push("</tr>");
      }
      out.push("</tbody></table>");
      i = j - 1;
    } else if (/^#{1,4}\s+/.test(line)) {
      closeLists();
      out.push(`<h3>${inline(line.replace(/^#{1,4}\s+/, ""))}</h3>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
    } else if (/^\d+\.\s+/.test(line)) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`);
    } else if (line.trim() === "") {
      closeLists();
    } else {
      closeLists();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeLists();
  return out.join("");
}

/**
 * 卡片存活心跳：页面向插件的 vision_card_heartbeat 心跳，服务端注册表据此掌握
 * 当前活卡数（ZCode 宿主对插件界面沙箱有全局上限 64 个，超预算时服务端在
 * tools/list 里停止给新结果挂卡片，退回纯文本——页面侧没有任何安全的单卡释放
 * 通道：实测无 zcodePluginSandbox 原生桥；ui/notifications/request-teardown 是
 * 运行时级的，会把整个插件 UI 拆掉殃及所有卡片，绝不能用）。
 */
export function setupCardHeartbeat(
  heartbeat: (pageId: string) => Promise<unknown> | undefined,
): void {
  const POLL_MS = 20_000;
  const pageId = crypto.randomUUID?.() || `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const beat = () => { try { void heartbeat(pageId); } catch { /* 心跳失败下轮再试 */ } };
  beat();
  window.setInterval(beat, POLL_MS);
  const bump = () => beat();
  window.addEventListener("pointerdown", bump, { passive: true });
  window.addEventListener("keydown", bump, { passive: true });
}
