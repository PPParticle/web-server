import { describe, expect, it } from "vitest";
import {
  matchStackOverflowQuestion,
  renderStackOverflowToMarkdown,
} from "./stackoverflow.js";

describe("matchStackOverflowQuestion", () => {
  it("matches a /questions/{id} URL", () => {
    expect(
      matchStackOverflowQuestion("https://stackoverflow.com/questions/12345")
    ).toEqual({ id: 12345 });
  });

  it("matches with a slug after the id", () => {
    expect(
      matchStackOverflowQuestion(
        "https://stackoverflow.com/questions/12345/how-to-do-x"
      )
    ).toEqual({ id: 12345 });
  });

  it("rejects non-question URLs", () => {
    expect(
      matchStackOverflowQuestion("https://stackoverflow.com/users/1")
    ).toBeNull();
    expect(
      matchStackOverflowQuestion("https://example.com/questions/1")
    ).toBeNull();
  });
});

describe("renderStackOverflowToMarkdown", () => {
  it("renders the question title, body, and answers", () => {
    const md = renderStackOverflowToMarkdown(
      { question_id: 1, title: "How to foo the bar?", body: "<p>I want to foo.</p>" },
      [
        {
          answer_id: 10,
          body: "<p>Use <code>foo()</code>.</p>",
          score: 42,
          is_accepted: true,
          owner: { display_name: "alice" },
        },
        {
          answer_id: 11,
          body: "<p>Alternatively, bar.</p>",
          score: 5,
          owner: { display_name: "bob" },
        },
      ]
    );

    expect(md).toContain("# How to foo the bar?");
    expect(md).toContain("I want to foo.");
    expect(md).toContain("Use `foo()`.");
    expect(md).toContain("Accepted");
    expect(md).toContain("42");
    expect(md).toContain("alice");
    expect(md).toContain("Alternatively, bar.");
  });

  it("works with no answers", () => {
    const md = renderStackOverflowToMarkdown(
      { question_id: 1, title: "Q", body: "<p>body</p>" },
      []
    );
    expect(md).toContain("# Q");
    expect(md).toContain("body");
  });
});
