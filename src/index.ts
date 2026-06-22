import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { extractFromHtml } from "./extractor.js";
import {
  matchGithubReadme,
  matchGithubIssue,
  matchRawGithub,
  fetchGithubReadme,
  fetchGithubIssue,
} from "./github.js";
import {
  matchArxivAbs,
  matchArxivHtml,
  matchArxivPdf,
  fetchArxivAbstract,
} from "./arxiv.js";
import { isPdfUrl, isPdfContentType, buildPdfHandoff } from "./pdf.js";
import { withRetry } from "./retry.js";
import { assertSafeFetchUrl } from "./ssrf.js";
import { safeFetch, readLimitedText } from "./safe-fetch.js";
import type { FetchResult } from "./types.js";
import { formatFetchResult, splitParagraphs } from "./format.js";
import { withCache, createFsCacheStore } from "./cache.js";
import { extractLinks } from "./links.js";
import { BrowserPool } from "./browser-pool.js";
import { createSearxngProvider, createTavilyProvider, createDblpProvider, createSemanticScholarProvider, mergeResults, type SearchProvider, type SearchOpts } from "./search.js";
import {
  matchStackOverflowQuestion,
  fetchStackOverflowQuestion,
} from "./stackoverflow.js";
import { matchRedditPost, fetchRedditPost } from "./reddit.js";

// 搜索后端:SearXNG 优先,失败 → Tavily 后备;只有一方则用那方;都不配则报错。
// academic topic 走 DBLP + Semantic Scholar(免费、CCF 全覆盖、搜摘要),不走 Tavily/SearXNG。
const searxngProvider = process.env.SEARXNG_URL
  ? createSearxngProvider(process.env.SEARXNG_URL)
  : null;
const tavilyProvider = process.env.TAVILY_API_KEY
  ? createTavilyProvider(process.env.TAVILY_API_KEY)
  : null;
const dblpProvider = createDblpProvider();
const s2Provider = createSemanticScholarProvider();

// academic 搜索:DBLP(标题搜) + Semantic Scholar(摘要搜)合并去重
const academicProvider: SearchProvider = {
  search: async (query: string, opts?: SearchOpts) => {
    const limit = opts?.num ?? 10;
    const [dblp, s2] = await Promise.allSettled([
      dblpProvider.search(query, { ...opts, num: limit }),
      s2Provider.search(query, { ...opts, num: limit }),
    ]);
    const dblpResults = dblp.status === "fulfilled" ? dblp.value : [];
    const s2Results = s2.status === "fulfilled" ? s2.value : [];
    return mergeResults(dblpResults, s2Results).slice(0, limit);
  },
};
const searchProvider: SearchProvider | null = (() => {
  if (searxngProvider && tavilyProvider) {
    return {
      search: (query: string, opts?: SearchOpts) =>
        searxngProvider.search(query, opts).catch(() => tavilyProvider.search(query, opts)),
    };
  }
  return searxngProvider ?? tavilyProvider ?? null;
})();

// 文件系统结果缓存（L1）。可通过 WEB_SERVER_CACHE_DIR 覆盖目录。
const cacheStore = createFsCacheStore();

// 响应体大小上限：防止超大 HTML 撑爆内存。可通过 WEB_SERVER_MAX_HTML_BYTES 覆盖。
const MAX_HTML_BYTES = Number(process.env.WEB_SERVER_MAX_HTML_BYTES ?? 5_242_880);

// 请求超时：可通过环境变量覆盖（毫秒）。默认 30s。
const FETCH_TIMEOUT_MS = Number(process.env.WEB_SERVER_FETCH_TIMEOUT_MS ?? 30_000);

// 创建服务器实例（高层 McpServer API：声明式注册工具 + zod 校验）
const server = new McpServer({
  name: "web-server",
  version: "2.0.0",
});

