/**
 * Output formatter: render a FetchResult as the markdown text returned to the
 * caller (LLM/agent). Kept pure so the format is unit-testable and shared by
 * every tool handler.
 */
import type { FetchResult } from "./types.js";

export function formatFetchResult(result: FetchResult): string {
  const { title, content, metadata: m } = result;
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`**URL**: ${m.url}`);
  lines.push(`**获取时间**: ${m.fetchedAt}`);
  lines.push(`**内容长度**: ${m.contentLength} 字符`);
  lines.push(`**解析方法**: ${m.method}`);
  if (m.description) lines.push(`**描述**: ${m.description}`);
  if (m.author) lines.push(`**作者**: ${m.author}`);
  if (m.siteName) lines.push(`**站点**: ${m.siteName}`);
  if (m.publishedTime) lines.push(`**发布时间**: ${m.publishedTime}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(content);
  return lines.join("\n");
}

export interface Paragraph {
  index: number;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  textPreview: string;
}

const PREVIEW_MAX = 160;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Split markdown body into paragraphs annotated with their heading path and
 * char offsets into `content`. Powers `structuredContent.paragraphs` so agents
 * can cite a precise span without parsing the Markdown themselves.
 *
 * - Blank-line separated runs of non-heading lines form a paragraph.
 * - Headings maintain a stack: a level-N heading pops any deeper/equal entries
 *   before pushing, so `## A` then `### A1` then `## B` yields paths
 *   `["A"]`, `["A","A1"]`, `["B"]`.
 */
export function splitParagraphs(content: string): Paragraph[] {
  const out: Paragraph[] = [];
  const stack: { level: number; text: string }[] = [];
  let index = 0;

  // Paragraph assembly state.
  let paraStart: number | null = null;
  let paraEnd = 0;

  const flush = () => {
    if (paraStart === null) return;
    const text = content.slice(paraStart, paraEnd);
    if (!text.trim()) {
      paraStart = null;
      return;
    }
    out.push({
      index: index++,
      headingPath: stack.map((h) => h.text),
      startOffset: paraStart,
      endOffset: paraEnd,
      textPreview: text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text,
    });
    paraStart = null;
  };

  let pos = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = pos;
    pos += line.length + 1; // +1 for the newline

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    // Non-blank, non-heading line: extend or start a paragraph.
    if (paraStart === null) paraStart = start;
    // Paragraph end should be the end of this line (exclusive of newline).
    paraEnd = start + line.length;
  }
  flush();
  return out;
}
