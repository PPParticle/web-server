/**
 * Browser instance pool with idle reclamation.
 *
 * Launches lazily, reuses across calls, and auto-closes after an idle period so
 * a long-running server does not hold a headless browser (and its memory)
 * forever. The launcher is injectable so the lifecycle is unit-testable without
 * a real browser; the idle timer is `.unref()`d so it never keeps the process
 * alive on its own.
 */

export interface Closeable {
  close(): Promise<void>;
}

export class BrowserPool<B extends Closeable> {
  private browser: B | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private launcher: () => Promise<B>, private idleMs: number) {}

  /** Return the current browser, launching it lazily; refreshes the idle timer. */
  async acquire(): Promise<B> {
    if (!this.browser) this.browser = await this.launcher();
    this.scheduleIdleClose();
    return this.browser;
  }

  /** Force-close immediately (e.g. on shutdown). */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  private scheduleIdleClose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.close();
    }, this.idleMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
}