// 浏览器实例池：惰性启动 + 5 分钟空闲自动回收（避免常驻吃内存）
// --disable-blink-features=AutomationControlled: 不暴露自动化标记(提升兼容性)
const browserPool = new BrowserPool<Browser>(
  () =>
    chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    }),
  5 * 60_000
);

// 反检测初始化脚本:隐藏 navigator.webdriver 等自动化标记(让中等反爬站点不拦)
const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
window.chrome = window.chrome || { runtime: {} };
`;
const REAL_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 获取浏览器实例（首次惰性启动，每次刷新空闲计时）
async function getBrowser(): Promise<Browser> {
  return browserPool.acquire();
}

// 主动关闭浏览器（SIGINT/SIGTERM 时调用）
async function closeBrowser(): Promise<void> {
  return browserPool.close();
}

// URL验证函数
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// shouldUseBrowser 已移除(关键词猜测)→ 改用内容长度阈值(<300 字 = 疑似 SPA → Playwright)
// Jina Reader 引擎已移除（付费第三方服务）；engine="jina" 会在 dispatchFetch 中返回明确错误。

// 使用Playwright获取网页内容（每次重试用全新 page；瞬时超时/网络错误自动重试）
async function fetchWithPlaywright(url: string): Promise<FetchResult> {
  try {
    await assertSafeFetchUrl(url);
    const browserInstance = await getBrowser();
    return await withRetry(async () => {
      let context: BrowserContext | null = null;
      try {
        context = await browserInstance.newContext({
          userAgent: REAL_UA,
          extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        });
        await context.addInitScript(STEALTH_INIT_SCRIPT);
        const page = await context.newPage();

        await page.setViewportSize({ width: 1920, height: 1080 });

        // 阻止加载图片、样式表等资源以提高速度；navigation 请求逐跳检查 URL 安全性
        // （浏览器会自动跟随 HTTP redirect，需对每个跳转后的 URL 跑 assertSafeFetchUrl）
        await page.route('**/*', async (route) => {
          const request = route.request();
          const resourceType = request.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            return route.abort();
          }
          if (request.isNavigationRequest()) {
            try {
              await assertSafeFetchUrl(request.url());
            } catch {
              return route.abort();
            }
          }
          return route.continue();
        });

        // 导航到页面，设置30秒超时
        await page.goto(url, {
          timeout: FETCH_TIMEOUT_MS,
          waitUntil: 'domcontentloaded'
        });

        // 等待 SPA 内容加载完(网络空闲),最多 8s;超时也继续(已有 DOM)
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

        // 移除 cookie banner / newsletter popup / modal dialog 等浮层噪音。
        // 只在 Playwright 路径做（local 路径交给 Readability 启发式）。
        await page.evaluate(() => {
          document.querySelectorAll(
            '[role="dialog"], [aria-modal="true"], .cookie-banner, .newsletter-popup'
          ).forEach((el) => el.remove());
        });

        // 取渲染后的完整 HTML，交给统一提取管线
        const html = await page.content();
        const extracted = await extractFromHtml(html, url);

        return {
          title: extracted.title,
          content: extracted.content,
          metadata: {
            ...extracted.metadata,
            fetchedAt: new Date().toISOString(),
            contentLength: extracted.content.length,
            method: "playwright-browser",
          },
          ...(extracted.warnings?.length
            ? { warnings: extracted.warnings }
            : {}),
        };
      } finally {
        if (context) {
          await context.close();
        }
      }
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Playwright获取失败: ${error.message}`);
    }
    throw new Error(`Playwright获取失败: ${String(error)}`);
  }
}

