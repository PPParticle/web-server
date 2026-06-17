/**
 * Stack Overflow dedicated channel.
 *
 * Questions are fetched via the Stack Exchange API (api.stackexchange.com) for
 * structured content (question body + answers, accepted flag) rather than
 * scraped. No key required (anonymous; with key: higher quota).
 */
import { withRetry } from "./retry.js";
import { htmlToMarkdown } from "./extractor.js";

export interface SOQuestionRef {
  id: number;
}

export interface SOQuestion {
  question_id: number;
  title: string;
  body: string; // HTML
  tags?: string[];
  score?: number;
}

export interface SOAnswer {
  answer_id: number;
  body: string; // HTML
  score?: number;
  is_accepted?: boolean;
  owner?: { display_name?: string };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Match `stackoverflow.com/questions/{id}` (with optional slug). */
export function matchStackOverflowQuestion(url: string): SOQuestionRef | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "stackoverflow.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // /questions/{id} or /questions/{id}/{slug}
  if (segments.length >= 2 && segments[0] === "questions") {
    const id = Number(segments[1]);
    if (Number.isInteger(id) && id > 0) return { id };
  }
  return null;
}

/** Render a question (+ answers) to markdown. */
export function renderStackOverflowToMarkdown(
  question: SOQuestion,
  answers: SOAnswer[] = []
): string {
  const lines: string[] = [];
  lines.push(`# ${question.title}`);
  lines.push("");
  const meta = [`SO Q#${question.question_id}`];
  if (question.score !== undefined) meta.push(`${question.score} votes`);
  if (question.tags?.length) meta.push(question.tags.map((t) => `\`${t}\``).join(" "));
  lines.push(`**${meta.join(" · ")}**`);
  lines.push("");
  lines.push(htmlToMarkdown(question.body));

  if (answers.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## Answers (${answers.length})`);
    // Accepted answer first, then by score desc.
    const sorted = [...answers].sort(
      (a, b) => Number(b.is_accepted ?? false) - Number(a.is_accepted ?? false) || (b.score ?? 0) - (a.score ?? 0)
    );
    for (const a of sorted) {
      lines.push("");
      const badge = a.is_accepted ? "Accepted · " : "";
      const owner = a.owner?.display_name ?? "unknown";
      lines.push(`### ${badge}${a.score ?? 0} votes · @${owner}`);
      lines.push("");
      lines.push(htmlToMarkdown(a.body));
      lines.push("");
      lines.push("---");
    }
  }
  return lines.join("\n").trim();
}

/** Fetch a question + answers via the SE API. */
export async function fetchStackOverflowQuestion(
  url: string
): Promise<{ title: string; content: string }> {
  const ref = matchStackOverflowQuestion(url);
  if (!ref) throw new Error(`not a Stack Overflow question URL: ${url}`);
  const base = `https://api.stackexchange.com/2.3/questions/${ref.id}`;
  const params = "site=stackoverflow&filter=withbody";

  const qRes = await withRetry(() =>
    fetch(`${base}?${params}`).then((r) => {
      if (!r.ok) throw new Error(`SE question fetch failed: ${r.status}`);
      return r;
    })
  );
  const qData = (await qRes.json()) as { items?: SOQuestion[] };
  const question = qData.items?.[0];
  if (!question) throw new Error(`Stack Overflow question ${ref.id} not found`);

  const aRes = await withRetry(() =>
    fetch(`${base}/answers?order=desc&sort=votes&${params}`).then((r) => {
      if (!r.ok) throw new Error(`SE answers fetch failed: ${r.status}`);
      return r;
    })
  );
  const aData = (await aRes.json()) as { items?: SOAnswer[] };
  const answers = aData.items ?? [];

  return {
    title: question.title,
    content: renderStackOverflowToMarkdown(question, answers),
  };
}
