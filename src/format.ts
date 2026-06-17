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
