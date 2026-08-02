// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { CROSS_ENV_INPUT, CROSS_ENV_OUTPUT } from "@/test/sanitize-fixture";
import {
  ALL_PAYLOADS_COMBINED,
  JSDOM_FIREABLE_PAYLOADS,
  XSS_PAYLOADS,
  assertNoExecutableMarkup,
  renderAndFire,
  resetXssSentinel,
  xssFired,
} from "@/test/xss-payloads";
import { renderMarkdown, sanitizeModelText } from "./sanitize";

/**
 * The highest-severity UI rule (.claude/rules/ui.md): model output is sanitised before it ever
 * reaches dangerouslySetInnerHTML. Model output can be steered by text inside an uploaded
 * document, so these payloads stand in for "a classmate uploads a poisoned PDF, the model echoes
 * it".
 *
 * jsdom's HTML parser is not Chrome's, so the mutation-XSS payloads here are necessary but not
 * sufficient — they are re-run against a real browser in the Playwright pass.
 */

/**
 * This file lives in the `unit` project, whose setup file has no DOM concerns, so the sentinel is
 * reset here rather than globally. Without it the negative control below — which deliberately
 * FIRES the sentinel — would leave it set for every test after it.
 */
beforeEach(() => {
  resetXssSentinel();
});

describe("NEGATIVE CONTROL — the corpus is live when nothing sanitises it", () => {
  /**
   * Without this block the whole file proves nothing. Every assertion below is "the sentinel did
   * not fire", which a corpus of inert strings would satisfy just as well as a working sanitiser.
   * So: render the SAME payloads through raw `innerHTML`, with the same driver, and require that
   * they DO fire. If this block ever goes green-by-accident, the corpus has decayed and the
   * assertions beside it have stopped meaning anything.
   */
  for (const { name, payload } of JSDOM_FIREABLE_PAYLOADS) {
    it(`fires unsanitised: ${name}`, () => {
      resetXssSentinel();
      const { fired, host } = renderAndFire(payload);
      host.remove();
      expect(
        fired,
        `the control did not fire for "${name}" — this suite proves nothing`,
      ).not.toBeNull();
    });
  }
});

describe("renderMarkdown — payload corpus", () => {
  for (const { name, payload } of XSS_PAYLOADS) {
    it(`neutralises: ${name}`, () => {
      const html = renderMarkdown(payload);
      const { fired, host } = renderAndFire(html);
      host.remove();
      expect(fired, "script executed").toBeNull();
      expect(() => assertNoExecutableMarkup(html)).not.toThrow();
    });
  }

  it("neutralises every payload at once (whole poisoned document echoed)", () => {
    const html = renderMarkdown(ALL_PAYLOADS_COMBINED);
    const { fired, host } = renderAndFire(html);
    host.remove();
    expect(fired).toBeNull();
    expect(() => assertNoExecutableMarkup(html)).not.toThrow();
  });
});

describe("sanitizeModelText — the persist seam", () => {
  for (const { name, payload } of XSS_PAYLOADS) {
    it(`strips markup at rest: ${name}`, () => {
      const stored = sanitizeModelText(payload);
      // Nothing stored may parse into an element at all — this value is written to the database
      // and later distributed to other users by the cache and the clone.
      const host = document.createElement("div");
      host.innerHTML = stored;
      expect(host.querySelector("*"), `an element survived storage for "${name}"`).toBeNull();

      // ...and rendering the stored value must still be inert.
      const { fired, host: rendered } = renderAndFire(renderMarkdown(stored));
      rendered.remove();
      expect(fired).toBeNull();
    });
  }

  it("keeps markdown formatting, which is not HTML", () => {
    const stored = sanitizeModelText("## Heading\n\n- **bold** point\n- second");
    expect(stored).toContain("## Heading");
    expect(stored).toContain("**bold**");
    expect(renderMarkdown(stored)).toMatch(/<strong>bold<\/strong>/);
  });

  it("keeps the payload readable as literal text rather than blanking it", () => {
    const stored = sanitizeModelText("Real content <img src=x onerror=\"boom()\"> more");
    expect(stored).toContain("Real content");
    expect(stored).toContain("more");
  });
});

