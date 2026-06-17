/**
 * Site adapters — per-host main-content selectors consulted before Readability.
 *
 * Design (per project grill): each adapter is ONLY a selector priority. If the
 * URL's host matches and the selector resolves, that container's HTML is used
 * directly; otherwise Readability runs as the generic fallback. Keep this list
 * small (<=10) and selector-only so a site redesign is a one-line fix.
 */

export interface SiteAdapter {
  hosts: string[];
  selector: string;
}

const ADAPTERS: SiteAdapter[] = [
  // 知乎/微信实测被反爬封禁,已移除;掘金配合反检测 Playwright 可读。
  { hosts: ["juejin.cn", "juejin.im"], selector: ".article-content" },
];

/** Return the adapter whose host list contains the URL's hostname, or null. */
export function findAdapter(url: string): SiteAdapter | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return ADAPTERS.find((a) => a.hosts.includes(host)) ?? null;
}
