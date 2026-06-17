import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BrowserPool, type Closeable } from "./browser-pool.js";

interface FakeBrowser extends Closeable {
  closed: number;
}

function fakeBrowser(): FakeBrowser {
  const b = { closed: 0, close: async () => {} };
  // track closes after the fact
  const orig = b.close;
  b.close = async () => {
    b.closed += 1;
    await orig();
  };
  return b;
}

describe("BrowserPool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("launches once and reuses the same instance", async () => {
    let launches = 0;
    const pool = new BrowserPool<FakeBrowser>(async () => {
      launches += 1;
      return fakeBrowser();
    }, 60_000);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(launches).toBe(1);
    expect(a).toBe(b);
  });

  it("closes the browser after the idle timeout", async () => {
    const b = fakeBrowser();
    const pool = new BrowserPool(async () => b, 60_000);
    await pool.acquire();
    expect(b.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.closed).toBe(1);
  });

  it("stays alive when re-acquired before the idle timeout", async () => {
    const b = fakeBrowser();
    const pool = new BrowserPool(async () => b, 60_000);
    await pool.acquire();
    await vi.advanceTimersByTimeAsync(30_000); // halfway
    await pool.acquire(); // refresh the idle window
    await vi.advanceTimersByTimeAsync(30_000); // original deadline passed, but refreshed
    expect(b.closed).toBe(0);
  });

  it("re-launches after being closed for idle", async () => {
    let launches = 0;
    const pool = new BrowserPool<FakeBrowser>(async () => {
      launches += 1;
      return fakeBrowser();
    }, 60_000);
    await pool.acquire();
    await vi.advanceTimersByTimeAsync(60_000); // idle-closed
    await pool.acquire(); // re-launch
    expect(launches).toBe(2);
  });

  it("close() shuts down immediately", async () => {
    const b = fakeBrowser();
    const pool = new BrowserPool(async () => b, 60_000);
    await pool.acquire();
    await pool.close();
    expect(b.closed).toBe(1);
  });
});
