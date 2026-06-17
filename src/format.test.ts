import { describe, expect, it } from "vitest";
import { formatFetchResult } from "./format.js";
import type { FetchResult } from "./types.js";

const baseResult: FetchResult = {
  title: "Some Title",
  content: "The body of the page.",
  metadata: {
    url: "https://example.com/page",
    fetchedAt: "2026-06-17T00:00:00Z",
    contentLength: 21,
    method: "local-parser",
  },
};

describe("formatFetchResult", () => {
  it("includes the title, url, method, and content", () => {
    const md = formatFetchResult(baseResult);

    expect(md).toContain("# Some Title");
    expect(md).toContain("https://example.com/page");
    expect(md).toContain("local-parser");
    expect(md).toContain("The body of the page.");
  });

  it("includes extraction metadata (description/author/siteName/publishedTime) when present", () => {
    const md = formatFetchResult({
      ...baseResult,
      metadata: {
        ...baseResult.metadata,
        description: "A short summary.",
        author: "Jane Doe",
        siteName: "JS Deep Dives",
        publishedTime: "2026-01-15T08:00:00Z",
      },
    });

    expect(md).toContain("A short summary.");
    expect(md).toContain("Jane Doe");
    expect(md).toContain("JS Deep Dives");
    expect(md).toContain("2026-01-15T08:00:00Z");
  });

  it("omits extraction metadata lines when absent", () => {
    const md = formatFetchResult(baseResult);

    // The base result has no og metadata; the content body shouldn't be
    // cluttered with empty metadata labels.
    expect(md).not.toContain("A short summary.");
    expect(md).not.toContain("Jane Doe");
  });
});
