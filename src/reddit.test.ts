import { describe, expect, it } from "vitest";
import {
  matchRedditPost,
  parseRedditJson,
  renderRedditToMarkdown,
} from "./reddit.js";

describe("matchRedditPost", () => {
  it("matches a /r/{sub}/comments/{id} URL", () => {
    expect(
      matchRedditPost("https://www.reddit.com/r/programming/comments/abc123")
    ).toEqual({ sub: "programming", id: "abc123" });
  });

  it("matches with a slug and old.reddit.com", () => {
    expect(
      matchRedditPost("https://old.reddit.com/r/programming/comments/abc123/some_post_title")
    ).toEqual({ sub: "programming", id: "abc123" });
  });

  it("rejects non-post URLs", () => {
    expect(matchRedditPost("https://www.reddit.com/r/programming")).toBeNull();
    expect(matchRedditPost("https://example.com/r/x/comments/y")).toBeNull();
  });
});

const fixture = JSON.stringify([
  {
    data: {
      children: [
        {
          kind: "t3",
          data: {
            title: "My Post",
            selftext: "post **body** here",
            author: "alice",
            score: 100,
            subreddit: "programming",
            num_comments: 2,
          },
        },
      ],
    },
  },
  {
    data: {
      children: [
        {
          kind: "t1",
          data: {
            body: "top comment",
            author: "bob",
            score: 10,
            replies: {
              data: {
                children: [{ kind: "t1", data: { body: "a reply", author: "carol", score: 3 } }],
              },
            },
          },
        },
        { kind: "more", data: {} },
      ],
    },
  },
]);

describe("parseRedditJson", () => {
  it("parses the post and top comments (filtering 'more')", () => {
    const out = parseRedditJson(fixture);
    expect(out).not.toBeNull();
    expect(out!.post.title).toBe("My Post");
    expect(out!.post.subreddit).toBe("programming");
    expect(out!.comments).toHaveLength(1); // the "more" item is filtered
    expect(out!.comments[0].body).toBe("top comment");
    expect(out!.comments[0].replies).toEqual([
      { body: "a reply", author: "carol", score: 3 },
    ]);
  });

  it("returns null on invalid JSON", () => {
    expect(parseRedditJson("not json")).toBeNull();
    expect(parseRedditJson(JSON.stringify({}))).toBeNull();
  });
});

describe("renderRedditToMarkdown", () => {
  it("renders title, selftext, and comments", () => {
    const out = parseRedditJson(fixture)!;
    const md = renderRedditToMarkdown(out.post, out.comments);

    expect(md).toContain("# My Post");
    expect(md).toContain("r/programming");
    expect(md).toContain("post **body** here");
    expect(md).toContain("top comment");
    expect(md).toContain("a reply");
  });
});
