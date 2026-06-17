/**
 * SSRF protection.
 *
 * Before fetching an arbitrary user URL, validate that it does not resolve to
 * a private / loopback / link-local address (which would expose internal
 * services and cloud metadata endpoints). DNS resolution is injectable so the
 * check is unit-testable without network.
 *
 * Note: this checks the resolved IP at validation time. A DNS-rebinding attack
 * (IP changing between check and connect) is not fully prevented; full
 * mitigation would require pinning the resolved IP for the fetch.
 */

import dns from "node:dns/promises";

export type Lookup = (host: string) => Promise<string[]>;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 0) return true; // 0.0.0.0/8 reserved
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA
  const mapped = lower.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]); // IPv4-mapped IPv6
  return false;
}

/** True if an IP literal is private/loopback/link-local/reserved. */
export function isPrivateIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/** True if a hostname should be blocked without DNS lookup. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h === "metadata.google.internal") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  return false;
}

function looksLikeIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

const defaultLookup: Lookup = async (host) => {
  try {
    const result = await dns.lookup(host, { all: true });
    return result.map((r) => r.address);
  } catch {
    return [];
  }
};

/** Throw if `url` is not safe for the reader to fetch. */
export async function assertSafeFetchUrl(
  url: string,
  lookup: Lookup = defaultLookup
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`blocked scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    throw new Error(`blocked host: ${host}`);
  }
  if (looksLikeIp(host)) {
    if (isPrivateIp(host)) throw new Error(`private IP: ${host}`);
    return;
  }
  const addrs = await lookup(host);
  for (const addr of addrs) {
    if (isPrivateIp(addr)) throw new Error(`resolves to private IP: ${addr}`);
  }
}
