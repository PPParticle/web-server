/**
 * Unified HTML extraction pipeline.
 *
 * All fetch engines (local, Playwright) produce raw HTML; this module turns
 * it into clean markdown + structured metadata. Single source of truth for
 * extraction so quality is consistent regardless of how the HTML was obtained.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { findAdapter } from "./adapters.js";

export interface ExtractMetadata {
  url: string;
  description?: string;
  author?: string;
  siteName?: string;
  publishedTime?: string;
  canonicalUrl?: string;
}

export interface ExtractResult {
  title: string;
  content: string;
  metadata: ExtractMetadata;
  warnings?: string[];
}

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndownService.addRule("skipScripts", {
  filter: ["script", "style", "noscript"],
  replacement: () => "",
});
// Readability strips `class` from <code>, losing the language. We preserve it
// as a `data-language` attribute on <pre> (which Readability keeps) and read
// it here when converting to a fenced block.
turndownService.addRule("fencedCodeBlockWithLang", {
  filter: ["pre"],
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const lang = el.getAttribute("data-language") || "";
    const code = el.querySelector("code");
    const text = (code?.textContent ?? el.textContent ?? "").replace(/\n$/, "");
    return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
  },
});
// Convert HTML tables to markdown tables (turndown leaves them as HTML by
// default). Empty tables are dropped; tables whose first row has no <th>
// get a synthetic empty header row so the first data row isn't mistaken
// for the header.
turndownService.addRule("tableConverter", {
  filter: ["table"],
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const rows = Array.from(el.querySelectorAll("tr"));
    if (rows.length === 0) return "";

    const cellText = (c: Element): string =>
      (c.textContent ?? "")
        .replace(/\n/g, " ")
        .trim()
        .replace(/\|/g, "\\|") || "";

    // Skip tables where every cell is empty/whitespace.
    const allCellsEmpty = rows.every((row) => {
      const cells = Array.from(row.querySelectorAll("th,td"));
      return cells.length === 0 || cells.every((c) => !cellText(c));
    });
    if (allCellsEmpty) return "";

    const renderRow = (row: Element): string => {
      const cells = Array.from(row.querySelectorAll("th,td"));
      const cellTexts = cells.map((c) => cellText(c) || " ");
      return `| ${cellTexts.join(" | ")} |`;
    };

    const firstRowHasTh =
      Array.from(rows[0].querySelectorAll("th")).length > 0;

    const lines: string[] = [];
    let bodyRows = rows;
    if (!firstRowHasTh) {
      // Determine column count from the widest body row.
      const colCount = rows.reduce(
        (max, row) =>
          Math.max(max, row.querySelectorAll("th,td").length),
        0
      );
      if (colCount === 0) return "";
      lines.push(`| ${Array(colCount).fill(" ").join(" | ")} |`);
      lines.push(`| ${Array(colCount).fill("---").join(" | ")} |`);
    } else {
      lines.push(renderRow(rows[0]));
      const headerCells = Array.from(rows[0].querySelectorAll("th,td"));
      lines.push(`| ${headerCells.map(() => "---").join(" | ")} |`);
      bodyRows = rows.slice(1);
    }
    for (const row of bodyRows) lines.push(renderRow(row));

    return `\n\n${lines.join("\n")}\n\n`;
  },
});

/**
 * Extract clean markdown + metadata from raw HTML.
 *
 * @param html - Raw HTML string from any fetch engine.
 * @param url  - The URL the HTML came from (used for Readability link
 *               resolution and metadata).
 */