// 本地提取网页内容的函数
async function fetchWithLocalParser(url: string): Promise<FetchResult> {
  try {
    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const r = await safeFetch(
          url,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; MCP-URLFetcher/2.0)",
            },
            signal: controller.signal,
          }
        );
        if (!r.ok) {
          throw new Error(`HTTP error! status: ${r.status}`);
        }
        return r;
      } finally {
        clearTimeout(timeoutId);
      }
    });

    // 非 .pdf 后缀但响应是 PDF（content-type 检测）→ 返回交接信号，不尝试解析
    const contentType = response.headers.get("content-type") ?? "";
    if (isPdfContentType(contentType)) {
      const handoff = buildPdfHandoff(url);
      return {
        title: handoff.title,
        content: handoff.content,
        metadata: {
          url,
          fetchedAt: new Date().toISOString(),
          contentLength: handoff.content.length,
          method: "pdf-handoff",
        },
      };
    }

    // 获取HTML内容，交给统一提取管线（限制响应体大小，防止超大页面撑爆内存）
    const html = await readLimitedText(response, MAX_HTML_BYTES);
    const extracted = await extractFromHtml(html, url);

    return {
      title: extracted.title,
      content: extracted.content,
      metadata: {
        ...extracted.metadata,
        fetchedAt: new Date().toISOString(),
        contentLength: extracted.content.length,
        method: "local-parser",
      },
      ...(extracted.warnings?.length
        ? { warnings: extracted.warnings }
        : {}),
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`本地解析请求超时（30秒）`);
      }
      throw new Error(`本地解析失败: ${error.message}`);
    }
    throw new Error(`本地解析失败: ${String(error)}`);
  }
}

// 智能获取网页内容（专用通道优先 → 本地解析 → 内容过短降级 Playwright）
// GitHub 专用通道：在通用降级管线之前短路，保证 1:1 保真
async function routeGithub(url: string): Promise<FetchResult | null> {
  if (matchRawGithub(url)) {
    const res = await withRetry(() =>
      safeFetch(url, {}).then((r) => {
        if (!r.ok) throw new Error(`GitHub raw fetch failed: ${r.status}`);
        return r;
      })
    );
    const content = await readLimitedText(res, MAX_HTML_BYTES);
    return {
      title: url.split("/").pop() ?? url,
      content,
      metadata: {
        url,
        fetchedAt: new Date().toISOString(),
        contentLength: content.length,
        method: "github-raw",
      },
    };
  }
  if (matchGithubReadme(url)) {
    const { title, content } = await fetchGithubReadme(url);
    return {
      title,
      content,
      metadata: {
        url,
        fetchedAt: new Date().toISOString(),
        contentLength: content.length,
        method: "github-readme",
      },
    };
  }
  const issueRef = matchGithubIssue(url);
  if (issueRef) {
    const { title, content } = await fetchGithubIssue(url, {
      includeComments: true,
    });
    return {
      title,
      content,
      metadata: {
        url,
        fetchedAt: new Date().toISOString(),
        contentLength: content.length,
        method: "github-issue",
      },
    };
  }
  return null;
}

// arXiv 专用通道：abs 走 API；html 透传给通用管线（null）；pdf 返回交接信号
async function routeArxiv(url: string): Promise<FetchResult | null> {
  if (matchArxivHtml(url)) {
    // arXiv 的 HTML 版质量很好，交给通用提取管线。
    return null;
  }
  if (matchArxivAbs(url)) {
    const { title, content } = await fetchArxivAbstract(url);
    return {
      title,
      content,
      metadata: {
        url,
        fetchedAt: new Date().toISOString(),
        contentLength: content.length,
        method: "arxiv-api",
      },
    };
  }
  const pdf = matchArxivPdf(url);
  if (pdf) {
    const handoff = [
      `This URL is a PDF (arXiv:${pdf.id}). This MCP server does not parse PDFs.`,
      ``,
      `Recommended: download with curl and parse with Python (PyMuPDF/pdfplumber).`,
      `Abstract: https://arxiv.org/abs/${pdf.id}`,
      `HTML: https://arxiv.org/html/${pdf.id} (if available)`,
    ].join("\n");
    return {
      title: `arXiv PDF handoff: ${pdf.id}`,
      content: handoff,
      metadata: {
        url,
        fetchedAt: new Date().toISOString(),
        contentLength: handoff.length,
        method: "pdf-handoff",
      },
    };
  }
  return null;
}

