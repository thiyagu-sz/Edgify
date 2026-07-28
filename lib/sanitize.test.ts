// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ALL_PAYLOADS_COMBINED,
  XSS_PAYLOADS,
  assertNoExecutableMarkup,
} from "@/test/xss-payloads";
import { renderMarkdown } from "./sanitize";

/**
 * The highest-severity UI rule (.claude/rules/ui.md): model output is sanitised before it ever
 * reaches dangerouslySetInnerHTML. Model output can be steered by text inside an uploaded
 * document, so these payloads stand in for "a classmate uploads a poisoned PDF, the model echoes
 * it". renderMarkdown must strip every executable vector while keeping the formatting.
 *
 * The assertion that counts is the `window.__xss` sentinel after real DOM insertion. String
 * matching alone would only prove that one spelling was stripped.
 *
 * jsdom's HTML parser is not Chrome's, so the mutation-XSS payloads here are necessary but not
 * sufficient — they are re-run against a real browser in the Playwright pass.
 */

/** Insert into a live document the way the component does, then report the sentinel. */
function renderIntoDom(md: string): { html: string; fired: unknown } {
  const html = renderMarkdown(md);
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  const fired = window.__xss;
  host.remove();
  return { html, fired };
}

describe("renderMarkdown — payload corpus", () => {
  for (const { name, payload } of XSS_PAYLOADS) {
    it(`neutralises: ${name}`, () => {
      const { html, fired } = renderIntoDom(payload);
      expect(fired, "script executed — window.__xss was set").toBeUndefined();
      expect(() => assertNoExecutableMarkup(html)).not.toThrow();
    });
  }

  it("neutralises every payload at once (whole poisoned document echoed)", () => {
    const { html, fired } = renderIntoDom(ALL_PAYLOADS_COMBINED);
    expect(fired).toBeUndefined();
    expect(() => assertNoExecutableMarkup(html)).not.toThrow();
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
    const payload = "Notes\n\n<img src=x onerror=\"window.__xss='split'\">\n\ntail";
    for (const cut of splitPoints(payload)) {
      const { html, fired } = renderIntoDom(payload.slice(0, cut));
      expect(fired, `executed at prefix length ${cut}`).toBeUndefined();
      expect(
        () => assertNoExecutableMarkup(html),
        `executable markup at prefix length ${cut}`,
      ).not.toThrow();
    }
  });

  it("is safe at every prefix of a script payload", () => {
    const payload = "# Key points\n\n<script>window.__xss='split'</script>\n\n- a point";
    for (const cut of splitPoints(payload)) {
      const { html, fired } = renderIntoDom(payload.slice(0, cut));
      expect(fired, `executed at prefix length ${cut}`).toBeUndefined();
      expect(
        () => assertNoExecutableMarkup(html),
        `executable markup at prefix length ${cut}`,
      ).not.toThrow();
    }
  });

  it("is safe when accumulating chunk by chunk, as the component does", () => {
    // Deliberately split mid-attribute-name: "on" + "error=..." reassembles into a handler.
    const chunks = ["Intro\n\n<img src=x ", "on", "error=", "\"window.__xss='chunked'\"", ">"];
    let accumulated = "";
    for (const chunk of chunks) {
      accumulated += chunk;
      const { html, fired } = renderIntoDom(accumulated);
      expect(fired, `executed after chunk "${chunk}"`).toBeUndefined();
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
    const html = renderMarkdown("- A real point\n\n<img src=x onerror=\"window.__xss=1\">");
    expect(html).toContain("A real point");
  });
});
