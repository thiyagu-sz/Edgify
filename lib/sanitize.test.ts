// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./sanitize";

/**
 * The highest-severity UI rule (.claude/rules/ui.md): model output is sanitised before it ever
 * reaches dangerouslySetInnerHTML. Model output can be steered by text inside an uploaded
 * document, so these payloads stand in for "a classmate uploads a poisoned PDF, the model echoes
 * it". renderMarkdown must strip every executable vector while keeping the formatting.
 */

describe("renderMarkdown — sanitises model output", () => {
  it("strips <script> tags", () => {
    const html = renderMarkdown("Intro\n\n<script>window.__xss = 1</script>\n\nmore");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("window.__xss");
  });

  it("strips inline event handlers (img onerror, svg onload)", () => {
    const html = renderMarkdown(
      'Intro\n\n<img src=x onerror="window.__xss=1">\n\n<svg onload="window.__xss=1"></svg>',
    );
    // The tags may survive, but the executable handlers must not.
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/onload/i);
    expect(html).not.toContain("window.__xss");
  });

  it("neutralises javascript: URLs in links", () => {
    const html = renderMarkdown("[click me](javascript:window.__xss=1)");
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
  });

  it("does not execute injected script when inserted into the DOM", () => {
    const w = window as unknown as { __xss?: number };
    delete w.__xss;
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown('<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>');
    document.body.appendChild(host);
    expect(w.__xss).toBeUndefined();
    host.remove();
  });

  it("keeps benign formatting (headings, bold, lists)", () => {
    const html = renderMarkdown("# Title\n\n- **key** point\n- second");
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toMatch(/<strong>key<\/strong>/);
    expect(html).toMatch(/<li>/);
  });
});