/**
 * Streaming re-renders on every chunk, so the sanitiser sees TRUNCATED markdown that the
 * buffered tests never produce. A payload split mid-attribute is the specific risk: the prefix
 * can parse into something the sanitiser judges harmless, and the suffix completes it on the
 * next tick. Every intermediate state must be safe, not just the final one.
 */
describe("renderMarkdown — streaming, chunk boundaries", () => {
  const splitPoints = (s: string) => Array.from({ length: s.length }, (_, i) => i + 1);

  it("is safe at every prefix of an img-onerror payload", () => {
    const payload = "Notes\n\n<img src=x onerror=\"document.title='EDGIFY-XSS:split'\">\n\ntail";
    for (const cut of splitPoints(payload)) {
      resetXssSentinel();
      const html = renderMarkdown(payload.slice(0, cut));
      const { fired, host } = renderAndFire(html);
      host.remove();
      expect(fired, `executed at prefix length ${cut}`).toBeNull();
      expect(
        () => assertNoExecutableMarkup(html),
        `executable markup at prefix length ${cut}`,
      ).not.toThrow();
    }
  });

  it("is safe at every prefix of a script payload", () => {
    const payload = "# Key points\n\n<script>document.title='EDGIFY-XSS:split'</script>\n\n- a point";
    for (const cut of splitPoints(payload)) {
      resetXssSentinel();
      const html = renderMarkdown(payload.slice(0, cut));
      const { fired, host } = renderAndFire(html);
      host.remove();
      expect(fired, `executed at prefix length ${cut}`).toBeNull();
      expect(
        () => assertNoExecutableMarkup(html),
        `executable markup at prefix length ${cut}`,
      ).not.toThrow();
    }
  });

  it("is safe when accumulating chunk by chunk, as the component does", () => {
    // Deliberately split mid-attribute-name: "on" + "error=..." reassembles into a handler.
    const chunks = [
      "Intro\n\n<img src=x ",
      "on",
      "error=",
      "\"document.title='EDGIFY-XSS:chunked'\"",
      ">",
    ];
    let accumulated = "";
    for (const chunk of chunks) {
      accumulated += chunk;
      resetXssSentinel();
      const html = renderMarkdown(accumulated);
      const { fired, host } = renderAndFire(html);
      host.remove();
      expect(fired, `executed after chunk "${chunk}"`).toBeNull();
      expect(() => assertNoExecutableMarkup(html)).not.toThrow();
    }
  });
});

describe("renderMarkdown — formatting is preserved", () => {
  it("keeps headings, bold and lists", () => {
    const html = renderMarkdown("# Title\n\n- **key** point\n- second");
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toMatch(/<strong>key<\/strong>/);
    expect(html).toMatch(/<li>/);
  });

  it("keeps GFM tables (the prototype enables gfm)", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toMatch(/<table>/);
    expect(html).toMatch(/<th>a<\/th>/);
  });

  it("keeps benign text from a payload rather than blanking the output", () => {
    // Stripping the attack must not cost the user their notes.
    const html = renderMarkdown("- A real point\n\n<img src=x onerror=\"boom()\">");
    expect(html).toContain("A real point");
  });

  it("keeps a safe link but drops a javascript: one", () => {
    expect(renderMarkdown("[docs](https://example.com)")).toContain('href="https://example.com"');
    const dangerous = renderMarkdown("[click](javascript:boom())");
    expect(dangerous).not.toContain("javascript:");
  });
});

describe("cross-environment equality", () => {
  it("produces byte-identical HTML to the node (no-DOM) run", () => {
    // The same assertion runs without a `document` in lib/sanitize-ssr.test.ts.
    expect(renderMarkdown(CROSS_ENV_INPUT)).toBe(CROSS_ENV_OUTPUT);
  });
});

describe("the sentinel itself", () => {
  it("reads clean after a reset", () => {
    resetXssSentinel();
    expect(xssFired()).toBeNull();
  });
});
