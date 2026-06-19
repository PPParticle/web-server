/**
 * Reddit dedicated channel.
 *
 * Posts are fetched via Reddit's .json endpoint (append .json to a post URL),
 * which returns the post + comment tree as JSON. Reddit stores bodies as
 * markdown, so no HTML conversion is needed. A descriptive User-Agent is
 * required (Reddit blocks default/empty UAs).
 */
import { withRetry } from "./retry.js";

export interface RedditPostRef {
  sub: string;
  id: string;
}

export interface RedditPost {
  title: string;
  selftext: string;
  author?: string;
  score?: number;
  subreddit?: string;
  num_comments?: number;
}

export interface RedditComment {
  body: string;
  author?: string;
  score?: number;
  replies?: RedditComment[];
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Match `reddit.com/r/{sub}/comments/{id}` (www./old., optional slug). */
export function matchRedditPost(url: string): RedditPostRef | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^www\./, "").replace(/^old\./, "");
  if (host !== "reddit.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // /r/{sub}/comments/{id}[/slug]
  if (segments.length >= 4 && segments[0] === "r" && segments[2] === "comments") {
    return { sub: segments[1], id: segments[3] };
  }
  return null;
}

// Reddit's comment tree: replies is either "" or { data: { children: [...] } }.
// Limit depth so a deep thread doesn't blow up the output.
function normalizeComment(data: unknown, depth: number): RedditComment {
  const d = data as Record<string, unknown>;
  const out: RedditComment = {
    body: (d?.body as string) ?? "",
    author: d?.author as string | undefined,
    score: d?.score as number | undefined,
  };
  if (depth < 1 && d?.replies && typeof d.replies === "object") {
    const children = ((d.replies as { data?: { children?: unknown[] } }).data?.children) ?? [];
    out.replies = children
      .filter((c) => (c as { kind?: string })?.kind === "t1")
      .map((c) => normalizeComment((c as { data: unknown }).data, depth + 1));
  }
  return out;
}

/** Parse Reddit's `.json` response into a normalized post + top comments. */
export function parseRedditJson(
  json: string
): { post: RedditPost; comments: RedditComment[] } | null {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const postData = (arr[0] as { data?: { children?: { data?: Record<string, unknown> }[] } })
    ?.data?.children?.[0]?.data;
  if (!postData) return null;
  const post: RedditPost = {
    title: (postData.title as string) ?? "",
    selftext: (postData.selftext as string) ?? "",
    author: postData.author as string | undefined,
    score: postData.score as number | undefined,
    subreddit: postData.subreddit as string | undefined,
    num_comments: postData.num_comments as number | undefined,
  };
  const rawComments =
    (arr[1] as { data?: { children?: { kind?: string; data?: unknown }[] } })?.data?.children ?? [];
  const comments = rawComments
    .filter((c) => c?.kind === "t1")
    .map((c) => normalizeComment(c.data, 0));
  return { post, comments };
}

/** Render a Reddit post (+ comments) to markdown. */
export function renderRedditToMarkdown(
  post: RedditPost,
  comments: RedditComment[] = []
): string {
  const lines: string[] = [];
  lines.push(`# ${post.title}`);
  const meta: string[] = [];
  if (post.subreddit) meta.push(`r/${post.subreddit}`);
  if (post.score !== undefined) meta.push(`${post.score} upvotes`);
  if (post.author) meta.push(`u/${post.author}`);
  if (meta.length) {
    lines.push("");
    lines.push(`**${meta.join(" · ")}**`);
  }
  if (post.selftext) {
    lines.push("");
    lines.push(post.selftext);
  }
  if (comments.length) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## Comments (${post.num_comments ?? comments.length})`);
    for (const c of comments) {
      lines.push("");
      lines.push(`### ${c.score ?? 0} points · u/${c.author ?? "unknown"}`);
      lines.push("");
      lines.push(c.body || "(empty)");
      if (c.replies?.length) {
        for (const r of c.replies) {
          lines.push("");
          lines.push(`> **u/${r.author ?? "unknown"} (${r.score ?? 0}):** ${r.body || ""}`);
        }
      }
      lines.push("");
      lines.push("---");
    }
  }
  return lines.join("\n").trim();
}

/** Fetch a Reddit post (+ comments) via the .json endpoint. */
export async function fetchRedditPost(
  url: string
): Promise<{ title: string; content: string }> {
  const ref = matchRedditPost(url);
  if (!ref) throw new Error(`not a Reddit post URL: ${url}`);
  const jsonUrl = `https://www.reddit.com/r/${ref.sub}/comments/${ref.id}.json`;
  const res = await withRetry(() =>
    fetch(jsonUrl, {
      headers: {
        "User-Agent": "mcp-web-server/2.0 (https://github.com/PPParticle/web-server)",
        Accept: "application/json",
      },
    }).then((r) => {
      if (!r.ok) throw new Error(`Reddit fetch failed: ${r.status}`);
      return r;
    })
  );
  const parsed = parseRedditJson(await res.text());
  if (!parsed) throw new Error(`Reddit returned no post for ${ref.id}`);
  return {
    title: parsed.post.title,
    content: renderRedditToMarkdown(parsed.post, parsed.comments),
  };
}