// 通用 PDF 检测：.pdf 后缀的 URL 直接返回交接信号（无需 fetch）
function routePdf(url: string): FetchResult | null {
  if (!isPdfUrl(url)) return null;
  const handoff = buildPdfHandoff(url);
  return {
    title: handoff.title,
    content: handoff.content,
    metadata: {
      url,
      fetchedAt: new Date().toISOString(),
      contentLength: handoff.content.length,
      method: "pdf-handoff",
    },
  };
}

// Stack Overflow 专用通道：questions/{id} → SE API(问题正文 + 答案)
async function routeStackOverflow(url: string): Promise<FetchResult | null> {
  if (!matchStackOverflowQuestion(url)) return null;
  const { title, content } = await fetchStackOverflowQuestion(url);
  return {
    title,
    content,
    metadata: {
      url,
      fetchedAt: new Date().toISOString(),
      contentLength: content.length,
      method: "stackoverflow-api",
    },
  };
}

// Reddit 专用通道：/r/{sub}/comments/{id} → .json(帖子 + 评论)
async function routeReddit(url: string): Promise<FetchResult | null> {
  if (!matchRedditPost(url)) return null;
  const { title, content } = await fetchRedditPost(url);
  return {
    title,
    content,
    metadata: {
      url,
      fetchedAt: new Date().toISOString(),
      contentLength: content.length,
      method: "reddit-json",
    },
  };
}

async function fetchWebContent(url: string): Promise<FetchResult> {
  // 专用通道优先（GitHub/arXiv/PDF/SO/Reddit），命中即返回，失败则抛出而非静默降级
  const dedicated =
    (await routeGithub(url)) ??
    (await routeArxiv(url)) ??
    routePdf(url) ??
    (await routeStackOverflow(url)) ??
    (await routeReddit(url));
  if (dedicated) return dedicated;

  // 通用管线：本地 fetch + Readability。内容 <300 字 → 疑似 SPA → 降级 Playwright
  try {
    const result = await fetchWithLocalParser(url);
    if (result.content.length >= 300) return result;
    // 内容过短 → 疑似 SPA → 尝试 Playwright(取更长结果)
    try {
      const pwResult = await fetchWithPlaywright(url);
      return pwResult.content.length > result.content.length ? pwResult : result;
    } catch {
      return result;
    }
  } catch (localError) {
    const msg = localError instanceof Error ? localError.message : String(localError);
    if (msg.includes("404")) throw localError;
    return await fetchWithPlaywright(url);
  }
}

// 引擎调度：auto = 专用通道 + 本地优先降级；local/playwright 强制指定引擎。
async function dispatchFetch(url: string, engine: string): Promise<FetchResult> {
  switch (engine) {
    case "local":
      return fetchWithLocalParser(url);
    case "playwright":
      return fetchWithPlaywright(url);
    case "jina":
      throw new McpError(
        ErrorCode.InvalidParams,
        "Jina Reader 引擎已移除（付费第三方服务）。请使用 auto / local / playwright。"
      );
    case "auto":
    default:
      return fetchWebContent(url);
  }
}

// dispatchFetch + L1 缓存：noCache 时绕过并刷新
async function cachedFetch(
  url: string,
  engine: string,
  noCache: boolean
): Promise<FetchResult> {
  return withCache(
    url,
    engine,
    { noCache },
    () => dispatchFetch(url, engine),
    cacheStore,
    Date.now()
  );
}

// 并发受限的批量执行（实现见 concurrency.ts，保持结果顺序、每项独立 settle）

const engineSchema = z
  .enum(["auto", "local", "playwright", "jina"])
  .default("auto")
  .describe(
    "auto=自动路由（默认）；local=强制本地解析；playwright=强制浏览器；jina=已移除（付费第三方，调用会报错）"
  );

