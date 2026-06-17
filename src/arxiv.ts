/**
 * arXiv dedicated channel.
 *
 * arXiv abstract pages are fetched via the Atom API for structured metadata
 * (title/authors/abstract/categories/links) rather than scraped. HTML versions
 * fall through to the generic pipeline; PDFs are handed off (the reader does
 * not parse PDFs).
 */

import { JSDOM } from "jsdom";
import { withRetry } from "./retry.js";

export interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  primaryCategory?: string;
  categories: string[];
  pdfUrl?: string;
  htmlUrl?: string;
  absUrl?: string;
}

export interface ArxivRef {
  id: string;
}

// ---- Pure matchers / parser / renderer (TDD'd) ----

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function matchArxivSegment(url: string, kind: "abs" | "html" | "pdf"): ArxivRef | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== "arxiv.org") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === kind) {
    let id = segments[1];
    if (kind === "pdf" && id.endsWith(".pdf")) id = id.slice(0, -4);
    return { id };
  }
  return null;
}

/** Match `arxiv.org/abs/{id}` (arXiv ID may be versioned, e.g. 2501.12345v2). */
export function matchArxivAbs(url: string): ArxivRef | null {
  return matchArxivSegment(url, "abs");
}

/** Match `arxiv.org/html/{id}`. */
export function matchArxivHtml(url: string): ArxivRef | null {
  return matchArxivSegment(url, "html");
}

/** Match `arxiv.org/pdf/{id}` (optionally with a `.pdf` suffix). */
export function matchArxivPdf(url: string): ArxivRef | null {
  return matchArxivSegment(url, "pdf");
}

/** Parse an arXiv Atom API response into a structured entry (null if no entry). */
export function parseArxivAtom(xml: string): ArxivEntry | null {
  const dom = new JSDOM(xml, { contentType: "application/xml" });
  const entry = dom.window.document.querySelector("entry");
  if (!entry) return null;

  const text = (sel: string): string =>
    entry.querySelector(sel)?.textContent?.trim() ?? "";

  const authors = Array.from(entry.querySelectorAll("author > name"))
    .map((n) => n.textContent?.trim() ?? "")
    .filter(Boolean);

  const categories = Array.from(entry.querySelectorAll("category"))
    .map((c) => c.getAttribute("term") ?? "")
    .filter(Boolean);

  const primaryEl = Array.from(entry.getElementsByTagName("*")).find(
    (el) => el.localName === "primary_category"
  );
  const primaryCategory =
    primaryEl?.getAttribute("term") ?? categories[0] ?? undefined;

  let pdfUrl: string | undefined;
  let htmlUrl: string | undefined;
  let absUrl: string | undefined;
  for (const link of Array.from(entry.querySelectorAll("link"))) {
    const href = link.getAttribute("href") ?? "";
    const title = link.getAttribute("title") ?? "";
    const rel = link.getAttribute("rel") ?? "";
    if (title === "pdf" || href.includes("/pdf/")) pdfUrl = href;
    else if (href.includes("/html/")) htmlUrl = href;
    else if (rel === "alternate" && href.includes("/abs/")) absUrl = href;
  }

  const idUrl = text("id");
  const id = idUrl.includes("/abs/") ? idUrl.split("/abs/")[1] : idUrl;

  return {
    id,
    title: text("title"),
    summary: text("summary"),
    authors,
    published: text("published"),
    updated: text("updated"),
    primaryCategory,
    categories,
    pdfUrl,
    htmlUrl,
    absUrl,
  };
}

/** Render an arXiv entry to markdown. */
export function renderArxivEntryToMarkdown(entry: ArxivEntry): string {
  const lines: string[] = [];
  lines.push(`# ${entry.title}`);
  lines.push("");
  lines.push(
    `**arxiv:${entry.id}** · ${entry.primaryCategory ?? "uncategorized"} · ` +
      `published ${entry.published} · updated ${entry.updated}`
  );

  if (entry.authors.length) {
    lines.push("");
    lines.push(`**Authors**: ${entry.authors.join(", ")}`);
  }

  lines.push("");
  lines.push("## Abstract");
  lines.push("");
  lines.push(entry.summary);

  const linkParts: string[] = [];
  if (entry.pdfUrl) linkParts.push(`[PDF](${entry.pdfUrl})`);
  if (entry.htmlUrl) linkParts.push(`[HTML](${entry.htmlUrl})`);
  if (entry.absUrl) linkParts.push(`[Abstract](${entry.absUrl})`);
  if (linkParts.length) {
    lines.push("");
    lines.push(`**Links**: ${linkParts.join(" · ")}`);
  }

  return lines.join("\n").trim();
}

// ---- Network wrapper (thin; not unit-tested — boundary) ----

export interface ArxivContent {
  title: string;
  content: string;
}

/**
 * Fetch an arXiv abstract page via the Atom API (no key required; arXiv asks
 * for >=3s between requests). Returns structured metadata rendered to markdown.
 */
export async function fetchArxivAbstract(url: string): Promise<ArxivContent> {
  const ref = matchArxivAbs(url);
  if (!ref) throw new Error(`not an arXiv abs URL: ${url}`);
  const api = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ref.id)}`;
  const res = await withRetry(() =>
    fetch(api).then((r) => {
      if (!r.ok) throw new Error(`arXiv API fetch failed: ${r.status}`);
      return r;
    })
  );
  const entry = parseArxivAtom(await res.text());
  if (!entry) throw new Error(`arXiv returned no entry for ${ref.id}`);
  return { title: entry.title, content: renderArxivEntryToMarkdown(entry) };
}
