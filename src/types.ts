/**
 * Shared engine result type — the unified shape every fetch engine/channel
 * produces. Combines engine-level concerns (fetchedAt, contentLength, method)
 * with extracted metadata (description, author, ...).
 */
export interface FetchResult {
  title: string;
  content: string;
  metadata: {
    url: string;
    fetchedAt: string;
    contentLength: number;
    method: string;
    description?: string;
    author?: string;
    siteName?: string;
    publishedTime?: string;
    canonicalUrl?: string;
  };
  /** Low-quality signals (login wall, empty title, short body). Not rendered in Markdown. */
  warnings?: string[];
}
