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
 * 转义后的小型 markdown 渲染：标题（#~####）、加粗、行内代码、无序/有序列表、段落。
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
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,4}\s+/.test(line)) {
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
