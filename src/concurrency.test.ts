import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    // Later items resolve faster; order must still match input order.
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      await new Promise((r) => setTimeout(r, 30 - n * 10));
      return n * 10;
    });
    expect(results).toEqual([
      { status: "fulfilled", value: 10 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 30 },
    ]);
  });

  it("caps concurrency at the limit", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    });
    expect(maxActive).toBe(2);
  });

  it("isolates rejections (one failure does not break others)", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});
