/**
 * Safe fetch wrapper — adds per-hop redirect validation to global fetch.
 *
 * Every redirect Location is resolved to an absolute URL and run through
 * assertSafeFetchUrl, so a `safe.com → 127.0.0.1` redirect chain is blocked
 * instead of silently followed.
 *
 * DNS lookup is injectable so the redirect-safety check is unit-testable
 * without network.
 */
import { assertSafeFetchUrl, type Lookup } from "./ssrf.js";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Max redirects to follow; default 5. */
  maxRedirects?: number;
}

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Read response body as text, rejecting when it exceeds `maxBytes`.
 *
 * Pre-checks content-length when present; otherwise streams the body and
 * aborts as soon as the累计 byte count crosses the limit.
 */
export async function readLimitedText(
  res: Response,
  maxBytes: number
): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) {
    throw new Error(`response too large: ${len} > ${maxBytes}`);
  }
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`response too large: >${maxBytes}`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Fetch with manual redirect handling. Each hop — including the initial URL —
 * is validated by assertSafeFetchUrl. Redirects above `maxRedirects` throw.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
  lookup?: Lookup
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertSafeFetchUrl(current, lookup);
    const res = await fetch(current, { ...opts, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}