// 读取单个 URL
const readUrlOutputSchema: ZodRawShape = {
  source: z.object({
    id: z.string(),
    title: z.string(),
    url: z.string(),
    fetchedAt: z.string(),
    method: z.string(),
    description: z.string().nullable(),
    author: z.string().nullable(),
    siteName: z.string().nullable(),
    publishedTime: z.string().nullable(),
    canonicalUrl: z.string().nullable(),
  }),
  paragraphs: z.array(
    z.object({
      index: z.number(),
      headingPath: z.array(z.string()),
      startOffset: z.number(),
      endOffset: z.number(),
      textPreview: z.string(),
    })
  ),
  links: z.array(
    z.object({
      text: z.string(),
      url: z.string(),
    })
  ),
  warnings: z.array(z.string()).nullable(),
};

const readUrlInputSchema = {
  url: z.string().describe("要读取的网页 URL（http/https）"),
  engine: engineSchema,
  no_cache: z.boolean().default(false).describe("为 true 时跳过缓存、重新抓取"),
  with_links: z
    .boolean()
    .default(false)
    .describe("为 true 时在结果末尾附上正文中的链接清单（供 agent 决定是否递归探索）"),
  source_id: z
    .string()
    .optional()
    .describe(
      "可选来源 ID（如 web_search 返回的 S1）。仅在 structuredContent.source.id 体现，" +
        "让 agent 把搜索结果与阅读结果在客户端侧关联；不传则按 URL hash 生成。"
    ),
};

const readUrlHandler: ToolCallback<typeof readUrlInputSchema> = async ({
  url,
  engine,
  no_cache,
  with_links,
  source_id,
}) => {
  if (!isValidUrl(url)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "无效的URL格式，请提供http或https协议的URL"
    );
  }
  const result = await cachedFetch(url, engine, no_cache);
  let text = formatFetchResult(result);
  const links = extractLinks(result.content);
  if (with_links && links.length) {
    text +=
      "\n\n## 链接\n\n" +
      links.map((l) => `- [${l.text}](${l.url})`).join("\n");
  }

  // source_id: 用户传入优先；否则按 URL 短 hash 生成（S-<6hex>）。
  const sourceId =
    source_id ??
    `S-${createHash("sha1").update(url).digest("hex").slice(0, 6)}`;

  const m = result.metadata;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      source: {
        id: sourceId,
        title: result.title,
        url: m.url,
        fetchedAt: m.fetchedAt,
        method: m.method,
        description: m.description ?? null,
        author: m.author ?? null,
        siteName: m.siteName ?? null,
        publishedTime: m.publishedTime ?? null,
        canonicalUrl: m.canonicalUrl ?? null,
      },
      paragraphs: splitParagraphs(result.content),
      links,
      warnings: result.warnings ?? null,
    },
  };
};

server.registerTool<typeof readUrlOutputSchema, typeof readUrlInputSchema>(
  "read_url",
  {
    description:
      "读取单个 URL 的内容并转为 Markdown。自动识别 GitHub / arXiv / PDF 等特殊 URL 并走最优路径；" +
      "普通网页走本地 Readability 提取，遇到访问限制自动降级到 Playwright 浏览器。",
    inputSchema: readUrlInputSchema,
    outputSchema: readUrlOutputSchema,
  },
  readUrlHandler
);

