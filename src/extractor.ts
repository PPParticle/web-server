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
}

export interface ExtractResult {
  title: string;
  content: string;
  metadata: ExtractMetadata;
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
// default). First row is treated as the header, per markdown table convention.
turndownService.addRule("tableConverter", {
  filter: ["table"],
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const rows = Array.from(el.querySelectorAll("tr"));
    if (rows.length === 0) return "";
    const lines = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll("th,td"));
      const cellTexts = cells.map(
        (c) =>
          (c.textContent ?? "")
            .replace(/\n/g, " ")
            .trim()
            .replace(/\|/g, "\\|") || " "
      );
      return `| ${cellTexts.join(" | ")} |`;
    });
    // Separator after the first (header) row — required by markdown tables.
    const headerCells = Array.from(rows[0].querySelectorAll("th,td"));
    const sep = `| ${headerCells.map(() => "---").join(" | ")} |`;
    lines.splice(1, 0, sep);
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

  const article =
    adapterHtml !== null ? null : new Readability(document).parse();
  const contentHtml = adapterHtml ?? article?.content ?? document.body.innerHTML;
  const content = turndownService
    .turndown(contentHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: article?.title ?? document.title ?? "",
    content,
    metadata: extractMetadata(document, url),
  };
}

const META_SELECTORS: ReadonlyArray<
  [keyof Omit<ExtractMetadata, "url">, string]
> = [
  ["description", 'meta[property="og:description"]'],
  ["siteName", 'meta[property="og:site_name"]'],
  ["author", 'meta[property="article:author"]'],
  ["publishedTime", 'meta[property="article:published_time"]'],
];

/** Convert an HTML fragment to markdown using the shared turndown config. */
export function htmlToMarkdown(html: string): string {
  return turndownService.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

function extractMetadata(document: Document, url: string): ExtractMetadata {
  const metadata: ExtractMetadata = { url };
  for (const [key, selector] of META_SELECTORS) {
    const value = document.querySelector(selector)?.getAttribute("content");
    if (value) metadata[key] = value;
  }
  return metadata;
}
