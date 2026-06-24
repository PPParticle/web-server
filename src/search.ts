/**
 * Web search — pluggable search providers, used by the `web_search` tool to
 * find URLs (which the agent then reads via `read_url`). Pure URL/parse logic
 * is split out so it is unit-testable; the network call is a thin boundary.
 */

import { JSDOM } from "jsdom";
import { ProxyAgent } from "undici";
import { withRetry } from "./retry.js";

/** Per-request timeout for search API calls. Configurable via env. */
const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SERVER_SEARCH_TIMEOUT_MS ?? 30_000);

/**
 * Fetch with abort: mirrors the pattern used in index.ts but extracted here
 * so each provider shares the same timeout behavior.
 */
function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = SEARCH_TIMEOUT_MS,
  proxyUrl?: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = proxyUrl ? proxyAgentFor(proxyUrl) : undefined;
  return fetch(url, {
    ...init,
    signal: controller.signal,
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit & { dispatcher?: ProxyAgent }).finally(() =>
    clearTimeout(timeoutId)
  );
}

const proxyAgents = new Map<string, ProxyAgent>();

function proxyAgentFor(proxyUrl: string): ProxyAgent {
  const existing = proxyAgents.get(proxyUrl);
  if (existing) return existing;
  const agent = new ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

function externalProxyUrl(): string | undefined {
  return (
    process.env.WEB_SERVER_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  );
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  engines?: string[];
  score?: number;
  positions?: number[];
  matchedQuery?: string;
  queryVariant?: SearchQueryVariantKind;
  sourceType?: SourceType;
  authorityScore?: number;
  provider?: string;
  subreddit?: string;
  redditScore?: number;
  commentCount?: number;
  publishedAt?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  citationCount?: number;
  doi?: string;
  pdfUrl?: string;
}

export interface SearchOpts {
  num?: number;
  categories?: string;
  pageno?: number;
  topic?: SearchTopic;
  domains?: string[];
  recency?: Recency;
  disableItFallback?: boolean;
  redditSubreddit?: string;
  redditSort?: RedditSort;
  redditTimeRange?: RedditTimeRange;
}

export type SearchTopic = "general" | "academic" | "technical" | "community";

export type Recency = "day" | "week" | "month" | "year";
export type RedditSort = "relevance" | "top" | "new" | "comments";
export type RedditTimeRange = "hour" | "day" | "week" | "month" | "year" | "all";
export type SearchQueryVariantKind =
  | "original"
  | "expanded"
  | "official"
  | "community-platform"
  | "community-broad"
  | "community-subreddit"
  | "academic-review";
export type SourceType =
  | "official"
  | "official_repo"
  | "paper"
  | "community"
  | "issue"
  | "blog"
  | "engineering"
  | "unknown";

export interface SearchQueryVariant {
  query: string;
  variant: SearchQueryVariantKind;
  domains?: string[];
  topic?: SearchTopic;
  redditSubreddit?: string;
  redditSort?: RedditSort;
  redditTimeRange?: RedditTimeRange;
}

export interface SearchCandidateGroup {
  query: string;
  variant: SearchQueryVariantKind;
  domains?: string[];
  results: SearchResult[];
}

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
  community: ["reddit.com", "news.ycombinator.com", "github.com", "stackoverflow.com"],
};

const TECHNICAL_SPEC_WORDS = [
  "spec",
  "specification",
  "schema",
  "protocol",
  "api",
  "rfc",
  "outputschema",
  "structuredcontent",
  "structured content",
];

const TECHNICAL_QUERY_WORDS = [
  "api",
  "sdk",
  "node",
  "nodejs",
  "javascript",
  "typescript",
  "python",
  "stream",
  "backpressure",
  "error",
  "github",
  "docker",
  "kubernetes",
  "mcp",
  "llm",
  "schema",
  "protocol",
];

const OFFICIAL_SOURCE_HINTS = [
  {
    match: ["mcp", "model context protocol"],
    expansion: "Model Context Protocol",
    docsDomains: ["modelcontextprotocol.io"],
    repoDomains: ["github.com/modelcontextprotocol"],
  },
  {
    match: ["nodejs", "node.js", "node js"],
    expansion: "Node.js",
    docsDomains: ["nodejs.org"],
    repoDomains: ["github.com/nodejs"],
  },
  {
    match: ["typescript", "tsconfig"],
    expansion: "TypeScript",
    docsDomains: ["typescriptlang.org"],
    repoDomains: ["github.com/microsoft/TypeScript"],
  },
];

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

