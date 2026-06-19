import { describe, expect, it } from "vitest";
import {
  buildSearxngUrl,
  parseSearxngResponse,
  buildTavilyBody,
  parseTavilyResponse,
  topicToDomains,
  resolveDomains,
  parseDblpResponse,
  parseSemanticScholarResponse,
  mergeResults,
} from "./search.js";

describe("buildSearxngUrl", () => {
  it("builds a JSON search URL with the query", () => {
    expect(buildSearxngUrl("http://localhost:8080", "kv cache")).toBe(
      "http://localhost:8080/search?q=kv+cache&format=json"
    );
  });

  it("URL-encodes special characters in the query", () => {
    const url = buildSearxngUrl("http://localhost:8080", "a&b c");
    expect(url).toContain("q=a%26b+c");
  });

  it("handles a trailing slash on the base URL", () => {
    expect(buildSearxngUrl("http://localhost:8080/", "x")).toBe(
      "http://localhost:8080/search?q=x&format=json"
    );
  });

  it("appends categories/pageno when provided", () => {
    const url = buildSearxngUrl("http://localhost:8080", "x", {
      categories: "it",
      pageno: 2,
    });
    expect(url).toContain("categories=it");
    expect(url).toContain("pageno=2");
  });
});

describe("parseSearxngResponse", () => {
  it("extracts title, url, and snippet from results", () => {
    const json = JSON.stringify({
      results: [
        { title: "First", url: "https://a.com/1", content: "snippet one" },
        { title: "Second", url: "https://b.com/2", content: "snippet two" },
      ],
    });
    expect(parseSearxngResponse(json)).toEqual([
      { title: "First", url: "https://a.com/1", snippet: "snippet one" },
      { title: "Second", url: "https://b.com/2", snippet: "snippet two" },
    ]);
  });

  it("dedupes by url (first occurrence wins)", () => {
    const json = JSON.stringify({
      results: [
        { title: "A", url: "https://a.com/1", content: "s1" },
        { title: "A dup", url: "https://a.com/1", content: "s2" },
      ],
    });
    const out = parseSearxngResponse(json);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("A");
  });

  it("omits snippet when content is absent", () => {
    const json = JSON.stringify({
      results: [{ title: "NoBody", url: "https://a.com/2" }],
    });
    expect(parseSearxngResponse(json)).toEqual([
      { title: "NoBody", url: "https://a.com/2" },
    ]);
  });

  it("returns [] on empty or invalid JSON", () => {
    expect(parseSearxngResponse(JSON.stringify({ results: [] }))).toEqual([]);
    expect(parseSearxngResponse("not json")).toEqual([]);
    expect(parseSearxngResponse(JSON.stringify({}))).toEqual([]);
  });
});

describe("buildTavilyBody", () => {
  it("sets query and max_results (default 10)", () => {
    expect(buildTavilyBody("kv cache")).toEqual({
      query: "kv cache",
      max_results: 10,
    });
  });

  it("respects a custom num", () => {
    expect(buildTavilyBody("x", { num: 5 })).toEqual({
      query: "x",
      max_results: 5,
    });
  });
});

describe("parseTavilyResponse", () => {
  it("extracts title, url, and snippet from Tavily results", () => {
    const json = JSON.stringify({
      results: [
        { title: "T1", url: "https://a.com/1", content: "snippet one" },
        { title: "T2", url: "https://b.com/2", content: "snippet two" },
      ],
    });
    expect(parseTavilyResponse(json)).toEqual([
      { title: "T1", url: "https://a.com/1", snippet: "snippet one" },
      { title: "T2", url: "https://b.com/2", snippet: "snippet two" },
    ]);
  });

  it("dedupes by url", () => {
    const json = JSON.stringify({
      results: [
        { title: "A", url: "https://a.com/1", content: "s1" },
        { title: "dup", url: "https://a.com/1", content: "s2" },
      ],
    });
    expect(parseTavilyResponse(json)).toHaveLength(1);
  });

  it("returns [] on empty or invalid JSON", () => {
    expect(parseTavilyResponse(JSON.stringify({ results: [] }))).toEqual([]);
    expect(parseTavilyResponse("not json")).toEqual([]);
    expect(parseTavilyResponse(JSON.stringify({ answer: "x" }))).toEqual([]);
  });
});

describe("topicToDomains", () => {
  it("maps academic to paper/code domains", () => {
    expect(topicToDomains("academic")).toContain("arxiv.org");
    expect(topicToDomains("academic")).toContain("github.com");
  });

  it("maps technical to Q&A/docs domains", () => {
    expect(topicToDomains("technical")).toContain("stackoverflow.com");
    expect(topicToDomains("technical")).toContain("developer.mozilla.org");
  });

  it("maps community to discussion domains", () => {
    expect(topicToDomains("community")).toContain("reddit.com");
  });

  it("general has no domains", () => {
    expect(topicToDomains("general")).toEqual([]);
  });
});

describe("resolveDomains", () => {
  it("returns topic domains when topic is set", () => {
    const d = resolveDomains({ topic: "academic" });
    expect(d).toContain("arxiv.org");
  });

  it("explicit domains override topic", () => {
    const d = resolveDomains({ topic: "academic", domains: ["example.com"] });
    expect(d).toEqual(["example.com"]);
  });

  it("returns undefined for general with no domains", () => {
    expect(resolveDomains({ topic: "general" })).toBeUndefined();
    expect(resolveDomains({})).toBeUndefined();
  });
});

