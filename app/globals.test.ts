import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `app/globals.css` is structurally well-formed.
 *
 * Added 2026-08-02 after a real defect reached a build. The ported graph section's heading quoted
 * the prototype's own comment markers verbatim:
 *
 *     KNOWLEDGE GRAPH — ported verbatim from the prototype's `[slash-star] KNOWLEDGE GRAPH [star-slash]` block
 *
 * CSS COMMENTS DO NOT NEST. That inner close sequence ended the comment three lines early, so a
 * stray backtick, a line of English prose and a rule of `=` characters all became live CSS.
 *
 * What makes this worth a test rather than a fix-and-move-on: `npm run build` PASSED with the
 * file in that state, repeatedly. PostCSS recovers from an invalid selector by discarding it and
 * carrying on, so the only symptom was in stricter downstream parsers. A defect that the gate is
 * blind to is exactly the kind that needs its own check — and the risk recurs directly, because
 * Phase 6 ports the landing page from the same prototype, whose CSS is far more heavily
 * commented than the block that broke this time.
 *
 * The scan is deliberately structural rather than a full CSS parse: it models the one rule that
 * was violated, so a failure names the cause instead of reporting a mystery selector.
 */

const CSS_PATH = join(process.cwd(), "app/globals.css");
const css = readFileSync(CSS_PATH, "utf8");

const lineOf = (index: number): number => css.slice(0, index).split("\n").length;

type Scan = {
  opens: number;
  closes: number;
  unterminatedAt: number | null;
  problems: string[];
  /** Indices of backticks that are NOT inside a comment. */
  looseBackticks: number[];
};

function scan(source: string): Scan {
  const problems: string[] = [];
  const looseBackticks: number[] = [];
  let i = 0;
  let inComment = false;
  let openedAt = 0;
  let opens = 0;
  let closes = 0;

  while (i < source.length) {
    if (!inComment && source.startsWith("/*", i)) {
      inComment = true;
      openedAt = i;
      opens += 1;
      i += 2;
      continue;
    }
    if (inComment && source.startsWith("*/", i)) {
      inComment = false;
      closes += 1;
      i += 2;
      continue;
    }
    if (inComment && source.startsWith("/*", i)) {
      problems.push(
        `line ${lineOf(i)}: a comment opener appears inside the comment opened at line ` +
          `${lineOf(openedAt)}. CSS comments do not nest — the first close sequence ends the ` +
          `block, and everything after it becomes live CSS.`,
      );
      i += 2;
      continue;
    }
    if (!inComment && source.startsWith("*/", i)) {
      problems.push(
        `line ${lineOf(i)}: a stray comment close with no matching opener. Usually the tail of a ` +
          `comment that was terminated early by a nested close sequence.`,
      );
      i += 2;
      continue;
    }
    if (!inComment && source[i] === "`") looseBackticks.push(i);
    i += 1;
  }

  return {
    opens,
    closes,
    unterminatedAt: inComment ? openedAt : null,
    problems,
    looseBackticks,
  };
}

describe("app/globals.css is structurally well-formed", () => {
  const result = scan(css);

  it("has a matching close for every comment opener", () => {
    expect(result.opens).toBe(result.closes);
    expect(
      result.unterminatedAt === null,
      result.unterminatedAt === null
        ? ""
        : `comment opened at line ${lineOf(result.unterminatedAt)} is never closed`,
    ).toBe(true);
  });

  it("contains no nested comment openers and no stray closers", () => {
    expect(result.problems, result.problems.join("\n")).toEqual([]);
  });

  it("has no backtick outside a comment", () => {
    // CSS has no syntax that uses one, so a loose backtick is always a mangled comment or a
    // copy-paste artefact — and it is the most visible symptom of the nesting bug above.
    expect(
      result.looseBackticks.map(lineOf),
      "backticks outside a comment (CSS has no use for one)",
    ).toEqual([]);
  });

  it("still contains the graph rules the workspace depends on", () => {
    // Guards the premise: a scan of an empty or truncated file would pass every check above.
    for (const selector of [".gbar", ".panel", ".node-g", ".concept-grid", ".plan-hero", ".flash"]) {
      expect(css, `${selector} is missing from globals.css`).toContain(selector);
    }
    expect(css).toContain("overscroll-behavior: contain");
  });
});

describe("NEGATIVE CONTROL — the scan detects the defect it was written for", () => {
  it("flags a comment whose heading quotes another comment's markers", () => {
    // The exact shape that broke the build, reconstructed rather than described.
    const broken = [
      "/* ====",
      "   KNOWLEDGE GRAPH — ported from the prototype's `/* KNOWLEDGE GRAPH */` block",
      "   (docs/reference/edgify-prototype.html). Same selectors, same values.",
      "   ==== */",
      ".gbar { display: flex; }",
    ].join("\n");

    const result = scan(broken);
    expect(result.problems.length, "the scan did not detect the nested close").toBeGreaterThan(0);
    expect(result.problems.join("\n")).toMatch(/stray comment close/);
    expect(result.looseBackticks.length, "the loose backtick was not detected").toBeGreaterThan(0);
  });

  it("accepts the same heading once the inner markers are removed", () => {
    const fixed = [
      "/* ====",
      "   KNOWLEDGE GRAPH — ported from the prototype's KNOWLEDGE GRAPH section",
      "   (docs/reference/edgify-prototype.html). Same selectors, same values.",
      "   ==== */",
      ".gbar { display: flex; }",
    ].join("\n");

    const result = scan(fixed);
    expect(result.problems).toEqual([]);
    expect(result.looseBackticks).toEqual([]);
  });
});
