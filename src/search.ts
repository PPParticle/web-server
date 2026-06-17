/**
 * Web search — pluggable search providers, used by the `web_search` tool to
 * find URLs (which the agent then reads via `read_url`). Pure URL/parse logic
 * is split out so it is unit-testable; the network call is a thin boundary.
 */

import { withRetry } from "./retry.js";

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
}

export type SearchTopic = "general" | "academic" | "technical" | "community";

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
  return body;
}

// ---- Network provider (boundary; not unit-tested) ----

/** Create a SearXNG-backed SearchProvider pointing at `baseUrl`. */
export function createSearxngProvider(baseUrl: string): SearchProvider {
  return {
    search: async (query, opts) => {
      const url = buildSearxngUrl(baseUrl, query, opts);
      const res = await withRetry(() =>
        fetch(url, { headers: { Accept: "application/json" } }).then((r) => {
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
        fetch("https://api.tavily.com/search", {
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