// 搜索关键词 → 返回结果列表(标题+URL+摘要);拿到 URL 后用 read_url 读全文
const webSearchInputSchema = {
  query: z.string().describe("搜索关键词"),
  topic: z
    .enum(["general", "academic", "technical", "community"])
    .default("general")
    .describe(
      "general=全网;academic=arxiv/dblp/semanticscholar/github;" +
        "technical=stackoverflow/github/dev.to/MDN;community=reddit/HN"
    ),
  domains: z
    .array(z.string())
    .optional()
    .describe("自定义域名列表(优先于 topic),如 ['juejin.cn']"),
  num: z.number().int().positive().max(50).default(10).describe("返回结果数上限"),
  categories: z
    .string()
    .optional()
    .describe("SearXNG 分类,如 general / it / images"),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe(
      "时效过滤:day/week/month/year。" +
        "SearXNG 透传 time_range;Tavily 映射 days;academic 后端不支持(applied=false)"
    ),
};

const webSearchOutputSchema: ZodRawShape = {
  query: z.string(),
  backend: z.string(),
  recency: z.string().nullable(),
  recencyApplied: z.boolean(),
  results: z.array(
    z.object({
      id: z.string(),
      rank: z.number(),
      title: z.string(),
      url: z.string(),
      snippet: z.string().nullable(),
      source: z.string(),
    })
  ),
};

const webSearchHandler: ToolCallback<typeof webSearchInputSchema> = async ({
  query,
  topic,
  domains,
  num,
  categories,
  recency,
}) => {
  // academic topic → DBLP(免费、CCF 全覆盖),不走网页搜索
  const isAcademic = topic === "academic";
  const provider = isAcademic ? academicProvider : searchProvider;
  if (!provider) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "未配置搜索后端:设 TAVILY_API_KEY 或 SEARXNG_URL。(topic=academic 无需配置,走 DBLP。)"
    );
  }
  const results = await provider.search(query, {
    num,
    categories,
    topic,
    domains,
    recency,
  });
  // academic 后端(DBLP/S2)不支持时间过滤;其他后端透传
  const recencyApplied = !!recency && !isAcademic;
  const backend = isAcademic
    ? "academic"
    : searxngProvider && tavilyProvider
      ? "searxng+tavily"
      : searxngProvider
        ? "searxng"
        : "tavily";

  const structuredResults = results.map((r, i) => ({
    id: `S${i + 1}`,
    rank: i + 1,
    title: r.title,
    url: r.url,
    snippet: r.snippet ?? null,
    source: backend,
  }));

  let text: string;
  if (results.length === 0) {
    text = `# 搜索结果: ${query}\n\n无结果。` +
      (recency ? `\n\nDate filter: ${recency} (applied: ${recencyApplied})` : "");
  } else {
    text = `# 搜索结果: ${query}\n\n`;
    results.forEach((r, i) => {
      text += `## ${i + 1}. ${r.title}\n${r.url}\n`;
      if (r.snippet) text += `${r.snippet}\n`;
      text += "\n";
    });
    if (recency) {
      text += `\nDate filter: ${recency} (applied: ${recencyApplied})\n`;
    }
  }

  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      query,
      backend,
      recency: recency ?? null,
      recencyApplied,
      results: structuredResults,
    },
  };
};

server.registerTool<typeof webSearchOutputSchema, typeof webSearchInputSchema>(
  "web_search",
  {
    description:
      "搜索关键词,返回结果列表(标题+URL+摘要)。拿到 URL 后用 read_url 读取全文。" +
      "后端:配 TAVILY_API_KEY 用 Tavily,或 SEARXNG_URL 用 SearXNG。" +
      "topic 可按学术/技术/社区分类自动限定域名;domains 可自定义覆盖。",
    inputSchema: webSearchInputSchema,
    outputSchema: webSearchOutputSchema,
  },
  webSearchHandler
);

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Web Server v2.0 已启动（GitHub/arXiv 专用通道 + Readability + Playwright）");
}

// 优雅关闭处理
process.on('SIGINT', async () => {
  console.error("接收到SIGINT信号，正在关闭浏览器...");
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error("接收到SIGTERM信号，正在关闭浏览器...");
  await closeBrowser();
  process.exit(0);
});

main().catch((error) => {
  console.error("服务器启动失败:", error);
  process.exit(1);
});