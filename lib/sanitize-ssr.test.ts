import { describe, expect, it } from "vitest";
import { XSS_PAYLOADS, assertFullyEscaped } from "@/test/xss-payloads";
import { renderMarkdown } from "./sanitize";

/**
 * Node environment ON PURPOSE — no `document`, so DOMPurify cannot sanitise anything.
 *
 * `renderMarkdown` returns a string destined for `dangerouslySetInnerHTML`, so "there was no DOM
 * to sanitise with" must never mean "return the HTML unsanitised". Today the only caller is a
 * client component that renders after a fetch resolves, so SSR never reaches this path — but
 * that is a property of the current render order, not a guarantee, and a future server-rendered
 * preview would silently turn this into the exact bug `.claude/rules/ui.md` calls the
 * highest-severity one in the project.
 */
describe("renderMarkdown — fails closed without a DOM", () => {
  it("has no DOM in this environment (guards the premise of these tests)", () => {
    expect(typeof document).toBe("undefined");
  });

  for (const { name, payload } of XSS_PAYLOADS) {
    it(`emits inert markup for: ${name}`, () => {
      const html = renderMarkdown(payload);
      expect(() => assertFullyEscaped(html)).not.toThrow();
    });
  }

  it("escapes rather than drops, so the text is still readable", () => {
    const html = renderMarkdown("# Title\n\n- a real point");
    expect(html).toContain("a real point");
    expect(html).toContain("# Title");
  });
});
