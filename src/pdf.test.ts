import { describe, expect, it } from "vitest";
import {
  isPdfUrl,
  isPdfContentType,
  buildPdfHandoff,
} from "./pdf.js";

describe("isPdfUrl", () => {
  it("returns true for a .pdf URL", () => {
    expect(isPdfUrl("https://example.com/paper.pdf")).toBe(true);
  });

  it("is case-insensitive on the suffix", () => {
    expect(isPdfUrl("https://example.com/paper.PDF")).toBe(true);
  });

  it("ignores a query string after the path", () => {
    expect(isPdfUrl("https://example.com/paper.pdf?download=1")).toBe(true);
  });

  it("returns false for non-pdf URLs", () => {
    expect(isPdfUrl("https://example.com/paper.html")).toBe(false);
    expect(isPdfUrl("https://example.com/paper")).toBe(false);
  });
});

describe("isPdfContentType", () => {
  it("detects application/pdf", () => {
    expect(isPdfContentType("application/pdf")).toBe(true);
  });

  it("detects application/pdf with parameters", () => {
    expect(isPdfContentType("application/pdf; charset=binary")).toBe(true);
  });

  it("returns false for non-pdf content types", () => {
    expect(isPdfContentType("text/html; charset=utf-8")).toBe(false);
  });
});

describe("buildPdfHandoff", () => {
  it("returns a message naming the url, recommending curl + Python", () => {
    const url = "https://example.com/paper.pdf";
    const handoff = buildPdfHandoff(url);

    expect(handoff.content).toContain(url);
    expect(handoff.content).toMatch(/curl/i);
    expect(handoff.content).toMatch(/python/i);
    expect(handoff.content.toLowerCase()).toContain("does not parse");
  });
});
