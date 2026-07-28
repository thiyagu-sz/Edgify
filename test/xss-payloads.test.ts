// @vitest-environment jsdom
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { XSS_PAYLOADS, assertNoExecutableMarkup } from "./xss-payloads";

/**
 * NEGATIVE CONTROL for the sanitisation proofs.
 *
 * `lib/sanitize.test.ts` asserts that nothing executable survives. That assertion is only worth
 * anything if it is capable of failing — a checker with a typo'd regex passes every payload and
 * silently certifies a vulnerable renderer. So this file renders the same corpus through the
 * VULNERABLE implementation (marked with no DOMPurify) and requires the checker to fire.
 *
 * If a payload is added to the corpus that this file cannot detect, that is a signal the checker
 * needs extending — not a reason to drop the payload.
 */

/**
 * `<body onload>` is not detectable here, and the reason is jsdom's parser rather than a hole in
 * the checker: assigning to `div.innerHTML` discards `<body>` entirely, because body cannot nest
 * inside a div. The payload never materialises, so there is nothing to catch. Real browsers do
 * the same thing in this position — it is covered by the Playwright pass, which renders through
 * the actual component instead of a detached div.
 */
const NOT_DETECTABLE_IN_JSDOM = new Set(["body onload"]);

describe("negative control — the checker can actually fail", () => {
  for (const { name, payload } of XSS_PAYLOADS) {
    const detectable = !NOT_DETECTABLE_IN_JSDOM.has(name);

    it(`${detectable ? "detects" : "documents jsdom blind spot for"}: ${name}`, () => {
      const vulnerableHtml = marked.parse(payload, { async: false });

      if (detectable) {
        expect(
          () => assertNoExecutableMarkup(vulnerableHtml),
          "checker did NOT fire on unsanitised output — the positive test is vacuous for this payload",
        ).toThrow();
      } else {
        // Assert the stated reason, so this stays honest if jsdom's behaviour ever changes.
        const host = document.createElement("div");
        host.innerHTML = vulnerableHtml;
        expect(host.querySelector("body")).toBeNull();
      }
    });
  }

  it("covers every payload in the corpus", () => {
    expect(XSS_PAYLOADS.length).toBeGreaterThanOrEqual(14);
  });
});
