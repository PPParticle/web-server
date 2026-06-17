import { describe, expect, it } from "vitest";
import {
  cacheKey,
  chooseTtlMs,
  isFresh,
  withCache,
  type CacheStore,
  type CacheEntry,
} from "./cache.js";
import type { FetchResult } from "./types.js";

function memStore(): CacheStore & { data: Map<string, CacheEntry> } {
  const data = new Map<string, CacheEntry>();
  return {
    data,
    read: async (k) => data.get(k) ?? null,
    write: async (k, e) => {
      data.set(k, e);
    },
  };
}

const sampleResult: FetchResult = {
  title: "Cached Page",
  content: "cached body",
  metadata: {
    url: "https://example.com/x",
    fetchedAt: "2026-06-17T00:00:00Z",
    contentLength: 11,
    method: "local-parser",
  },
};

describe("cacheKey", () => {
  it("is deterministic for the same inputs", () => {
    expect(cacheKey("https://example.com/a", "auto")).toBe(
      cacheKey("https://example.com/a", "auto")
    );
  });

  it("differs by url and by engine", () => {
    expect(cacheKey("https://example.com/a", "auto")).not.toBe(
      cacheKey("https://example.com/b", "auto")
    );
    expect(cacheKey("https://example.com/a", "auto")).not.toBe(
      cacheKey("https://example.com/a", "local")
    );
  });
});

describe("chooseTtlMs", () => {
  it("gives GitHub hosts a 1h TTL", () => {
    expect(chooseTtlMs("https://github.com/o/r")).toBe(3600_000);
    expect(chooseTtlMs("https://raw.githubusercontent.com/o/r/main/x")).toBe(
      3600_000
    );
  });

  it("gives arXiv a 24h TTL", () => {
    expect(chooseTtlMs("https://arxiv.org/abs/2501.1")).toBe(86400_000);
  });

  it("defaults other hosts to 1h", () => {
    expect(chooseTtlMs("https://example.com/post")).toBe(3600_000);
  });
});

describe("isFresh", () => {
  const entry: CacheEntry = {
    url: "u",
    engine: "auto",
    result: sampleResult,
    fetchedAt: 1000,
  };

  it("is fresh within the TTL", () => {
    expect(isFresh(entry, 3600_000, 1000 + 60_000)).toBe(true);
  });

  it("is stale past the TTL", () => {
    expect(isFresh(entry, 3600_000, 1000 + 4000_000)).toBe(false);
  });
});

describe("withCache", () => {
  it("returns a fresh cached result without calling the fetcher", async () => {
    const store = memStore();
    const now = 10_000;
    await store.write(cacheKey("https://example.com/x", "auto"), {
      url: "https://example.com/x",
      engine: "auto",
      result: sampleResult,
      fetchedAt: now - 1000, // fresh under 1h TTL
    });
    let calls = 0;
    const result = await withCache(
      "https://example.com/x",
      "auto",
      {},
      async () => {
        calls += 1;
        return sampleResult;
      },
      store,
      now
    );
    expect(calls).toBe(0);
    expect(result).toBe(sampleResult);
  });

  it("calls the fetcher and stores the result on a miss", async () => {
    const store = memStore();
    let calls = 0;
    const result = await withCache(
      "https://example.com/x",
      "auto",
      {},
      async () => {
        calls += 1;
        return sampleResult;
      },
      store,
      10_000
    );
    expect(calls).toBe(1);
    expect(result).toBe(sampleResult);
    expect(store.data.size).toBe(1);
  });

  it("bypasses the cache (and refreshes) when noCache is set", async () => {
    const store = memStore();
    const key = cacheKey("https://example.com/x", "auto");
    await store.write(key, {
      url: "https://example.com/x",
      engine: "auto",
      result: sampleResult,
      fetchedAt: 0, // fresh-ish, but noCache should bypass anyway
    });
    let calls = 0;
    await withCache(
      "https://example.com/x",
      "auto",
      { noCache: true },
      async () => {
        calls += 1;
        return sampleResult;
      },
      store,
      10_000
    );
    expect(calls).toBe(1); // fetcher called despite a cached entry
    expect(store.data.get(key)?.fetchedAt).toBe(10_000); // refreshed
  });

  it("treats a stale entry as a miss (refetches)", async () => {
    const store = memStore();
    await store.write(cacheKey("https://example.com/x", "auto"), {
      url: "https://example.com/x",
      engine: "auto",
      result: sampleResult,
      fetchedAt: 0, // age 4_000_000ms > 1h TTL → stale
    });
    let calls = 0;
    await withCache(
      "https://example.com/x",
      "auto",
      {},
      async () => {
        calls += 1;
        return sampleResult;
      },
      store,
      4_000_000
    );
    expect(calls).toBe(1);
  });

  it("re-throws a fresh negative (failure) entry without calling the fetcher", async () => {
    const store = memStore();
    await store.write(cacheKey("https://example.com/dead", "auto"), {
      url: "https://example.com/dead",
      engine: "auto",
      error: "HTTP error! status: 404",
      fetchedAt: 9_000, // fresh under the 5min negative TTL at now=10_000
    });
    let calls = 0;
    await expect(
      withCache(
        "https://example.com/dead",
        "auto",
        {},
        async () => {
          calls += 1;
          return sampleResult;
        },
        store,
        10_000
      )
    ).rejects.toThrow(/404/);
    expect(calls).toBe(0);
  });

  it("refetches when a negative entry is stale (and overwrites on success)", async () => {
    const store = memStore();
    const key = cacheKey("https://example.com/dead", "auto");
    await store.write(key, {
      url: "https://example.com/dead",
      engine: "auto",
      error: "HTTP error! status: 503",
      fetchedAt: 0, // age 400_000ms > 5min negative TTL → stale
    });
    let calls = 0;
    const result = await withCache(
      "https://example.com/dead",
      "auto",
      {},
      async () => {
        calls += 1;
        return sampleResult;
      },
      store,
      400_000
    );
    expect(calls).toBe(1);
    expect(result).toBe(sampleResult);
    expect(store.data.get(key)?.error).toBeUndefined();
    expect(store.data.get(key)?.result).toBe(sampleResult);
  });

  it("caches a fetcher failure as a negative entry and re-throws", async () => {
    const store = memStore();
    const key = cacheKey("https://example.com/dead", "auto");
    await expect(
      withCache(
        "https://example.com/dead",
        "auto",
        {},
        async () => {
          throw new Error("network down");
        },
        store,
        10_000
      )
    ).rejects.toThrow(/network down/);
    expect(store.data.get(key)?.error).toBe("network down");
    expect(store.data.get(key)?.result).toBeUndefined();
  });
});
