import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Retry discipline belongs to the LADDER, not the SDK (docs/04 §1, `.claude/rules/ai.md`:
 * "Maximum 2 retries per model tier", "Always jittered").
 *
 * The AI SDK's `generateObject` / `generateText` / `streamText` default to `maxRetries: 2`, so
 * every call is silently up to 3 HTTP requests unless it is turned off. `realRunStream` set it
 * from the start; `realRunModel` did NOT, and the gap survived Phase 3 and Phase 4 unnoticed
 * because nothing counted provider requests — only ladder attempts.
 *
 * The cost compounds rather than adds: the ladder makes up to 7 attempts (free 3 + fallback 2 +
 * paid 2), each of which can repair once, so ~14 calls became ~42 provider requests. Failed
 * requests count against the free daily quota, the extra attempts bypassed our jittered backoff,
 * and worst-case latency tripled against a hard Cloud Run request timeout — which is what made it
 * visible, during the Phase 5 end-to-end timing run (docs/06).
 *
 * This is a SOURCE-level guard on purpose. Asserting it behaviourally would mean intercepting the
 * provider's HTTP layer to count requests, and the thing worth protecting is simply that the
 * option is present on every real model entry point.
 */

const source = readFileSync(join(process.cwd(), "lib", "ai", "models.ts"), "utf8");

/** Every AI SDK generation call in the module — each one needs the option. */
const SDK_CALLS = ["generateObject(", "generateText(", "streamText("] as const;

describe("retry discipline: the SDK never retries underneath the ladder", () => {
  it.each(SDK_CALLS)("%s passes maxRetries: 0", (call) => {
    const start = source.indexOf(call);
    expect(start, `${call} not found in lib/ai/models.ts`).toBeGreaterThan(-1);

    // The call's argument object, up to its closing `});`.
    const end = source.indexOf("});", start);
    const args = source.slice(start, end);

    expect(
      /maxRetries:\s*0/.test(args),
      `${call} does not pass maxRetries: 0 — the SDK will add its own retries beneath the ladder, ` +
        `inflating provider requests, burning free-tier quota, and tripling worst-case latency`,
    ).toBe(true);
  });

  it("no SDK call sets a non-zero maxRetries", () => {
    const nonZero = source.match(/maxRetries:\s*(?!0\b)\w+/g);
    expect(nonZero, `retries must be the ladder's job: ${nonZero?.join(", ")}`).toBeNull();
  });
});