export async function extractFromHtml(
  html: string,
  url: string
): Promise<ExtractResult> {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // Preserve code block languages before Readability strips the <code> class.
  for (const code of Array.from(document.querySelectorAll("pre > code[class]"))) {
    const match = code.className.match(/language-([\w-]+)/);
    if (match && code.parentElement) {
      code.parentElement.setAttribute("data-language", match[1]);
    }
  }

  // Site adapter: prefer a host-specific main-content selector before
  // Readability (which is robust but misses some platform-specific layouts).
  const adapter = findAdapter(url);
  let adapterHtml: string | null = null;
  if (adapter) {
    const node = document.querySelector(adapter.selector);
    if (node) adapterHtml = (node as HTMLElement).innerHTML;
  }

  // Extract metadata + JSON-LD BEFORE Readability — it mutates the input
  // document and strips <script> blocks, which would lose JSON-LD otherwise.
  const metadata = extractMetadata(document, url);
  applyJsonLdFallback(document, metadata);

  const article =
    adapterHtml !== null ? null : new Readability(document).parse();
  const contentHtml = adapterHtml ?? article?.content ?? document.body.innerHTML;
  const content = turndownService
    .turndown(contentHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const title = article?.title ?? document.title ?? "";
  const warnings = detectWarnings(title, content);

  return {
    title,
    content,
    metadata,
    ...(warnings.length ? { warnings } : {}),
  };
}

const META_SELECTORS: ReadonlyArray<
  [keyof Omit<ExtractMetadata, "url" | "canonicalUrl">, string[]]
> = [
  ["description", ['meta[property="og:description"]', 'meta[name="description"]']],
  ["siteName", ['meta[property="og:site_name"]']],
  ["author", ['meta[property="article:author"]', 'meta[name="author"]']],
  ["publishedTime", ['meta[property="article:published_time"]']],
];

const ARTICLE_LIKE_TYPES = new Set([
  "Article",
  "BlogPosting",
  "TechArticle",
  "NewsArticle",
]);

/** Convert an HTML fragment to markdown using the shared turndown config. */
export function htmlToMarkdown(html: string): string {
  return turndownService.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

function extractMetadata(document: Document, url: string): ExtractMetadata {
  const metadata: ExtractMetadata = { url };
  for (const [key, selectors] of META_SELECTORS) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content");
      if (value) {
        metadata[key] = value;
        break;
      }
    }
  }
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");
  if (canonical) metadata.canonicalUrl = canonical;
  return metadata;
}

/**
 * Fill missing metadata fields from JSON-LD Article/BlogPosting blocks.
 * Only acts as a fallback — never overwrites a value already set by og/meta.
 */
function applyJsonLdFallback(
  document: Document,
  metadata: ExtractMetadata
): void {
  for (const node of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(node.textContent ?? "");
    } catch {
      continue;
    }
    // JSON-LD can be a single object or an array; only @type Article-like
    // blocks are relevant.
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      const obj = c as { "@type"?: unknown };
      const type = obj?.["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (!types.some((t) => ARTICLE_LIKE_TYPES.has(String(t)))) continue;
      const ld = c as {
        headline?: string;
        description?: string;
        datePublished?: string;
        author?: { name?: string } | string;
      };
      if (!metadata.description && ld.description) {
        metadata.description = String(ld.description);
      }
      if (!metadata.publishedTime && ld.datePublished) {
        metadata.publishedTime = String(ld.datePublished);
      }
      const authorName =
        typeof ld.author === "string" ? ld.author : ld.author?.name;
      if (!metadata.author && authorName) {
        metadata.author = String(authorName);
      }
      return;
    }
  }
}

/**
 * Surface low-quality signals (login walls, empty title, suspiciously short
 * body) so the agent can decide to switch sources. Not rendered into Markdown.
 */
function detectWarnings(title: string, content: string): string[] {
  const warnings: string[] = [];
  if (!title.trim()) warnings.push("empty_title");
  // Skip content_too_short for dedicated handoff/shim content (PDF handoff is
  // short by design); the caller propagates warnings only when relevant.
  if (content.length < 300) warnings.push("content_too_short");
  if (/sign\s*in|log\s*in|captcha|enable\s+javascript/i.test(content)) {
    warnings.push("possible_login_page");
  }
  return warnings;
}
