/**
 * Retry with exponential backoff + jitter.
 *
 * Retries happen INSIDE an engine before the caller falls back, so a transient
 * 5xx/429/network blip does not trigger a costly Playwright launch. Strategy
 * adapted from zai-cli.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  /** Injectable sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable classifier; defaults to isRetriableError. */
  isRetriable?: (error: unknown) => boolean;
}

/** Classify whether an error is worth retrying. */
export function isRetriableError(error: unknown): boolean {
  // AbortError = timeout-induced, always retriable.
  if (error instanceof Error && error.name === "AbortError") return true;

  const msg = error instanceof Error ? error.message : String(error);

  // Status-first: if a 4xx/5xx code is present, decide by it (so a "fetch
  // failed: 404" message is classified by the 404, not the word "fetch").
  const statusMatch = msg.match(/\b([45]\d{2})\b/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 429) return true;
    if (status >= 500) return true;
    return false; // 4xx other than 429
  }

  // No status: classify by transient network-level keywords.
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("fetch")
  );
}

const RETRY_DEFAULTS = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitterMs: 250,
};

/** Run `fn`, retrying on transient errors with exponential backoff + jitter. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? RETRY_DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs;
  const jitterMs = opts.jitterMs ?? RETRY_DEFAULTS.jitterMs;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isRetriable = opts.isRetriable ?? isRetriableError;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries || !isRetriable(error)) throw error;
      const backoff = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1)
      );
      const jitter = Math.floor(Math.random() * jitterMs);
      await sleep(backoff + jitter);
    }
  }
}
