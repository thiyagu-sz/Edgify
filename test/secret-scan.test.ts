import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pre-commit secret scan (AGENTS.md rule 1) is a security control, so it is tested like one.
 *
 * Three failures this file exists to prevent, all of which have actually happened here:
 *
 *  1. **Matching nothing.** `postgres://` is not a substring of `postgresql://`, so the original
 *     pattern was blind to the exact URL shape this project uses — Neon issues `postgresql://`,
 *     `.env.local` uses it, and `lib/env.ts` accepts both. A real leaked Neon credential would
 *     have passed every scan run against it.
 *  2. **Matching everything.** A verification run whose pattern extraction silently failed
 *     produced an empty regex, which matches every line. It reported a confident all-clear that
 *     meant nothing. An empty or unextractable pattern must be a hard failure, never a pass.
 *  3. **Matching noise.** Firing on the bare `sk-or-v1` prefix hit every doc showing the key
 *     format, and an alert that is always noise is one people learn to wave through.
 *
 * The pattern is READ OUT OF AGENTS.md rather than duplicated here. Copying it would let the two
 * drift, and the doc is what a human actually runs — so the doc is the source of truth and this
 * test asserts the doc's own command is correct.
 */

const AGENTS_MD = join(process.cwd(), "AGENTS.md");

/** Pull the live pattern out of the documented command. */
function extractPattern(): string {
  const source = readFileSync(AGENTS_MD, "utf8");
  const match = source.match(/^git diff --cached \| grep -iE "(.+)"\s*$/m);
  return match?.[1] ?? "";
}

const pattern = extractPattern();

describe("secret scan: the pattern is extractable and non-empty", () => {
  /**
   * The guard. An empty pattern matches every line, so a scan built on one reports a confident
   * all-clear while checking nothing. This must abort loudly rather than pass quietly.
   */
  it("fails loudly rather than yielding an empty pattern", () => {
    expect(
      pattern,
      "Could not extract the grep pattern from AGENTS.md. An empty pattern matches EVERY line, " +
        "so a scan using it silently checks nothing. Fix the extraction or the command's shape — " +
        "do not let this test be skipped.",
    ).not.toBe("");
    expect(pattern.length).toBeGreaterThan(20);
  });

  it("compiles as a regular expression", () => {
    expect(() => new RegExp(pattern, "i")).not.toThrow();
  });
});

const scan = (line: string) => new RegExp(pattern, "i").test(line);

/**
 * Both directions, asserted separately. "The scan runs clean" proves nothing on its own — a
 * pattern that matches nothing runs clean forever. Every credential shape gets its own case so a
 * regression names which one broke.
 */
/**
 * These fixtures are deliberately SHAPED like credentials, so this file trips the very scan it
 * tests — a standing, documented baseline (see AGENTS.md). Every value is therefore written to be
 * unmistakably synthetic on sight: `EXAMPLE_*` bodies and RFC 2606 `.invalid` hosts, which can
 * never resolve. Someone inspecting a scan hit here should be able to dismiss it in one glance
 * without having to reason about whether a plausible-looking string is live.
 *
 * They are NOT obfuscated (no string concatenation to dodge the matcher): a real key pasted into
 * this file must still be caught, and hiding fixtures from the scanner would defeat that.
 */
describe("secret scan: catches real credentials", () => {
  it.each([
    [
      "openrouter key body",
      "OPENROUTER_API_KEY=sk-or-v1-EXAMPLE0000000000000000000000000000",
    ],
    [
      "postgres:// credentials",
      "DATABASE_URL=postgres://EXAMPLE_USER:EXAMPLE_PASSWORD@db.example.invalid/neondb",
    ],
    [
      "postgresql:// credentials (the form Neon actually issues)",
      "DATABASE_URL=postgresql://EXAMPLE_USER:EXAMPLE_PASSWORD@db.example.invalid/neondb",
    ],
    ["sentry dsn", "SENTRY_DSN=https://EXAMPLEKEY@o0.ingest.example.invalid/0"],
    [
      "google client secret",
      `client_secret: "EXAMPLE_CLIENT_SECRET_VALUE"`,
    ],
  ])("catches %s", (_label, line) => {
    expect(scan(line), `a real credential slipped through: ${line}`).toBe(true);
  });
});

describe("secret scan: ignores documentation placeholders", () => {
  it.each([
    [
      "the docs/07 key-format illustration",
      "| `OPENROUTER_API_KEY` | `sk-or-v1-<your-key-here>` | **Server only.** |",
    ],
    ["a short key stub", "sk-or-v1-xxxx"],
    ["an empty assignment", `OPENROUTER_API_KEY=""`],
    ["a bare identifier mention", "Set OPENROUTER_API_KEY in Secret Manager, never inline."],
  ])("ignores %s", (_label, line) => {
    expect(
      scan(line),
      `false positive — an alert that is always noise gets waved through: ${line}`,
    ).toBe(false);
  });
});

/**
 * The one accepted standing hit. `.env.example` legitimately ships a connection-string SHAPE, and
 * separating that from a real credential by regex would mean trusting the literal string "user" —
 * a bypass waiting to happen. So it is documented as the baseline instead of suppressed, and this
 * pins that decision: if the count of expected hits ever changes, someone has to think about it.
 */
describe("secret scan: the documented baseline", () => {
  it("still flags the .env.example placeholder, deliberately", () => {
    const line = `DATABASE_URL="postgresql://user:password@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require"`;
    expect(scan(line)).toBe(true);
  });

  it("AGENTS.md documents that baseline, so the hit is not a mystery", () => {
    const source = readFileSync(AGENTS_MD, "utf8");
    expect(source).toMatch(/known baseline/i);
    expect(source).toContain(".env.example");
  });
});
