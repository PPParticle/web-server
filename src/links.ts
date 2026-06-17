/**
 * Lightweight link extraction from markdown — lets the agent decide which
 * linked pages to explore further (recursive exploration is the agent's job,
 * not the reader's).
 */
export interface MarkdownLink {
  text: string;
  url: string;
}

/** Extract http(s) markdown links from `markdown`, deduped by URL. */
export function extractLinks(markdown: string): MarkdownLink[] {
  const re = /\[([^\]]*)\]\((https?:[^)\s]+)\)/g;
  const seen = new Set<string>();
  const out: MarkdownLink[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text: m[1], url });
  }
  return out;
}
