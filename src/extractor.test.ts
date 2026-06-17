import { describe, expect, it } from "vitest";
import { extractFromHtml } from "./extractor.js";

describe("extractFromHtml", () => {
  it("extracts main article text and strips nav, footer, and scripts", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>My Blog Post</title></head>
      <body>
        <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
        <article>
          <h1>Hello World</h1>
          <p>This is the main content of the article that should be extracted.</p>
          <p>It has multiple paragraphs to give Readability enough signal.</p>
        </article>
        <footer>Copyright 2024</footer>
        <script>console.log('track');</script>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/post");

    expect(result.content).toContain("main content of the article");
    expect(result.content).not.toContain("Home");
    expect(result.content).not.toContain("Copyright");
    expect(result.content).not.toContain("track");
  });

  it("returns the page title", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Understanding Closures in JavaScript</title></head>
      <body>
        <article>
          <h1>Understanding Closures in JavaScript</h1>
          <p>A closure is the combination of a function bundled together with
          references to its surrounding state.</p>
          <p>Another paragraph for Readability to detect this as the article body.</p>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/closures");

    expect(result.title).toBe("Understanding Closures in JavaScript");
  });

  it("preserves a code block with its language tag", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Code Example</title></head>
      <body>
        <article>
          <h1>Code Example</h1>
          <p>Here is a code example with enough text for Readability.</p>
          <p>More text to ensure this is detected as the article body.</p>
          <pre><code class="language-javascript">const answer = 42;</code></pre>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/code");

    expect(result.content).toContain("```javascript");
    expect(result.content).toContain("const answer = 42;");
  });

  it("preserves a table as a markdown table", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>API Reference</title></head>
      <body>
        <article>
          <h1>API Reference</h1>
          <p>Some intro text for Readability to detect the article body.</p>
          <p>More padding text to be safe.</p>
          <table>
            <thead><tr><th>Method</th><th>Path</th></tr></thead>
            <tbody>
              <tr><td>GET</td><td>/users</td></tr>
              <tr><td>POST</td><td>/users</td></tr>
            </tbody>
          </table>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/api");

    // Header row present
    expect(result.content).toMatch(/\| Method \| Path \|/);
    // Separator row — the defining marker of a markdown table
    expect(result.content).toMatch(/\|[\s-]+\|[\s-]+\|/);
    // Data rows
    expect(result.content).toContain("GET");
    expect(result.content).toContain("POST");
    expect(result.content).toContain("/users");
  });

  it("preserves links as markdown links", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Links</title></head>
      <body>
        <article>
          <h1>Links</h1>
          <p>Read the <a href="https://example.com/docs">documentation</a> for more details.</p>
          <p>Another paragraph so Readability detects this as the article body.</p>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/links");

    expect(result.content).toContain("[documentation](https://example.com/docs)");
  });

  it("extracts og:description, og:site_name, author, and published time from meta tags", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Anatomy of a Promise</title>
        <meta property="og:description" content="A short summary of the post.">
        <meta property="og:site_name" content="JS Deep Dives">
        <meta property="article:author" content="Jane Doe">
        <meta property="article:published_time" content="2024-03-15T08:00:00Z">
      </head>
      <body>
        <article>
          <h1>Anatomy of a Promise</h1>
          <p>A promise represents the eventual result of an async operation.</p>
          <p>More body text so Readability reliably detects the article.</p>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://jsdeepdives.example.com/promises");

    expect(result.metadata.description).toBe("A short summary of the post.");
    expect(result.metadata.siteName).toBe("JS Deep Dives");
    expect(result.metadata.author).toBe("Jane Doe");
    expect(result.metadata.publishedTime).toBe("2024-03-15T08:00:00Z");
  });

  it("returns undefined for metadata fields that are absent", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Bare Page</title></head>
      <body>
        <article>
          <h1>Bare Page</h1>
          <p>Just an article with no metadata whatsover in the head.</p>
          <p>Another paragraph to satisfy Readability detection.</p>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/bare");

    expect(result.metadata.url).toBe("https://example.com/bare");
    expect(result.metadata.description).toBeUndefined();
    expect(result.metadata.siteName).toBeUndefined();
    expect(result.metadata.author).toBeUndefined();
    expect(result.metadata.publishedTime).toBeUndefined();
  });

  it("does not throw on malformed or truncated HTML", async () => {
    const html = `<html><head><title>Broken><body><p>unclosed<div>messed<b>bold</p>`;

    await expect(extractFromHtml(html, "https://example.com/broken")).resolves.toBeDefined();
  });

  it("still returns body text for a page with no article structure", async () => {
    const html = `
      <html>
      <head><title>Plain</title></head>
      <body>
        <div>A page that is just a div with some plain text in it.</div>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/plain");

    expect(result.content).toContain("plain text in it");
  });

  it("removes script, style, and noscript content entirely", async () => {
    const html = `
      <html>
      <head>
        <title>Clean</title>
        <style>body { secret: STYLE_TOKEN; }</style>
        <noscript>enable js NOSCRIPT_TOKEN</noscript>
      </head>
      <body>
        <article>
          <h1>Clean</h1>
          <p>Real content paragraph one for Readability.</p>
          <p>Real content paragraph two for stability.</p>
        </article>
        <script>var leak = "SCRIPT_TOKEN";</script>
      </body>
      </html>
    `;

    const result = await extractFromHtml(html, "https://example.com/clean");

    expect(result.content).not.toContain("STYLE_TOKEN");
    expect(result.content).not.toContain("NOSCRIPT_TOKEN");
    expect(result.content).not.toContain("SCRIPT_TOKEN");
    expect(result.content).toContain("Real content");
  });

  it("falls back to Readability when no adapter matches", async () => {
    const html = `
      <html>
      <head><title>Fallback</title></head>
      <body>
        <article>
          <h1>Fallback Title</h1>
          <p>Article body that Readability should find even without the adapter selector.</p>
          <p>Second paragraph for stable detection.</p>
        </article>
      </body>
      </html>
    `;

    const result = await extractFromHtml(
      html,
      "https://example.com/no-adapter"
    );

    expect(result.content).toContain("Readability should find");
  });
});
