import { describe, expect, it } from "vitest";
import {
  matchGithubReadme,
  matchGithubIssue,
  matchRawGithub,
  buildReadmeRawUrl,
  renderIssueToMarkdown,
} from "./github.js";
import type { GithubIssue, GithubComment } from "./github.js";

describe("matchGithubReadme", () => {
  it("matches a plain owner/repo URL", () => {
    expect(matchGithubReadme("https://github.com/facebook/react")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("matches owner/repo/tree/branch and captures the branch", () => {
    expect(matchGithubReadme("https://github.com/facebook/react/tree/v18")).toEqual({
      owner: "facebook",
      repo: "react",
      branch: "v18",
    });
  });

  it("matches with a trailing slash", () => {
    expect(matchGithubReadme("https://github.com/facebook/react/")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("rejects issue, pull, and blob URLs (not a README)", () => {
    expect(matchGithubReadme("https://github.com/facebook/react/issues/1")).toBeNull();
    expect(matchGithubReadme("https://github.com/facebook/react/pull/2")).toBeNull();
    expect(matchGithubReadme("https://github.com/facebook/react/blob/main/x.ts")).toBeNull();
  });

  it("rejects non-repo paths and non-github hosts", () => {
    expect(matchGithubReadme("https://github.com/about")).toBeNull();
    expect(matchGithubReadme("https://example.com/facebook/react")).toBeNull();
  });
});

describe("matchGithubIssue", () => {
  it("matches an owner/repo/issues/N URL", () => {
    expect(matchGithubIssue("https://github.com/facebook/react/issues/13991")).toEqual({
      owner: "facebook",
      repo: "react",
      number: 13991,
    });
  });

  it("rejects non-issue URLs", () => {
    expect(matchGithubIssue("https://github.com/facebook/react")).toBeNull();
    expect(matchGithubIssue("https://github.com/facebook/react/pull/1")).toBeNull();
    expect(matchGithubIssue("https://example.com/x/y/issues/1")).toBeNull();
  });
});

describe("matchRawGithub", () => {
  it("matches a raw.githubusercontent.com file URL", () => {
    expect(
      matchRawGithub(
        "https://raw.githubusercontent.com/facebook/react/main/packages/react/index.js"
      )
    ).toEqual({
      owner: "facebook",
      repo: "react",
      branch: "main",
      path: "packages/react/index.js",
    });
  });

  it("rejects github.com (not raw) URLs", () => {
    expect(matchRawGithub("https://github.com/facebook/react")).toBeNull();
  });
});

describe("buildReadmeRawUrl", () => {
  it("uses the HEAD symbolic ref when no branch is given", () => {
    expect(buildReadmeRawUrl("facebook", "react")).toBe(
      "https://raw.githubusercontent.com/facebook/react/HEAD/README.md"
    );
  });

  it("uses the explicit branch when provided", () => {
    expect(buildReadmeRawUrl("facebook", "react", "v18.3.1")).toBe(
      "https://raw.githubusercontent.com/facebook/react/v18.3.1/README.md"
    );
  });
});

const sampleIssue: GithubIssue = {
  number: 42,
  title: "Bug: something is broken",
  state: "open",
  body: "Here is the bug description with steps to reproduce.",
  user: { login: "alice" },
  created_at: "2024-01-15T10:00:00Z",
  html_url: "https://github.com/o/r/issues/42",
};

describe("renderIssueToMarkdown", () => {
  it("renders the issue title, number, state, author, and body", () => {
    const md = renderIssueToMarkdown(sampleIssue);

    expect(md).toContain("# Bug: something is broken");
    expect(md).toContain("#42");
    expect(md).toContain("open");
    expect(md).toContain("alice");
    expect(md).toContain("Here is the bug description with steps to reproduce.");
  });

  it("includes a comments section with each comment's author, date, and body", () => {
    const comments: GithubComment[] = [
      {
        id: 1,
        body: "I can reproduce this too.",
        user: { login: "bob" },
        created_at: "2024-01-15T11:00:00Z",
        html_url: "https://github.com/o/r/issues/42#issuecomment-1",
      },
    ];

    const md = renderIssueToMarkdown(sampleIssue, comments);

    expect(md).toContain("bob");
    expect(md).toContain("I can reproduce this too.");
    expect(md).toMatch(/comments?\b/i);
  });

  it("omits the comments section when there are no comments", () => {
    const md = renderIssueToMarkdown(sampleIssue, []);

    expect(md).not.toMatch(/^##\s+Comments/m);
  });
});
