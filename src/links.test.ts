import { describe, expect, it } from "vitest";
import { extractLinks } from "./links.js";

describe("extractLinks", () => {
  it("extracts a markdown link", () => {
    expect(extractLinks("see [the docs](https://example.com/docs)")).toEqual([
      { text: "the docs", url: "https://example.com/docs" },
    ]);
  });

  it("extracts multiple links", () => {
    const md = "[a](https://x.com/a) and [b](https://y.com/b)";
    expect(extractLinks(md)).toEqual([
      { text: "a", url: "https://x.com/a" },
      { text: "b", url: "https://y.com/b" },
    ]);
  });

  it("keeps only http(s) links (ignores relative anchors)", () => {
    const md = "[internal](/path) and [ext](https://example.com/x)";
    expect(extractLinks(md)).toEqual([
      { text: "ext", url: "https://example.com/x" },
    ]);
  });

  it("dedupes by URL (first occurrence wins)", () => {
    const md = "[one](https://example.com/x) again [two](https://example.com/x)";
    expect(extractLinks(md)).toEqual([
      { text: "one", url: "https://example.com/x" },
    ]);
  });

  it("returns an empty array when there are no links", () => {
    expect(extractLinks("just plain text, no links here")).toEqual([]);
  });
});
