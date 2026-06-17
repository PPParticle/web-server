import { describe, expect, it } from "vitest";
import {
  matchArxivAbs,
  matchArxivHtml,
  matchArxivPdf,
  parseArxivAtom,
  renderArxivEntryToMarkdown,
} from "./arxiv.js";
import type { ArxivEntry } from "./arxiv.js";

describe("matchArxivAbs", () => {
  it("matches an abs URL", () => {
    expect(matchArxivAbs("https://arxiv.org/abs/2501.12345")).toEqual({
      id: "2501.12345",
    });
  });

  it("keeps the version in the id", () => {
    expect(matchArxivAbs("https://arxiv.org/abs/2501.12345v2")).toEqual({
      id: "2501.12345v2",
    });
  });

  it("rejects non-abs and non-arxiv URLs", () => {
    expect(matchArxivAbs("https://arxiv.org/pdf/2501.12345")).toBeNull();
    expect(matchArxivAbs("https://example.com/abs/2501.12345")).toBeNull();
  });
});

describe("matchArxivHtml", () => {
  it("matches an html URL", () => {
    expect(matchArxivHtml("https://arxiv.org/html/2501.12345")).toEqual({
      id: "2501.12345",
    });
  });

  it("rejects non-html URLs", () => {
    expect(matchArxivHtml("https://arxiv.org/abs/2501.12345")).toBeNull();
  });
});

describe("matchArxivPdf", () => {
  it("matches a pdf URL", () => {
    expect(matchArxivPdf("https://arxiv.org/pdf/2501.12345")).toEqual({
      id: "2501.12345",
    });
  });

  it("strips a trailing .pdf suffix from the id", () => {
    expect(matchArxivPdf("https://arxiv.org/pdf/2501.12345v2.pdf")).toEqual({
      id: "2501.12345v2",
    });
  });

  it("rejects non-pdf URLs", () => {
    expect(matchArxivPdf("https://arxiv.org/abs/2501.12345")).toBeNull();
  });
});

const atomFixture = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2501.12345v1</id>
    <title>A Study of Something Interesting</title>
    <summary>This paper investigates something in detail.</summary>
    <published>2025-01-20T00:00:00Z</published>
    <updated>2025-01-25T00:00:00Z</updated>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
    <link href="http://arxiv.org/pdf/2501.12345v1" rel="related" title="pdf"/>
    <link href="http://arxiv.org/html/2501.12345v1" rel="related" type="text/html"/>
    <link href="http://arxiv.org/abs/2501.12345v1" rel="alternate" type="text/html"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL"/>
    <category term="cs.CL"/>
    <category term="cs.AI"/>
  </entry>
</feed>`;

describe("parseArxivAtom", () => {
  it("parses title, summary, authors, dates, categories, and links", () => {
    const entry = parseArxivAtom(atomFixture);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("2501.12345v1");
    expect(entry!.title).toBe("A Study of Something Interesting");
    expect(entry!.summary).toBe("This paper investigates something in detail.");
    expect(entry!.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(entry!.published).toBe("2025-01-20T00:00:00Z");
    expect(entry!.updated).toBe("2025-01-25T00:00:00Z");
    expect(entry!.primaryCategory).toBe("cs.CL");
    expect(entry!.categories).toEqual(["cs.CL", "cs.AI"]);
    expect(entry!.pdfUrl).toBe("http://arxiv.org/pdf/2501.12345v1");
    expect(entry!.htmlUrl).toBe("http://arxiv.org/html/2501.12345v1");
  });

  it("returns null when the feed has no entry", () => {
    const empty = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
    expect(parseArxivAtom(empty)).toBeNull();
  });
});

const sampleEntry: ArxivEntry = {
  id: "2501.12345v1",
  title: "A Study of Something Interesting",
  summary: "This paper investigates something in detail.",
  authors: ["Alice Smith", "Bob Jones"],
  published: "2025-01-20T00:00:00Z",
  updated: "2025-01-25T00:00:00Z",
  primaryCategory: "cs.CL",
  categories: ["cs.CL", "cs.AI"],
  pdfUrl: "http://arxiv.org/pdf/2501.12345v1",
  htmlUrl: "http://arxiv.org/html/2501.12345v1",
  absUrl: "http://arxiv.org/abs/2501.12345v1",
};

describe("renderArxivEntryToMarkdown", () => {
  it("renders title, id, category, dates, authors, abstract, and links", () => {
    const md = renderArxivEntryToMarkdown(sampleEntry);

    expect(md).toContain("# A Study of Something Interesting");
    expect(md).toContain("2501.12345v1");
    expect(md).toContain("cs.CL");
    expect(md).toContain("Alice Smith");
    expect(md).toContain("Bob Jones");
    expect(md).toContain("## Abstract");
    expect(md).toContain("This paper investigates something in detail.");
    expect(md).toContain("http://arxiv.org/pdf/2501.12345v1");
  });
});
