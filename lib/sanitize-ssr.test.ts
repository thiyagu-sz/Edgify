import { describe, expect, it } from "vitest";
import { CROSS_ENV_INPUT, CROSS_ENV_OUTPUT } from "@/test/sanitize-fixture";
import { XSS_PAYLOADS } from "@/test/xss-payloads";
import { renderMarkdown, sanitizeModelText } from "./sanitize";

/**
 * Node environment ON PURPOSE — no `document`.
 *
 * This file used to assert a FAIL-CLOSED fallback: DOMPurify needs a DOM, so with none available
 * `renderMarkdown` escaped everything into a `<pre>` block. Correct, but it meant the server
 * could never sanitise — only degrade — and that made the client the only real gate. Once concept
 * detail is persisted and then distributed by the cache and the clone, a client-only gate is the
 * wrong seam (see `sanitizeModelText`), so the sanitiser was moved to `sanitize-html`, which
 * parses with htmlparser2 and needs no DOM.
 *
 * So the property under test is now much stronger: the SAME policy, producing the SAME output,
 * with no browser globals present at all.
 */

describe("sanitisation without a DOM", () => {
  it("has no DOM in this environment (guards the premise of these tests)", () => {
    expect(typeof document).toBe("undefined");
  });

  it("produces byte-identical HTML to the jsdom run", () => {
    // The same assertion runs under jsdom in lib/sanitize.test.ts. If the two ever diverge, one
    // of the two suites fails with a diff.
    expect(renderMarkdown(CROSS_ENV_INPUT)).toBe(CROSS_ENV_OUTPUT);
  });

  it("does not degrade to escaped preformatted text", () => {
    // The old fail-closed behaviour. Its absence is what proves the server is sanitising rather
    // than giving up.
    expect(renderMarkdown("# Title\n\n- a real point")).not.toMatch(/^<pre>/);
    expect(renderMarkdown("# Title\n\n- a real point")).toMatch(/<h1[^>]*>Title<\/h1>/);
  });

  /**
   * Parser-free equivalent of `assertNoExecutableDom`: with no DOM there is no tree to inspect,
   * so instead require that every `<` opening a tag in the output opens an ALLOWLISTED tag.
   * Escaped payloads appear as `&lt;…` and are correctly not matched, so this does not report the
   * safe "attack rendered as visible text" case as a failure.
   */
  const ALLOWED = new Set([
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "ul", "ol", "li",
    "strong", "b", "em", "i", "del", "s", "code", "pre", "blockquote",
    "table", "thead", "tbody", "tr", "th", "td", "a",
  ]);

  function offendingTags(html: string): string[] {
    return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)]
      .map((m) => m[1].toLowerCase())
      .filter((tag) => !ALLOWED.has(tag));
  }

  for (const { name, payload } of XSS_PAYLOADS) {
    it(`emits only allowlisted elements for: ${name}`, () => {
      const html = renderMarkdown(payload);
      expect(offendingTags(html), `disallowed elements survived for "${name}"`).toEqual([]);
      expect(html).not.toMatch(/\shref\s*=\s*["']?\s*javascript:/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    });

    it(`stores no markup at all for: ${name}`, () => {
      // The persist seam runs server-side, which is the whole point of the swap.
      const stored = sanitizeModelText(payload);
      expect([...stored.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1])).toEqual([]);
    });
  }
});
