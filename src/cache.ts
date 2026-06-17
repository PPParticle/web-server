/**
 * URL result cache (L1 filesystem).
 *
 * Stores extracted FetchResults keyed by (url, engine) so repeated reads of the
 * same URL within its TTL avoid refetching. Cache logic is pure and injectable
 * (CacheStore + `now`) so it is unit-testable without disk or wall-clock.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FetchResult } from "./types.js";

export interface CacheEntry {
  url: string;
  engine: string;
  result?: FetchResult; // present on a positive (success) entry
  error?: string; // present on a negative (failure) entry
  fetchedAt: number; // epoch ms
}

export interface CacheStore {
  read(key: string): Promise<CacheEntry | null>;
  write(key: string, entry: CacheEntry): Promise<void>;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const DEFAULT_TTL = HOUR;
const NEGATIVE_TTL = 5 * 60_000; // failures are cached 5 min (fail-fast on dead/transient URLs)

const TTL_BY_HOST: Array<{ hosts: string[]; ttl: number }> = [
  {
    hosts: ["github.com", "raw.githubusercontent.com", "api.github.com"],
    ttl: HOUR,
  },
  { hosts: ["arxiv.org"], ttl: DAY },
];

/** Deterministic cache key for a (url, engine) pair. */
export function cacheKey(url: string, engine: string): string {
  return crypto
    .createHash("sha256")
    .update(`${engine}:${url}`)
    .digest("hex")
    .slice(0, 32);
}

/** Host-based TTL (ms): GitHub 1h, arXiv 24h, default 1h. */
export function chooseTtlMs(url: string): number {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return DEFAULT_TTL;
  }
  for (const rule of TTL_BY_HOST) {
    if (rule.hosts.includes(host)) return rule.ttl;
  }
  return DEFAULT_TTL;
}

/** True if the entry is still within its TTL at `now`. */
export function isFresh(entry: CacheEntry, ttlMs: number, now: number): boolean {
  return now - entry.fetchedAt < ttlMs;
}

/** Fetch with cache: return a fresh cached result or call `fetcher` and store it. */
export async function withCache(
  url: string,
  engine: string,
  opts: { noCache?: boolean },
  fetcher: () => Promise<FetchResult>,
  store: CacheStore,
  now: number
): Promise<FetchResult> {
  const key = cacheKey(url, engine);
  if (!opts.noCache) {
    const entry = await store.read(key);
    if (entry) {
      // Negative (failure) entry: fail fast if still fresh.
      if (entry.error !== undefined) {
        if (isFresh(entry, NEGATIVE_TTL, now)) throw new Error(entry.error);
      } else if (entry.result && isFresh(entry, chooseTtlMs(url), now)) {
        return entry.result;
      }
    }
  }
  try {
    const result = await fetcher();
    await store.write(key, { url, engine, result, fetchedAt: now });
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await store.write(key, { url, engine, error: msg, fetchedAt: now });
    throw error;
  }
}

// ---- Filesystem store (boundary; not unit-tested) ----

export function resolveCacheDir(): string {
  return (
    process.env.WEB_READER_CACHE_DIR ??
    path.join(os.homedir(), ".cache", "mcp-web-reader")
  );
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100MB cap

/** Delete oldest cache files (by mtime) until total size is under `maxBytes`. */
export async function pruneCacheDir(
  dir: string,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const files: { name: string; size: number; mtime: number }[] = [];
  let total = 0;
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.isFile()) {
        files.push({ name, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      }
    } catch {
      // skip unreadable files
    }
  }
  if (total <= maxBytes) return;
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      await fs.unlink(path.join(dir, f.name));
      total -= f.size;
    } catch {
      // best-effort
    }
  }
}

export function createFsCacheStore(dir: string = resolveCacheDir()): CacheStore {
  return {
    read: async (key) => {
      try {
        const raw = await fs.readFile(path.join(dir, `${key}.json`), "utf8");
        return JSON.parse(raw) as CacheEntry;
      } catch {
        return null;
      }
    },
    write: async (key, entry) => {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(entry));
      } catch {
        // best-effort cache; write failures are non-fatal
      }
      // best-effort LRU eviction (non-blocking)
      pruneCacheDir(dir).catch(() => {});
    },
  };
}
