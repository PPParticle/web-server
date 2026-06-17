/**
 * GitHub dedicated channel.
 *
 * GitHub content is fetched via raw URLs / the REST API for 1:1 fidelity,
 * NOT scraped from rendered HTML. This avoids the markdown→HTML→markdown
 * round-trip that loses code blocks, tables, and formatting.
 */

import { withRetry } from "./retry.js";

// ---- URL reference types (what a matched URL points to) ----

export interface GithubReadmeRef {
  owner: string;
  repo: string;
  branch?: string;
}

export interface GithubIssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface GithubRawRef {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

// ---- Minimal GitHub API response shapes (only fields used) ----

export interface GithubUser {
  login: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: string;
  body: string | null;
  user: GithubUser | null;
  created_at: string;
  html_url: string;
  labels?: { name: string }[];
  comments?: number;
}

export interface GithubComment {
  id: number;
  body: string | null;
  user: GithubUser | null;
  created_at: string;
  html_url: string;
}

// ---- Pure matchers / builders (TDD'd) ----

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function stripDotGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}

function pathSegments(url: string): string[] {
  const parsed = parseUrl(url);
  if (!parsed) return [];
  return parsed.pathname.split("/").filter(Boolean);
}

function isGithubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname === "www.github.com";
}

/** Match `github.com/{owner}/{repo}` or `.../tree/{branch}` to a README ref. */
export function matchGithubReadme(url: string): GithubReadmeRef | null {
  const parsed = parseUrl(url);
  if (!parsed || !isGithubHost(parsed.hostname)) return null;
  const segments = pathSegments(url);
  if (segments.length === 2) {
    return { owner: segments[0], repo: stripDotGit(segments[1]) };
  }
  if (segments.length === 4 && segments[2] === "tree") {
    return {
      owner: segments[0],
      repo: stripDotGit(segments[1]),
      branch: segments[3],
    };
  }
  return null;
}

/** Match `github.com/{owner}/{repo}/issues/{n}` to an issue ref. */
export function matchGithubIssue(url: string): GithubIssueRef | null {
  const parsed = parseUrl(url);
  if (!parsed || !isGithubHost(parsed.hostname)) return null;
  const segments = pathSegments(url);
  if (segments.length === 4 && segments[2] === "issues") {
    const num = Number(segments[3]);
    if (Number.isInteger(num) && num > 0) {
      return { owner: segments[0], repo: stripDotGit(segments[1]), number: num };
    }
  }
  return null;
}

/** Match `raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`. */
export function matchRawGithub(url: string): GithubRawRef | null {
  const parsed = parseUrl(url);
  if (!parsed || parsed.hostname !== "raw.githubusercontent.com") return null;
  const segments = pathSegments(url);
  if (segments.length >= 4) {
    return {
      owner: segments[0],
      repo: stripDotGit(segments[1]),
      branch: segments[2],
      path: segments.slice(3).join("/"),
    };
  }
  return null;
}

/** Build the raw README URL; uses the `HEAD` symbolic ref when no branch given. */
export function buildReadmeRawUrl(
  owner: string,
  repo: string,
  branch?: string
): string {
  const ref = branch ?? "HEAD";
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/README.md`;
}

/** Render a GitHub issue (+ comments) to markdown. */
export function renderIssueToMarkdown(
  issue: GithubIssue,
  comments: GithubComment[] = []
): string {
  const lines: string[] = [];
  lines.push(`# ${issue.title}`);
  lines.push("");
  lines.push(
    `**Issue #${issue.number}** · ${issue.state} · opened by ` +
      `${issue.user?.login ?? "unknown"} · ${issue.created_at}`
  );
  lines.push("");
  lines.push(issue.body ?? "*(no body)*");

  if (comments.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## Comments (${comments.length})`);
    for (const c of comments) {
      lines.push("");
      lines.push(`### @${c.user?.login ?? "unknown"} · ${c.created_at}`);
      lines.push("");
      lines.push(c.body ?? "*(no body)*");
      lines.push("");
      lines.push("---");
    }
  }
  return lines.join("\n").trim();
}

// ---- Network wrappers (thin; not unit-tested — boundary) ----

export interface GithubContent {
  title: string;
  content: string;
}

export interface FetchGithubIssueOptions {
  includeComments?: boolean;
  commentsPage?: number;
}

function githubApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mcp-web-reader",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch a repo README via the raw endpoint (1:1 markdown fidelity). */
export async function fetchGithubReadme(url: string): Promise<GithubContent> {
  const ref = matchGithubReadme(url);
  if (!ref) throw new Error(`not a GitHub readme URL: ${url}`);
  const rawUrl = buildReadmeRawUrl(ref.owner, ref.repo, ref.branch);
  const res = await withRetry(() =>
    fetch(rawUrl, { redirect: "follow" }).then((r) => {
      if (!r.ok) {
        throw new Error(`GitHub README fetch failed: ${r.status} for ${rawUrl}`);
      }
      return r;
    })
  );
  const content = await res.text();
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return { title: titleMatch?.[1] ?? ref.repo, content };
}

/** Fetch an issue (and optionally comments) via the REST API. */
export async function fetchGithubIssue(
  url: string,
  opts: FetchGithubIssueOptions = {}
): Promise<GithubContent> {
  const ref = matchGithubIssue(url);
  if (!ref) throw new Error(`not a GitHub issue URL: ${url}`);
  const headers = githubApiHeaders();
  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;

  const issueRes = await withRetry(() =>
    fetch(base, { headers }).then((r) => {
      if (!r.ok) {
        throw new Error(`GitHub issue fetch failed: ${r.status}`);
      }
      return r;
    })
  );
  const issue = (await issueRes.json()) as GithubIssue;

  let comments: GithubComment[] = [];
  if (opts.includeComments !== false) {
    const page = opts.commentsPage ?? 1;
    const cRes = await withRetry(() =>
      fetch(`${base}/comments?page=${page}&per_page=100`, { headers })
    );
    if (cRes.ok) comments = (await cRes.json()) as GithubComment[];
  }
  return { title: issue.title, content: renderIssueToMarkdown(issue, comments) };
}