describe("buildTavilyBody with topic", () => {
  it("includes include_domains for academic topic", () => {
    const body = buildTavilyBody("x", { topic: "academic" });
    expect(body.include_domains).toContain("arxiv.org");
  });

  it("omits include_domains for general topic", () => {
    const body = buildTavilyBody("x", { topic: "general" });
    expect(body.include_domains).toBeUndefined();
  });
});

describe("buildSearxngUrl with topic", () => {
  it("appends site: operators for non-general topic", () => {
    const url = buildSearxngUrl("http://localhost:8080", "transformer", {
      topic: "academic",
    });
    // SearXNG query should contain site:arxiv.org (URL-encoded)
    expect(url.toLowerCase()).toContain("arxiv.org");
  });

  it("clean query for general topic", () => {
    const url = buildSearxngUrl("http://localhost:8080", "transformer", {
      topic: "general",
    });
    expect(url).not.toContain("site%3A");
  });
});

const dblpFixture = JSON.stringify({
  result: {
    hits: {
      "@total": "2",
      hit: [
        {
          "@score": "3",
          info: {
            title: "KVSwap: Disk-aware KV Cache Offloading.",
            authors: { author: [
              { "@pid": "37/10844", text: "Huawei Zhang" },
              { "@pid": "189/8618", text: "Chunwei Xia" },
              { "@pid": "181/2834", text: "Zheng Wang" },
            ] },
            venue: "MobiSys",
            year: "2026",
            type: "Conference and Workshop Papers",
            ee: "https://doi.org/10.1145/3745756.3809234",
            url: "https://dblp.org/rec/conf/mobisys/ZhangXW26",
          },
        },
        {
          "@score": "3",
          info: {
            title: "Mooncake: A KVCache-centric Architecture.",
            authors: { author: { "@pid": "326/5414", text: "Ruoyu Qin" } },
            venue: "FAST",
            year: "2025",
            ee: "https://doi.org/10.48550/arXiv.2407.00079",
            url: "https://dblp.org/rec/conf/fast/QinLHCRZ0ZX25",
          },
        },
      ],
    },
  },
});

describe("parseDblpResponse", () => {
  it("extracts title, url, and snippet (authors + venue + year)", () => {
    const results = parseDblpResponse(dblpFixture);
    expect(results).toHaveLength(2);

    expect(results[0].title).toBe("KVSwap: Disk-aware KV Cache Offloading.");
    expect(results[0].url).toBe("https://dblp.org/rec/conf/mobisys/ZhangXW26");
    expect(results[0].snippet).toContain("Huawei Zhang");
    expect(results[0].snippet).toContain("MobiSys");
    expect(results[0].snippet).toContain("2026");
    expect(results[0].snippet).toContain("DOI:");
  });

  it("handles single author (object, not array)", () => {
    const results = parseDblpResponse(dblpFixture);
    expect(results[1].snippet).toContain("Ruoyu Qin");
    expect(results[1].snippet).toContain("FAST");
    expect(results[1].snippet).toContain("2025");
  });

  it("returns [] on empty or invalid JSON", () => {
    expect(parseDblpResponse("not json")).toEqual([]);
    expect(parseDblpResponse(JSON.stringify({}))).toEqual([]);
    expect(
      parseDblpResponse(JSON.stringify({ result: { hits: { hit: [] } } }))
    ).toEqual([]);
  });
});

const s2Fixture = JSON.stringify({
  data: [
    {
      title: "Mooncake: A KVCache-centric Disaggregated Architecture.",
      abstract: "We present Mooncake, a KV-cache-centric disaggregated architecture.",
      venue: "FAST",
      year: 2025,
      citationCount: 42,
      externalIds: { DOI: "10.1145/1234" },
      authors: [{ name: "Ruoyu Qin" }, { name: "Zheming Li" }],
    },
    {
      title: "KVSwap: Disk-aware KV Cache Offloading.",
      abstract: "KVSwap stores the full cache on disk.",
      venue: "MobiSys",
      year: 2026,
      citationCount: 5,
      openAccessPdf: { url: "https://arxiv.org/pdf/2511.11907" },
      authors: [{ name: "Huawei Zhang" }],
    },
  ],
});

describe("parseSemanticScholarResponse", () => {
  it("extracts title, abstract snippet, authors, venue, year, citations", () => {
    const results = parseSemanticScholarResponse(s2Fixture);
    expect(results).toHaveLength(2);

    expect(results[0].title).toContain("Mooncake");
    expect(results[0].snippet).toContain("KV-cache-centric disaggregated");
    expect(results[0].snippet).toContain("FAST");
    expect(results[0].url).toContain("doi.org");

    expect(results[1].title).toContain("KVSwap");
    expect(results[1].url).toBe("https://arxiv.org/pdf/2511.11907");
  });

  it("returns [] on empty or invalid JSON", () => {
    expect(parseSemanticScholarResponse("not json")).toEqual([]);
    expect(parseSemanticScholarResponse(JSON.stringify({}))).toEqual([]);
  });
});

describe("mergeResults", () => {
  it("merges two lists and dedupes by normalized URL", () => {
    const a = [
      { title: "A", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" },
    ];
    const b = [
      { title: "A dup", url: "http://example.com/a/" },
      { title: "C", url: "https://example.com/c" },
    ];
    const merged = mergeResults(a, b);
    expect(merged).toHaveLength(3);
    expect(merged[0].title).toBe("A");
    expect(merged[2].title).toBe("C");
  });
});
