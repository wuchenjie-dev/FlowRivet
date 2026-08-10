import { describe, expect, it } from "vitest";

import {
  MAX_SANITIZED_DESCRIPTION_BYTES,
  sanitizeDescription,
} from "../src/work-items/sanitize-description.js";

describe("sanitize description", () => {
  it("keeps only the basic rich-text allowlist", () => {
    const result = sanitizeDescription(`
      <div><p class="lead" data-id="1">Text <strong>bold</strong> <em>em</em><br></p>
      <ul><li>one</li></ul><ol><li>two</li></ol><pre><code>const x = 1;</code></pre></div>
    `);

    expect(result.html).toContain("<p>Text <strong>bold</strong> <em>em</em><br /></p>");
    expect(result.html).toContain("<ul><li>one</li></ul>");
    expect(result.html).toContain("<ol><li>two</li></ol>");
    expect(result.html).toContain("<pre><code>const x = 1;</code></pre>");
    expect(result.html).not.toMatch(/<div|class=|data-id=/);
    expect(result.truncated).toBe(false);
  });

  it("removes executable and presentational provider markup", () => {
    const result = sanitizeDescription(`
      <script>alert(1)</script><style>body{display:none}</style>
      <iframe src="https://evil.example"></iframe>
      <img src=x onerror="alert(1)"><form><input value="secret"></form>
      <p onclick="alert(1)" style="color:red">Safe</p>
    `);

    expect(result.html).toContain("<p>Safe</p>");
    expect(result.html).not.toMatch(/script|style|iframe|img|form|input|onerror|onclick/i);
  });

  it("keeps only HTTPS links and hardens links opened in a new tab", () => {
    const result = sanitizeDescription(`
      <a href="https://docs.example/path">safe</a>
      <a href="http://docs.example/path">http</a>
      <a href="javascript:alert(1)">script</a>
      <a href="mailto:test@example.com">mail</a>
    `);

    expect(result.html).toContain(
      '<a href="https://docs.example/path" target="_blank" rel="noreferrer">safe</a>',
    );
    expect(result.html).not.toMatch(/href="(?:http:|javascript:|mailto:)/);
  });

  it("returns an empty result for empty provider content", () => {
    expect(sanitizeDescription("  ")).toEqual({ html: undefined, truncated: false });
  });

  it("bounds oversized output without returning broken HTML", () => {
    const result = sanitizeDescription(`<p>${"a".repeat(300_000)}</p>`);

    expect(result.truncated).toBe(true);
    expect(result.html).toMatch(/^<p>.*…<\/p>$/s);
    expect(Buffer.byteLength(result.html ?? "", "utf8"))
      .toBeLessThanOrEqual(MAX_SANITIZED_DESCRIPTION_BYTES);
  });
});
