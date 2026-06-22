/**
 * Web search — pluggable search providers, used by the `web_search` tool to
 * find URLs (which the agent then reads via `read_url`). Pure URL/parse logic
 * is split out so it is unit-testable; the network call is a thin boundary.
 */

import { withRetry } from "./retry.js";

/** Per-request timeout for search API calls. Configurable via env. */
const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SERVER_SEARCH_TIMEOUT_MS ?? 30_000);

/**
 * Fetch with abort: mirrors the pattern used in index.ts but extracted here
 * so each provider shares the same timeout behavior.
 */
function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timeoutId)
  );
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchOpts {
  num?: number;
  categories?: string;
  pageno?: number;
  topic?: SearchTopic;
  domains?: string[];
  recency?: Recency;
}

export type SearchTopic = "general" | "academic" | "technical" | "community";

export type Recency = "day" | "week" | "month" | "year";

/** Tavily uses a "days back" integer rather than a named range. */
const RECENCY_TO_DAYS: Record<Recency, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const TOPIC_DOMAINS: Record<SearchTopic, string[]> = {
  general: [],
  academic: ["arxiv.org", "dblp.org", "semanticscholar.org", "github.com"],
  technical: ["stackoverflow.com", "github.com", "dev.to", "developer.mozilla.org"],
  community: ["reddit.com", "news.ycombinator.com"],
};

/** Map a search topic to its preset domain list. */
export function topicToDomains(topic: SearchTopic): string[] {
  return TOPIC_DOMAINS[topic] ?? [];
}

/** Resolve effective domains: explicit `domains` overrides `topic` presets. */
export function resolveDomains(opts?: SearchOpts): string[] | undefined {
  if (opts?.domains?.length) return opts.domains;
  if (opts?.topic && opts.topic !== "general") return topicToDomains(opts.topic);
  return undefined;
}

export interface SearchProvider {
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
}

/** Build a SearXNG JSON search URL from a base instance URL. */
export function buildSearxngUrl(
  baseUrl: string,
  query: string,
  opts?: SearchOpts
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const u = new URL(base + "/search");
  const domains = resolveDomains(opts);
  const q = domains?.length
    ? `${query} (${domains.map((d) => `site:${d}`).join(" OR ")})`
    : query;
  u.searchParams.set("q", q);
  u.searchParams.set("format", "json");
  if (opts?.categories) u.searchParams.set("categories", opts.categories);
  if (opts?.pageno) u.searchParams.set("pageno", String(opts.pageno));
  if (opts?.recency) u.searchParams.set("time_range", opts.recency);
  return u.toString();
}

/** Parse a SearXNG JSON response body into deduped SearchResults. */
export function parseSearxngResponse(json: string): SearchResult[] {
  try {
    return extractResults(JSON.parse(json));
  } catch {
    return [];
  }
}

/** Parse a Tavily JSON response body into deduped SearchResults. */
export function parseTavilyResponse(json: string): SearchResult[] {
  try {
    return extractResults(JSON.parse(json));
  } catch {
    return [];
  }
}

// SearXNG and Tavily both return { results: [{title,url,content}] } — share the
// extraction so the two APIs don't drift apart.
function extractResults(parsed: unknown): SearchResult[] {
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const item = r as { title?: string; url?: string; content?: string };
    if (typeof item.url !== "string" || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({
      title: typeof item.title === "string" ? item.title : "",
      url: item.url,
      ...(typeof item.content === "string" && item.content
        ? { snippet: item.content }
        : {}),
    });
  }
  return out;
}

/** Build a Tavily search request body (api_key added by the provider). */
export function buildTavilyBody(
  query: string,
  opts?: SearchOpts
): Record<string, unknown> {
  const body: Record<string, unknown> = { query, max_results: opts?.num ?? 10 };
  const domains = resolveDomains(opts);
  if (domains?.length) body.include_domains = domains;
  if (opts?.recency) body.days = RECENCY_TO_DAYS[opts.recency];
  return body;
}

// ---- Network provider (boundary; not unit-tested) ----

/** Create a SearXNG-backed SearchProvider pointing at `baseUrl`. */
export function createSearxngProvider(baseUrl: string): SearchProvider {
  return {
    search: async (query, opts) => {
      const url = buildSearxngUrl(baseUrl, query, opts);
      const res = await withRetry(() =>
        fetchWithTimeout(url, { headers: { Accept: "application/json" } }).then((r) => {
          if (!r.ok) throw new Error(`SearXNG search failed: ${r.status}`);
          return r;
        })
      );
      const results = parseSearxngResponse(await res.text());
      return opts?.num ? results.slice(0, opts.num) : results;
    },
  };
}

/** Create a Tavily-backed SearchProvider (POST api.tavily.com/search, Bearer key). */
export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    search: async (query, opts) => {
      const body = buildTavilyBody(query, opts);
      const res = await withRetry(() =>
        fetchWithTimeout("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        }).then((r) => {
          if (!r.ok) throw new Error(`Tavily search failed: ${r.status}`);
          return r;
        })
      );
      const results = parseTavilyResponse(await res.text());
      return opts?.num ? results.slice(0, opts.num) : results;
    },
  };
}

