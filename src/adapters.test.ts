import { describe, expect, it } from "vitest";
import { findAdapter } from "./adapters.js";

describe("findAdapter", () => {
  it("matches a Juejin post URL", () => {
    expect(findAdapter("https://juejin.cn/post/12345")).toMatchObject({
      selector: ".article-content",
    });
  });

  it("returns null for an unmatched host", () => {
    expect(findAdapter("https://example.com/article")).toBeNull();
  });
});
