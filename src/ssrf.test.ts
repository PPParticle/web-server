import { describe, expect, it } from "vitest";
import {
  isPrivateIp,
  isBlockedHost,
  assertSafeFetchUrl,
} from "./ssrf.js";

describe("isPrivateIp", () => {
  it("flags loopback and private IPv4 ranges", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("flags the 172.16/12 range only between 172.16 and 172.31", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("flags link-local (cloud metadata) addresses", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("does not flag public IPv4", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  it("flags IPv6 loopback, link-local, and ULA", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd00::1")).toBe(true);
  });

  it("does not flag public IPv6", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHost", () => {
  it("blocks localhost and cloud-metadata hostnames", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
  });

  it("blocks .internal and .local suffixes", () => {
    expect(isBlockedHost("foo.internal")).toBe(true);
    expect(isBlockedHost("my-service.local")).toBe(true);
  });

  it("does not block public hostnames", () => {
    expect(isBlockedHost("example.com")).toBe(false);
  });
});

describe("assertSafeFetchUrl", () => {
  it("rejects a blocked host without calling lookup", async () => {
    const lookup = async () => {
      throw new Error("lookup should not be called");
    };
    await expect(
      assertSafeFetchUrl("https://localhost/secret", lookup)
    ).rejects.toThrow(/blocked host/i);
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(
      assertSafeFetchUrl("file:///etc/passwd", async () => [])
    ).rejects.toThrow(/scheme/i);
  });

  it("rejects a literal private IP host", async () => {
    await expect(
      assertSafeFetchUrl("https://169.254.169.254/latest/meta-data", async () => [])
    ).rejects.toThrow(/private/i);
  });

  it("rejects when DNS resolves to a private IP", async () => {
    const lookup = async () => ["10.0.0.1"];
    await expect(
      assertSafeFetchUrl("https://internal.example.com/", lookup)
    ).rejects.toThrow(/private/i);
  });

  it("accepts a URL that resolves to a public IP", async () => {
    const lookup = async () => ["93.184.216.34"];
    await expect(
      assertSafeFetchUrl("https://example.com/", lookup)
    ).resolves.toBeUndefined();
  });
});
