import { describe, expect, it } from "vitest";
import { isRetriableError, withRetry } from "./retry.js";

describe("isRetriableError", () => {
  it("retries on 5xx status codes", () => {
    expect(isRetriableError(new Error("HTTP error! status: 500"))).toBe(true);
    expect(isRetriableError(new Error("HTTP error! status: 503"))).toBe(true);
  });

  it("retries on 429 and rate-limit messages", () => {
    expect(isRetriableError(new Error("HTTP error! status: 429"))).toBe(true);
    expect(isRetriableError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("retries on transient network errors with no status code", () => {
    expect(isRetriableError(new Error("timeout"))).toBe(true);
    expect(isRetriableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetriableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetriableError(new Error("fetch failed"))).toBe(true);
  });

  it("retries on AbortError (timeout-induced)", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isRetriableError(err)).toBe(true);
  });

  it("does not retry on 4xx (other than 429)", () => {
    expect(isRetriableError(new Error("HTTP error! status: 404"))).toBe(false);
  });

  it("does not retry on auth / 401 / 403", () => {
    expect(isRetriableError(new Error("HTTP error! status: 401"))).toBe(false);
    expect(isRetriableError(new Error("HTTP error! status: 403"))).toBe(false);
    expect(isRetriableError(new Error("auth failed"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result on first success (no retry)", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries and succeeds after a retriable failure", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP error! status: 503");
        return "recovered";
      },
      { sleep: async () => {} }
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("throws after max retries are exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("HTTP error! status: 503");
        },
        { sleep: async () => {}, maxRetries: 2 }
      )
    ).rejects.toThrow(/503/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("does not retry on a non-retriable error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("HTTP error! status: 404");
        },
        { sleep: async () => {} }
      )
    ).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("uses exponential backoff between retries", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("HTTP error! status: 500");
        return "ok";
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        jitterMs: 0,
      }
    );
    expect(delays).toEqual([500, 1000]);
  });
});