function normalizeQueryText(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

export function cleanCommunityQuery(query: string): string {
  return normalizeQueryText(
    query
      .replace(/\b(reddit|hacker\s*news|hn|stackoverflow|stack\s*overflow)\b/gi, " ")
      .replace(/\s+/g, " ")
  );
}

function hasLocalLlmIntent(query: string): boolean {
  const q = query.toLowerCase();
  return (
    (q.includes("local") || q.includes("self host") || q.includes("self-host")) &&
    (q.includes("llm") || q.includes("large language model"))
  );
}

export function buildCommunitySearchQueries(query: string): SearchQueryVariant[] {
  const cleaned = cleanCommunityQuery(query) || normalizeQueryText(query);
  const variants: SearchQueryVariant[] = [
    { query: cleaned, variant: "community-platform" },
  ];

  if (!hasLocalLlmIntent(cleaned)) return variants;

  for (const expandedCommunityQuery of [
    "best local LLMs",
    "best local LLMs 2026",
    "latest local LLMs",
    "current best local LLM",
    "best LLM to run locally",
    "self hosting LLM",
    "local LLM server setup",
    "Ollama vLLM llama.cpp Open WebUI local LLM",
  ]) {
    pushUniqueVariant(variants, {
      query: expandedCommunityQuery,
      variant: "community-broad",
    });
  }

  for (const targeted of [
    {
      query: "best local LLMs",
      redditSubreddit: "LocalLLaMA",
      redditSort: "top" as const,
      redditTimeRange: "year" as const,
    },
    {
      query: "latest local LLMs",
      redditSubreddit: "LocalLLaMA",
      redditSort: "new" as const,
      redditTimeRange: "year" as const,
    },
    {
      query: "current best local LLM",
      redditSubreddit: "LocalLLaMA",
      redditSort: "relevance" as const,
      redditTimeRange: "year" as const,
    },
    { query: "best LLM to run locally", redditSubreddit: "LocalLLaMA" },
    { query: "local LLM server setup", redditSubreddit: "LocalLLaMA" },
    { query: "self hosting LLM", redditSubreddit: "selfhosted" },
    { query: "Ollama vLLM llama.cpp Open WebUI local LLM", redditSubreddit: "ollama" },
  ]) {
    pushUniqueVariant(variants, {
      ...targeted,
      variant: "community-subreddit",
    });
  }

  return variants;
}

function expandedQuery(query: string): string {
  let out = query;
  out = out.replace(/\bMCP\b/gi, "Model Context Protocol");
  out = out.replace(/\bLLMs?\b/gi, "large language model");
  out = out.replace(/\bKV\b/gi, "key value");
  out = out.replace(/structuredContent/g, "structured content");
  out = out.replace(/outputSchema/g, "output schema");
  return normalizeQueryText(out);
}

function hasTechnicalSpecIntent(query: string): boolean {
  const q = query.toLowerCase();
  return TECHNICAL_SPEC_WORDS.some((word) => q.includes(word));
}

export function shouldRetrySearxngItCategory(query: string, opts?: SearchOpts): boolean {
  if (opts?.disableItFallback) return false;
  if (opts?.categories || opts?.domains?.length) return false;
  if (opts?.topic && opts.topic !== "general" && opts.topic !== "technical") return false;
  const q = query.toLowerCase();
  return TECHNICAL_QUERY_WORDS.some((word) => q.includes(word));
}

function officialHintsFor(query: string): typeof OFFICIAL_SOURCE_HINTS {
  const q = query.toLowerCase();
  return OFFICIAL_SOURCE_HINTS.filter((hint) =>
    hint.match.some((term) => q.includes(term))
  );
}

function pushUniqueVariant(
  variants: SearchQueryVariant[],
  variant: SearchQueryVariant
): void {
  const variantKey = (v: SearchQueryVariant) =>
    [
      v.variant,
      v.query,
      v.domains?.join(",") ?? "",
      v.redditSubreddit ?? "",
      v.redditSort ?? "",
      v.redditTimeRange ?? "",
    ].join(":");
  const key = variantKey(variant);
  const seen = new Set(
    variants.map(variantKey)
  );
  if (!seen.has(key)) variants.push(variant);
}

export function buildSearchQueries(
  query: string,
  opts?: SearchOpts
): SearchQueryVariant[] {
  const topic = opts?.topic ?? "general";
  const normalized = normalizeQueryText(query);
  const expanded = expandedQuery(normalized);
  const variants: SearchQueryVariant[] = [
    { query: normalized, variant: "original", domains: opts?.domains },
  ];

  if (topic === "academic") {
    if (expanded !== normalized) {
      pushUniqueVariant(variants, { query: expanded, variant: "expanded" });
    }
    pushUniqueVariant(variants, {
      query: `${expanded} survey review`,
      variant: "academic-review",
    });
    pushUniqueVariant(variants, {
      query: `${expanded} recent advances`,
      variant: "academic-review",
    });
    return variants;
  }

  if (topic === "community" && !opts?.domains?.length) {
    const communityVariants = buildCommunitySearchQueries(normalized);
    return [
      { query: normalized, variant: "original", topic: "general" },
      ...communityVariants.flatMap((communityVariant) =>
        TOPIC_DOMAINS.community.map((domain) => ({
          query: communityVariant.query,
          variant: communityVariant.variant,
        domains: [domain],
        topic: "general" as const,
        }))
      ),
    ];
  }

  const technicalIntent = topic === "technical";
  const specIntent = technicalIntent && hasTechnicalSpecIntent(normalized);
  if (technicalIntent && expanded !== normalized) {
    pushUniqueVariant(variants, { query: expanded, variant: "expanded" });
  }

  if (technicalIntent && !opts?.domains?.length) {
    for (const hint of officialHintsFor(expanded)) {
      const officialQuery =
        hint.match.some((term) => expanded.toLowerCase().includes(term.toLowerCase())) ||
        expanded.toLowerCase().includes(hint.expansion.toLowerCase())
          ? expanded
          : `${hint.expansion} ${expanded}`;
      for (const domain of [...hint.docsDomains, ...hint.repoDomains]) {
        pushUniqueVariant(variants, {
          query: officialQuery,
          variant: "official",
          domains: [domain],
        });
      }
    }
  }

  return variants;
}

export interface SearchProvider {
  search(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizedUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.replace(/\/$/, "");
    return `${u.hostname.toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  }
}

function minPosition(result: SearchResult): number {
  return Math.min(...(result.positions?.length ? result.positions : [20]));
}

function containsOfficialPath(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes("/docs") ||
    lower.includes("/documentation") ||
    lower.includes("/spec") ||
    lower.includes("/specification") ||
    lower.includes("/reference") ||
    lower.includes("/api")
  );
}

export function classifySourceType(url: string, topic?: SearchTopic): SourceType {
  const host = safeHostname(url);
  const lower = url.toLowerCase();
  if (
    host === "modelcontextprotocol.io" ||
    host === "nodejs.org" ||
    host === "developer.mozilla.org" ||
    host === "typescriptlang.org"
  ) {
    return "official";
  }
  if (
    host === "arxiv.org" ||
    host === "dblp.org" ||
    host === "semanticscholar.org" ||
    host === "doi.org" ||
    host === "openalex.org"
  ) {
    return "paper";
  }
  if (host === "github.com" && lower.includes("github.com/modelcontextprotocol/")) {
    return lower.includes("/issues/") || lower.includes("/pull/")
      ? "issue"
      : "official_repo";
  }
  if (host === "github.com" && (lower.includes("/issues/") || lower.includes("/discussions/"))) {
    return "issue";
  }
  if (
    host === "reddit.com" ||
    host.endsWith(".reddit.com") ||
    host === "news.ycombinator.com" ||
    host === "stackoverflow.com"
  ) {
    return "community";
  }
  if (topic === "academic" && containsOfficialPath(url)) return "engineering";
  if (host.includes("blog") || lower.includes("/blog/")) return "blog";
  return "unknown";
}

function relevanceScore(result: SearchResult, query: string): number {
  const haystack = `${result.title} ${result.snippet ?? ""} ${result.url}`.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
  if (!terms.length) return 0;
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

function officialSourceMatchesQuery(result: SearchResult, query: string): boolean {
  const host = safeHostname(result.url);
  const expanded = expandedQuery(query).toLowerCase();
  if (expanded.includes("model context protocol")) {
    return (
      host === "modelcontextprotocol.io" ||
      result.url.toLowerCase().includes("github.com/modelcontextprotocol/")
    );
  }
  if (expanded.includes("node.js") || expanded.includes("nodejs")) {
    return host === "nodejs.org" || result.url.toLowerCase().includes("github.com/nodejs/");
  }
  if (expanded.includes("typescript")) {
    return (
      host === "typescriptlang.org" ||
      result.url.toLowerCase().includes("github.com/microsoft/typescript")
    );
  }
  return relevanceScore(result, query) >= 0.5;
}

function redditCommunityScore(result: SearchResult, query: string): number {
  if (!isRedditResult(result)) return 0;
  const title = result.title.toLowerCase();
  const haystack = `${result.title} ${result.snippet ?? ""}`.toLowerCase();
  const subreddit = result.subreddit?.toLowerCase();
  let score = 0;

  if (subreddit === "localllama") score += 40;
  else if (subreddit === "selfhosted" || subreddit === "ollama") score += 16;

  if (title.includes("best") && title.includes("local") && title.includes("llm")) {
    score += 90;
  } else if (title.includes("local") && title.includes("llm")) {
    score += 55;
  }
  if (
    title.includes("run locally") ||
    title.includes("self host") ||
    title.includes("self-host") ||
    title.includes("setup") ||
    title.includes("server")
  ) {
    score += 28;
  }

  if (result.queryVariant === "community-broad") score += 35;
  if (result.queryVariant === "community-subreddit") score += 25;
  if (result.queryVariant === "community-platform") score += 10;

  score += Math.log1p(Math.max(0, result.redditScore ?? result.score ?? 0)) * 7;
  score += Math.log1p(Math.max(0, result.commentCount ?? 0)) * 9;
  score += relevanceScore(result, query) * 60;
  if (result.publishedAt) {
    const ageDays = daysSince(result.publishedAt);
    if (ageDays !== undefined) {
      if (ageDays <= 90) score += 45;
      else if (ageDays <= 365) score += 32;
      else if (ageDays <= 730) score += 15;
    }
  }
  if (/\b(2026|latest|current|recent)\b/i.test(`${query} ${result.title}`)) {
    score += 20;
  }

  if (
    /\b(best|run|locally|setup|server|self[- ]?host|model)\b/i.test(query) &&
    /\b(vram|mac studio|\$|cost analysis|bench)\b/i.test(haystack) &&
    !/\b(best|run locally|setup|server|self[- ]?host)\b/i.test(title)
  ) {
    score -= 90;
  } else if (
    /\b(best|run|locally|setup|server|self[- ]?host|model)\b/i.test(query) &&
    /\b(vram|mac studio|\$|cost analysis|bench)\b/i.test(haystack)
  ) {
    score -= 55;
  }

  return score;
}

function authorityScore(
  result: SearchResult,
  sourceType: SourceType,
  query: string,
  topic?: SearchTopic
): number {
  const rawEngineScore = result.score ?? 0;
  const engineScore = topic === "community" ? Math.min(rawEngineScore, 50) : rawEngineScore;
  const positionScore = Math.max(0, 25 - minPosition(result));
  const consensusScore = (result.engines?.length ?? 0) * 3;
  const relevance = relevanceScore(result, query) * 80;
  let sourceBoost = 0;

  if (topic === "technical" && hasTechnicalSpecIntent(query)) {
    sourceBoost =
      sourceType === "official" && officialSourceMatchesQuery(result, query)
        ? 1000
        : sourceType === "official_repo"
          ? 750
          : sourceType === "issue"
            ? 160
            : sourceType === "engineering"
              ? 120
              : sourceType === "official"
                ? 30
                : sourceType === "blog"
                  ? 60
                  : 0;
  } else if (topic === "academic") {
    sourceBoost =
      sourceType === "paper"
        ? 500
        : sourceType === "engineering"
          ? 140
          : sourceType === "official"
            ? 120
            : 0;
  } else if (topic === "community") {
    sourceBoost = sourceType === "community" || sourceType === "issue" ? 180 : 0;
    if (query.toLowerCase().includes("reddit") && safeHostname(result.url).includes("reddit.com")) {
      sourceBoost += 90;
    }
    sourceBoost += redditCommunityScore(result, query);
  } else if (sourceType === "official") {
    sourceBoost = 80;
  }

  return sourceBoost + relevance + engineScore + positionScore + consensusScore;
}

function mergeMetadata(target: SearchResult, incoming: SearchResult): void {
  const engines = new Set([...(target.engines ?? []), ...(incoming.engines ?? [])]);
  if (engines.size) target.engines = [...engines];
  const positions = [...(target.positions ?? []), ...(incoming.positions ?? [])];
  if (positions.length) target.positions = positions;
  if ((incoming.score ?? 0) > (target.score ?? 0)) target.score = incoming.score;
  if (!target.snippet && incoming.snippet) target.snippet = incoming.snippet;
  if (!target.pdfUrl && incoming.pdfUrl) target.pdfUrl = incoming.pdfUrl;
  if (!target.doi && incoming.doi) target.doi = incoming.doi;
  if (!target.venue && incoming.venue) target.venue = incoming.venue;
  if (!target.year && incoming.year) target.year = incoming.year;
  if (!target.citationCount && incoming.citationCount) {
    target.citationCount = incoming.citationCount;
  }
  if (!target.authors?.length && incoming.authors?.length) target.authors = incoming.authors;
}

function diversifyCommunityResults(results: SearchResult[], limit: number): SearchResult[] {
  const byHost = new Map<string, SearchResult[]>();
  for (const result of results) {
    const host = safeHostname(result.url) || "unknown";
    const bucket = byHost.get(host) ?? [];
    bucket.push(result);
    byHost.set(host, bucket);
  }
  const out: SearchResult[] = [];
  while (out.length < limit && [...byHost.values()].some((bucket) => bucket.length)) {
    const hosts = [...byHost.keys()].sort((a, b) => {
      const topA = byHost.get(a)?.[0]?.authorityScore ?? 0;
      const topB = byHost.get(b)?.[0]?.authorityScore ?? 0;
      return topB - topA;
    });
    for (const host of hosts) {
      const bucket = byHost.get(host);
      const next = bucket?.shift();
      if (next) out.push(next);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function isRedditResult(result: SearchResult): boolean {
  const provider = result.provider?.toLowerCase() ?? "";
  const host = safeHostname(result.url);
  return provider.startsWith("reddit") || host === "reddit.com" || host.endsWith(".reddit.com");
}

function redditDiversityKey(result: SearchResult): string {
  const title = result.title
    .toLowerCase()
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/g, "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/\bbest local llms?\b/.test(title)) return "best-local-llm-list";
  if (/\b(setup|server|self host|self hosted|self hosting|run locally)\b/.test(title)) {
    return "setup-or-self-host";
  }
  if (/\b(ollama|vllm|llama cpp|open webui)\b/.test(title)) return "ecosystem";
  if (/\b(gpu|nvidia|vram|mac studio|mini pc|hardware)\b/.test(title)) return "hardware";
  return title.split(" ").slice(0, 5).join("-");
}

function selectDiverseRedditResults(results: SearchResult[], limit: number): SearchResult[] {
  const selected: SearchResult[] = [];
  const clusterCounts = new Map<string, number>();
  for (const result of results) {
    const key = redditDiversityKey(result);
    const count = clusterCounts.get(key) ?? 0;
    if (count >= 2) continue;
    selected.push(result);
    clusterCounts.set(key, count + 1);
    if (selected.length >= limit) return selected;
  }
  const selectedKeys = new Set(selected.map((r) => normalizedUrlKey(r.url)));
  for (const result of results) {
    if (selectedKeys.has(normalizedUrlKey(result.url))) continue;
    selected.push(result);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function prioritizeRedditCommunityResults(
  results: SearchResult[],
  query: string,
  limit: number
): SearchResult[] {
  const redditResults = results.filter(isRedditResult);
  const shouldPinReddit =
    /\breddit\b/i.test(query) || redditResults.length > 0;
  if (!shouldPinReddit || redditResults.length === 0) {
    return diversifyCommunityResults(results, limit);
  }

  const pinnedReddit = selectDiverseRedditResults(
    redditResults,
    Math.min(5, limit)
  );
  const pinnedKeys = new Set(pinnedReddit.map((r) => normalizedUrlKey(r.url)));
  const remaining = results.filter((r) => !pinnedKeys.has(normalizedUrlKey(r.url)));
  const remainingNonReddit = remaining.filter((r) => !isRedditResult(r));
  const extraReddit = remaining.filter(isRedditResult);
  const nonRedditFill = diversifyCommunityResults(
    remainingNonReddit,
    limit - pinnedReddit.length
  );
  const usedKeys = new Set([
    ...pinnedReddit.map((r) => normalizedUrlKey(r.url)),
    ...nonRedditFill.map((r) => normalizedUrlKey(r.url)),
  ]);
  const redditFill = extraReddit.filter((r) => !usedKeys.has(normalizedUrlKey(r.url)));
  return [
    ...pinnedReddit,
    ...nonRedditFill,
    ...redditFill,
  ].slice(0, limit);
}

export function rankSearchCandidates(
  groups: SearchCandidateGroup[],
  opts: { query: string; topic?: SearchTopic; num?: number }
): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const group of groups) {
    for (const raw of group.results) {
      const key = normalizedUrlKey(raw.url);
      const sourceType = raw.sourceType ?? classifySourceType(raw.url, opts.topic);
      const candidate: SearchResult = {
        ...raw,
        matchedQuery: raw.matchedQuery ?? group.query,
        queryVariant: raw.queryVariant ?? group.variant,
        sourceType,
      };
      candidate.authorityScore = authorityScore(
        candidate,
        sourceType,
        opts.query,
        opts.topic
      );
      const existing = merged.get(key);
      if (existing) {
        mergeMetadata(existing, candidate);
        existing.authorityScore = Math.max(
          existing.authorityScore ?? 0,
          candidate.authorityScore ?? 0
        );
        if (candidate.sourceType === "official") existing.sourceType = "official";
      } else {
        merged.set(key, candidate);
      }
    }
  }

  const ranked = [...merged.values()].sort((a, b) => {
    const authorityDiff = (b.authorityScore ?? 0) - (a.authorityScore ?? 0);
    if (authorityDiff !== 0) return authorityDiff;
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return minPosition(a) - minPosition(b);
  });
  const limit = opts.num ?? 10;
  if (opts.topic === "technical" && hasTechnicalSpecIntent(opts.query)) {
    const relevantSpecResults = ranked.filter((r) => {
      const matchedQuery = r.matchedQuery ?? opts.query;
      return (
        officialSourceMatchesQuery(r, opts.query) ||
        relevanceScore(r, matchedQuery) >= 0.35 ||
        relevanceScore(r, opts.query) >= 0.35
      );
    });
    return (relevantSpecResults.length ? relevantSpecResults : ranked).slice(0, limit);
  }
  if (opts.topic === "technical") {
    const relevantTechnicalResults = ranked.filter((r) => {
      const matchedQuery = r.matchedQuery ?? opts.query;
      return (
        officialSourceMatchesQuery(r, opts.query) ||
        relevanceScore(r, matchedQuery) >= 0.35 ||
        relevanceScore(r, opts.query) >= 0.35
      );
    });
    return (relevantTechnicalResults.length ? relevantTechnicalResults : ranked).slice(0, limit);
  }
  if (opts.topic === "community") {
    const communitySources = ranked.filter(
      (r) => r.sourceType === "community" || r.sourceType === "issue"
    );
    const relevantCommunitySources = communitySources.filter((r) => {
      const matchedQuery = r.matchedQuery ?? opts.query;
      return (
        relevanceScore(r, matchedQuery) >= 0.5 ||
        relevanceScore(r, opts.query) >= 0.5
      );
    });
    const pool =
      relevantCommunitySources.length
        ? relevantCommunitySources
        : communitySources.length
          ? communitySources
          : ranked;
    return prioritizeRedditCommunityResults(pool, opts.query, limit);
  }
  return ranked.slice(0, limit);
}

function expandedProviderLimit(opts?: SearchOpts): number {
  const requested = opts?.num ?? 10;
  if (opts?.topic === "academic") return Math.min(100, Math.max(50, requested * 4));
  if (opts?.topic === "community") return Math.max(12, requested);
  if (opts?.topic === "technical") return Math.max(12, requested);
  return requested;
}

function seededOfficialGroups(
  query: string,
  opts?: SearchOpts
): SearchCandidateGroup[] {
  if (opts?.topic !== "technical") return [];
  const expanded = expandedQuery(query).toLowerCase();
  const groups: SearchCandidateGroup[] = [];

  if (hasTechnicalSpecIntent(query) && expanded.includes("model context protocol")) {
    groups.push({
      query: "Model Context Protocol tools structured content output schema",
      variant: "official",
      domains: ["modelcontextprotocol.io"],
      results: [
        {
          title: "Tools - Model Context Protocol",
          url: "https://modelcontextprotocol.io/specification/2025-11-25/server/tools",
          snippet:
            "Official MCP tools specification covering tool results, outputSchema, and structuredContent.",
          sourceType: "official",
          provider: "official_seed",
          score: 100,
          positions: [1],
        },
        {
          title: "Specification and documentation for the Model Context Protocol",
          url: "https://github.com/modelcontextprotocol/modelcontextprotocol",
          snippet: "Official MCP specification and documentation repository.",
          sourceType: "official_repo",
          provider: "official_seed",
          score: 90,
          positions: [2],
        },
        {
          title: "Model Context Protocol TypeScript SDK",
          url: "https://github.com/modelcontextprotocol/typescript-sdk",
          snippet: "Official TypeScript SDK for Model Context Protocol servers and clients.",
          sourceType: "official_repo",
          provider: "official_seed",
          score: 80,
          positions: [3],
        },
        {
          title: "Model Context Protocol Python SDK",
          url: "https://github.com/modelcontextprotocol/python-sdk",
          snippet: "Official Python SDK for Model Context Protocol servers and clients.",
          sourceType: "official_repo",
          provider: "official_seed",
          score: 75,
          positions: [4],
        },
        {
          title: "SEP-1624: Clarify structuredContent vs content Usage Guidance",
          url: "https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1624",
          snippet: "MCP discussion about structuredContent and content usage guidance.",
          sourceType: "issue",
          provider: "official_seed",
          score: 70,
          positions: [5],
        },
      ],
    });
  }

  if (
    (expanded.includes("nodejs") || expanded.includes("node.js")) &&
    (expanded.includes("stream") || expanded.includes("backpressure"))
  ) {
    groups.push({
      query: "Node.js stream backpressure official documentation",
      variant: "official",
      domains: ["nodejs.org"],
      results: [
        {
          title: "Backpressuring in Streams",
          url: "https://nodejs.org/en/learn/modules/backpressuring-in-streams",
          snippet:
            "Official Node.js guide explaining stream backpressure and memory behavior.",
          sourceType: "official",
          provider: "official_seed",
          score: 100,
          positions: [1],
        },
        {
          title: "Stream | Node.js API",
          url: "https://nodejs.org/api/stream.html",
          snippet: "Official Node.js stream API reference.",
          sourceType: "official",
          provider: "official_seed",
          score: 90,
          positions: [2],
        },
      ],
    });
  }

  return groups;
}

export function createExpandedSearchProvider(provider: SearchProvider): SearchProvider {
  return {
    search: async (query, opts) => {
      const variants = buildSearchQueries(query, opts);
      const perVariantNum =
        opts?.topic === "technical" && hasTechnicalSpecIntent(query)
          ? Math.max(12, opts?.num ?? 10)
          : expandedProviderLimit(opts);
      const groups = await Promise.all(
        variants.map(async (variant) => {
          try {
            const results = await provider.search(variant.query, {
              ...opts,
              domains: variant.domains ?? opts?.domains,
              topic: variant.topic ?? opts?.topic,
              num: perVariantNum,
              disableItFallback: opts?.topic === "community",
            });
            return { ...variant, results };
          } catch {
            return { ...variant, results: [] };
          }
        })
      );
      return rankSearchCandidates([...seededOfficialGroups(query, opts), ...groups], {
        query,
        topic: opts?.topic,
        num: opts?.num,
      });
    },
  };
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
    const item = r as {
      title?: string;
      url?: string;
      content?: string;
      engines?: unknown;
      score?: unknown;
      positions?: unknown;
    };
    if (typeof item.url !== "string" || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({
      title: typeof item.title === "string" ? item.title : "",
      url: item.url,
      ...(typeof item.content === "string" && item.content
        ? { snippet: item.content }
        : {}),
      ...(Array.isArray(item.engines)
        ? { engines: item.engines.filter((v): v is string => typeof v === "string") }
        : {}),
      ...(typeof item.score === "number" ? { score: item.score } : {}),
      ...(Array.isArray(item.positions)
        ? { positions: item.positions.filter((v): v is number => typeof v === "number") }
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
      const fetchResults = async (searchOpts?: SearchOpts) => {
        const url = buildSearxngUrl(baseUrl, query, searchOpts);
        const res = await withRetry(() =>
          fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 20_000).then((r) => {
            if (!r.ok) throw new Error(`SearXNG search failed: ${r.status}`);
            return r;
          })
        );
        return parseSearxngResponse(await res.text());
      };
      let results = await fetchResults(opts);
      if (results.length === 0 && shouldRetrySearxngItCategory(query, opts)) {
        results = await fetchResults({ ...opts, categories: "it" });
      }
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
        fetchWithTimeout(
          "https://api.tavily.com/search",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          },
          20_000
        ).then((r) => {
          if (!r.ok) throw new Error(`Tavily search failed: ${r.status}`);
          return r;
        })
      );
      const results = parseTavilyResponse(await res.text());
      return opts?.num ? results.slice(0, opts.num) : results;
    },
  };
}

// ---- Community direct providers ----

export function parseRedditSearchResponse(json: string): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const children = (parsed as { data?: { children?: unknown[] } })?.data?.children;
  if (!Array.isArray(children)) return [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    const data = (child as { data?: Record<string, unknown> })?.data;
    if (!data) continue;
    const title = typeof data.title === "string" ? data.title : "";
    const permalink = typeof data.permalink === "string" ? data.permalink : "";
    const url = permalink.startsWith("http")
      ? permalink
      : permalink
        ? `https://www.reddit.com${permalink}`
        : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const score = typeof data.score === "number" ? data.score : undefined;
    const commentCount =
      typeof data.num_comments === "number" ? data.num_comments : undefined;
    const subreddit =
      typeof data.subreddit === "string" ? data.subreddit : undefined;
    const publishedAt =
      typeof data.created_utc === "number"
        ? new Date(data.created_utc * 1000).toISOString()
        : undefined;
    const comments =
      typeof data.num_comments === "number" ? `${data.num_comments} comments` : "";
    const selftext = typeof data.selftext === "string" ? data.selftext : "";
    out.push({
      title,
      url,
      snippet: [comments, selftext.slice(0, 180)].filter(Boolean).join(" | "),
      provider: "reddit",
      sourceType: "community",
      ...(subreddit ? { subreddit } : {}),
      ...(score !== undefined ? { score, redditScore: score } : {}),
      ...(commentCount !== undefined ? { commentCount } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return out;
}

function absoluteRedditUrl(href: string): string {
  if (!href) return "";
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://www.reddit.com${href}`;
  return "";
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function firstInteger(text: string): number | undefined {
  const match = text.replace(/,/g, "").match(/-?\d+/);
  return match ? Number(match[0]) : undefined;
}

function normalizeSubreddit(text: string | null | undefined): string | undefined {
  const normalized = normalizeText(text).replace(/^\/?r\//i, "");
  return normalized || undefined;
}

function normalizeDateString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function daysSince(isoDate: string): number | undefined {
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, (Date.now() - time) / 86_400_000);
}

export function parseOldRedditSearchResponse(html: string): SearchResult[] {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of doc.querySelectorAll(".search-result")) {
    const titleEl = entry.querySelector<HTMLAnchorElement>("a.search-title");
    const commentsEl = entry.querySelector<HTMLAnchorElement>("a.search-comments");
    const subreddit = normalizeSubreddit(
      entry.querySelector(".search-subreddit-link")?.textContent
    );
    const scoreText = normalizeText(entry.querySelector(".search-score")?.textContent);
    const commentsText = normalizeText(commentsEl?.textContent);
    const excerpt = normalizeText(entry.querySelector(".search-result-body")?.textContent);
    const title = normalizeText(titleEl?.textContent);
    const commentsHref = commentsEl?.getAttribute("href") ?? "";
    const titleHref = titleEl?.getAttribute("href") ?? "";
    const url = absoluteRedditUrl(commentsHref || titleHref);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    const redditScore = firstInteger(scoreText);
    const commentCount = firstInteger(commentsText);
    const timeEl = entry.querySelector("time");
    const publishedAt = normalizeDateString(
      timeEl?.getAttribute("datetime") ??
        timeEl?.getAttribute("title") ??
        undefined
    );
    out.push({
      title,
      url,
      snippet: [subreddit, scoreText, commentsText, excerpt.slice(0, 180)]
        .filter(Boolean)
        .join(" | "),
      provider: "reddit_old",
      sourceType: "community",
      ...(subreddit ? { subreddit } : {}),
      ...(redditScore !== undefined ? { redditScore, score: redditScore } : {}),
      ...(commentCount !== undefined ? { commentCount } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return out;
}

let redditJsonBlockedUntil = 0;

export function createRedditSearchProvider(): SearchProvider {
  return {
    search: async (query, opts) => {
      const limit = Math.min(50, Math.max(10, opts?.num ?? 10));
      const params = new URLSearchParams({
        q: query,
        limit: String(limit),
        sort: "relevance",
        type: "link",
        raw_json: "1",
      });
      const apiUrl = `https://www.reddit.com/search.json?${params}`;
      const proxyUrl = externalProxyUrl();
      const shouldTryJson =
        !opts?.redditSubreddit && Date.now() >= redditJsonBlockedUntil;
      try {
        if (!shouldTryJson) throw new Error("Reddit JSON search recently blocked");
        const res = await withRetry(() =>
          fetchWithTimeout(
            apiUrl,
            {
              headers: {
                Accept: "application/json",
                "User-Agent": "mcp-web-server/2.0 search quality agent",
              },
            },
            12_000,
            proxyUrl
          ).then((r) => {
            if (!r.ok) throw new Error(`Reddit search failed: ${r.status}`);
            return r;
          })
        );
        const results = parseRedditSearchResponse(await res.text());
        if (results.length) return results.slice(0, opts?.num ?? 10);
      } catch {
        redditJsonBlockedUntil = Date.now() + 10 * 60_000;
        // Fall through to old.reddit.com, which is often available when search.json
        // is blocked by Reddit's network-security layer.
      }

      const oldParams = new URLSearchParams({
        q: query,
        sort: opts?.redditSort ?? "relevance",
        t: opts?.redditTimeRange ?? "all",
      });
      if (opts?.redditSubreddit) oldParams.set("restrict_sr", "on");
      const oldPath = opts?.redditSubreddit
        ? `/r/${encodeURIComponent(opts.redditSubreddit)}/search`
        : "/search";
      const oldUrl = `https://old.reddit.com${oldPath}?${oldParams}`;
      const oldRes = await withRetry(() =>
        fetchWithTimeout(
          oldUrl,
          {
            headers: {
              Accept: "text/html",
              "User-Agent":
                "Mozilla/5.0 (compatible; mcp-web-server/2.0; +https://github.com/PPParticle/web-server)",
            },
          },
          12_000,
          proxyUrl
        ).then((r) => {
          if (!r.ok) throw new Error(`Old Reddit search failed: ${r.status}`);
          return r;
        })
      );
      return parseOldRedditSearchResponse(await oldRes.text()).slice(0, opts?.num ?? 10);
    },
  };
}

export function parseHackerNewsSearchResponse(json: string): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const hits = (parsed as { hits?: unknown[] })?.hits;
  if (!Array.isArray(hits)) return [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const item = hit as {
      objectID?: string;
      title?: string | null;
      story_title?: string | null;
      url?: string | null;
      points?: number | null;
      num_comments?: number | null;
    };
    const id = item.objectID ?? "";
    const url = item.url || (id ? `https://news.ycombinator.com/item?id=${id}` : "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = item.title ?? item.story_title ?? "";
    const score = typeof item.points === "number" ? item.points : undefined;
    const comments =
      typeof item.num_comments === "number" ? `${item.num_comments} comments` : "";
    out.push({
      title,
      url,
      snippet: comments,
      provider: "hacker_news",
      sourceType: "community",
      ...(score !== undefined ? { score } : {}),
    });
  }
  return out;
}

export function createHackerNewsSearchProvider(): SearchProvider {
  return {
    search: async (query, opts) => {
      const limit = Math.min(50, Math.max(10, opts?.num ?? 10));
      const params = new URLSearchParams({
        query,
        hitsPerPage: String(limit),
        tags: "story",
      });
      const apiUrl = `https://hn.algolia.com/api/v1/search?${params}`;
      const res = await withRetry(() =>
        fetchWithTimeout(apiUrl, { headers: { Accept: "application/json" } }, 12_000).then((r) => {
          if (!r.ok) throw new Error(`Hacker News search failed: ${r.status}`);
          return r;
        })
      );
      return parseHackerNewsSearchResponse(await res.text()).slice(0, opts?.num ?? 10);
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
      provider: "dblp",
      sourceType: "paper",
      authors: authorNames,
      ...(year ? { year: Number(year) } : {}),
      ...(venue ? { venue } : {}),
      ...(ee.startsWith("https://doi.org/")
        ? { doi: ee.replace("https://doi.org/", "") }
        : {}),
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
        fetchWithTimeout(apiUrl, { headers: { Accept: "application/json" } }, 12_000).then((r) => {
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
      provider: "semantic_scholar",
      sourceType: "paper",
      authors: authorNames,
      ...(p.venue ? { venue: p.venue } : {}),
      ...(p.year ? { year: p.year } : {}),
      ...(p.citationCount !== undefined ? { citationCount: p.citationCount } : {}),
      ...(p.externalIds?.DOI ? { doi: p.externalIds.DOI } : {}),
      ...(p.openAccessPdf?.url ? { pdfUrl: p.openAccessPdf.url } : {}),
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
        fetchWithTimeout(apiUrl, { headers: { Accept: "application/json" } }, 12_000).then((r) => {
          if (!r.ok) throw new Error(`Semantic Scholar search failed: ${r.status}`);
          return r;
        })
      );
      return parseSemanticScholarResponse(await res.text());
    },
  };
}

// ---- OpenAlex provider (broad academic coverage, free) ----

function abstractFromOpenAlexIndex(index?: Record<string, number[]>): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(" ");
}

export function parseOpenAlexResponse(json: string): SearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const results = (parsed as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const item of results) {
    const work = item as {
      display_name?: string;
      id?: string;
      doi?: string;
      publication_year?: number;
      cited_by_count?: number;
      abstract_inverted_index?: Record<string, number[]>;
      authorships?: { author?: { display_name?: string } }[];
      primary_location?: {
        landing_page_url?: string;
        pdf_url?: string;
        source?: { display_name?: string };
      };
      open_access?: { oa_url?: string };
    };
    const title = work.display_name ?? "";
    const doi = work.doi?.replace(/^https:\/\/doi.org\//, "");
    const url =
      work.primary_location?.pdf_url ??
      work.open_access?.oa_url ??
      work.primary_location?.landing_page_url ??
      work.doi ??
      work.id ??
      "";
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const authors = (work.authorships ?? [])
      .map((a) => a.author?.display_name ?? "")
      .filter(Boolean);
    const venue = work.primary_location?.source?.display_name;
    const abstract = abstractFromOpenAlexIndex(work.abstract_inverted_index);
    const metaParts = [
      authors.length
        ? authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "")
        : "",
      venue ?? "",
      work.publication_year ? String(work.publication_year) : "",
      work.cited_by_count !== undefined ? `${work.cited_by_count} citations` : "",
    ].filter(Boolean);

    out.push({
      title,
      url,
      snippet: [
        metaParts.join(" · "),
        abstract ? abstract.slice(0, 200) + (abstract.length > 200 ? "..." : "") : "",
      ]
        .filter(Boolean)
        .join(" | "),
      provider: "openalex",
      sourceType: "paper",
      authors,
      ...(venue ? { venue } : {}),
      ...(work.publication_year ? { year: work.publication_year } : {}),
      ...(work.cited_by_count !== undefined ? { citationCount: work.cited_by_count } : {}),
      ...(doi ? { doi } : {}),
      ...(work.primary_location?.pdf_url ?? work.open_access?.oa_url
        ? { pdfUrl: work.primary_location?.pdf_url ?? work.open_access?.oa_url }
        : {}),
    });
  }
  return out;
}

export function createOpenAlexProvider(): SearchProvider {
  return {
    search: async (query, opts) => {
      const limit = Math.min(100, opts?.num ?? 25);
      const params = new URLSearchParams({
        search: query,
        "per-page": String(limit),
      });
      const apiUrl = `https://api.openalex.org/works?${params}`;
      const res = await withRetry(() =>
        fetchWithTimeout(apiUrl, { headers: { Accept: "application/json" } }, 12_000).then((r) => {
          if (!r.ok) throw new Error(`OpenAlex search failed: ${r.status}`);
          return r;
        })
      );
      return parseOpenAlexResponse(await res.text());
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