// ---- DBLP provider (academic paper search) ----

/** Parse a DBLP search API JSON response into SearchResults. */
export function parseDblpResponse(json: string): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const hits = (
    parsed as { result?: { hits?: { hit?: unknown[] } } }
  )?.result?.hits?.hit;
  if (!Array.isArray(hits)) return [];

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const h of hits) {
    const info = (h as { info?: Record<string, unknown> })?.info;
    if (!info) continue;
    const title = String(info.title ?? "");
    const dblpUrl = String(info.url ?? "");
    const ee = String(info.ee ?? "");
    const url = dblpUrl || ee;
    if (!url || seen.has(url)) continue;
    seen.add(url);

    // Build snippet: "Author1, Author2 · VENUE · YEAR"
    const authorField = (info.authors as { author?: unknown })?.author;
    let authorNames: string[] = [];
    if (Array.isArray(authorField)) {
      authorNames = authorField
        .map((a) => (a as { text?: string })?.text ?? "")
        .filter(Boolean);
    } else if (authorField && typeof authorField === "object") {
      const name = (authorField as { text?: string }).text;
      if (name) authorNames = [name];
    }
    const venue = String(info.venue ?? "");
    const year = String(info.year ?? "");
    const parts: string[] = [];
    if (authorNames.length)
      parts.push(
        authorNames.slice(0, 3).join(", ") +
          (authorNames.length > 3 ? " et al." : "")
      );
    if (venue) parts.push(venue);
    if (year) parts.push(year);
    if (ee && ee !== url) parts.push(`DOI: ${ee}`);

    out.push({
      title,
      url,
      ...(parts.length ? { snippet: parts.join(" · ") } : {}),
    });
  }
  return out;
}

/** Create a DBLP-backed SearchProvider (free, no key; CCF venue coverage). */
export function createDblpProvider(): SearchProvider {
  return {
    search: async (query, opts) => {
      const limit = opts?.num ?? 20;
      const apiUrl = `https://dblp.org/search/publ/api?q=${encodeURIComponent(
        query
      )}&format=json&h=${limit}`;
      const res = await withRetry(() =>
        fetchWithTimeout(apiUrl, { headers: { Accept: "application/json" } }).then((r) => {
          if (!r.ok) throw new Error(`DBLP search failed: ${r.status}`);
          return r;
        })
      );
      return parseDblpResponse(await res.text());
    },
  };
}

// ---- Semantic Scholar provider (abstract search + venue filter) ----

const DEFAULT_VENUES =
  "OSDI,SOSP,ASPLOS,ISCA,MICRO,SIGCOMM,NSDI,FAST,EuroSys,ATC,VLDB,SIGMOD,ICDE,NeurIPS,ICML,ICLR,AAAI,IJCAI,CoRR";

/** Parse a Semantic Scholar API JSON response into SearchResults. */
export function parseSemanticScholarResponse(json: string): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const data = parsed as { data?: unknown[] };
  const items = data?.data;
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of items) {
    const p = item as {
      title?: string;
      abstract?: string;
      url?: string;
      openAccessPdf?: { url?: string };
      externalIds?: { DOI?: string };
      venue?: string;
      year?: number;
      citationCount?: number;
      authors?: { name?: string }[];
    };
    const title = p.title ?? "";
    const url =
      p.openAccessPdf?.url ??
      (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : undefined) ??
      p.url ??
      "";
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const authorNames = (p.authors ?? [])
      .map((a) => a.name ?? "")
      .filter(Boolean);
    const metaParts: string[] = [];
    if (authorNames.length)
      metaParts.push(
        authorNames.slice(0, 3).join(", ") +
          (authorNames.length > 3 ? " et al." : "")
      );
    if (p.venue) metaParts.push(p.venue);
    if (p.year) metaParts.push(String(p.year));
    if (p.citationCount !== undefined)
      metaParts.push(`${p.citationCount} citations`);
    const metaStr = metaParts.join(" · ");
    const abstractStr = p.abstract
      ? p.abstract.slice(0, 200) + (p.abstract.length > 200 ? "..." : "")
      : "";

    out.push({
      title,
      url,
      snippet: [metaStr, abstractStr].filter(Boolean).join(" | "),
    });
  }
  return out;
}

/** Create a Semantic Scholar-backed SearchProvider (abstract search + venue filter, free). */
export function createSemanticScholarProvider(): SearchProvider {
  return {
    search: async (query, opts) => {
      const limit = opts?.num ?? 10;
      const fields =
        "title,abstract,authors,venue,year,citationCount,externalIds,openAccessPdf,url";
      const params = new URLSearchParams({
        query,
        fields,
        limit: String(limit),
      });
      const apiUrl = `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
      const res = await withRetry(() =>
        fetchWithTimeout(apiUrl, { headers: { Accept: "application/json" } }).then((r) => {
          if (!r.ok) throw new Error(`Semantic Scholar search failed: ${r.status}`);
          return r;
        })
      );
      return parseSemanticScholarResponse(await res.text());
    },
  };
}

/** Merge two result lists, deduplicating by normalized URL. */
export function mergeResults(a: SearchResult[], b: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of [...a, ...b]) {
    const key = r.url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
