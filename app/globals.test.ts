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

/**
 * "Dark landing tokens do not affect workspace styling" (docs/06 Phase 6).
 *
 * The landing page redefines six tokens the light workspace also uses — body, muted, muted-soft,
 * accent, success — at dark values. If any of those declarations escapes `#landing`, the whole
 * signed-in workspace changes colour, and it does so on a page nobody looking at the landing page
 * would think to check. That is why this is asserted structurally rather than left to a
 * convention: the failure is silent, remote from its cause, and a single character away
 * (`:root` where `#landing` was meant).
 */

type Rule = { selector: string; body: string; at: number };

/** Brace-aware rule collection. Recurses into @media/@supports so nested rules are checked too. */
function collectRules(src: string, offset = 0, into: Rule[] = []): Rule[] {
  let i = 0;
  let selStart = 0;
  while (i < src.length) {
    if (src[i] === "{") {
      const selector = src.slice(selStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth += 1;
        else if (src[j] === "}") depth -= 1;
        j += 1;
      }
      const body = src.slice(i + 1, j - 1);
      if (selector.startsWith("@")) {
        // Conditional groups contain real rules; @keyframes contains percentage steps, not rules.
        if (/^@(media|supports|layer|container)\b/.test(selector)) {
          collectRules(body, offset + i + 1, into);
        }
      } else if (selector.length > 0) {
        into.push({ selector, body, at: offset + selStart });
      }
      selStart = j;
      i = j;
      continue;
    }
    i += 1;
  }
  return into;
}

/** The dark values from the prototype's `#landing` token block. */
const DARK_TOKEN_VALUES = ["#a3a3a3", "#737373", "#d4d4d4", "#60a5fa", "#93c5fd", "#34d399"];
/** Class families that belong to the landing page and must never style the workspace. */
const LANDING_CLASS = /\.lx-|\.gborder\b|\.col-\d|\.row-2\b/;

const isScoped = (selector: string) =>
  selector.split(",").every((part) => part.trim().startsWith("#landing"));

/**
 * Blank out comments, preserving newlines so reported line numbers stay true.
 *
 * Not optional: `collectRules` takes the text before a `{` as the selector, so on raw source a
 * rule preceded by a comment comes back with the whole comment glued to its selector. Every
 * caller must strip first — one that did not was the reason the `:root` assertion below failed
 * on its first run while the file was perfectly correct.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

function landingLeaks(source: string): string[] {
  const stripped = stripComments(source);
  const problems: string[] = [];

  for (const rule of collectRules(stripped)) {
    const lineNo = lineOf(rule.at);

    if (LANDING_CLASS.test(rule.selector) && !isScoped(rule.selector)) {
      problems.push(
        `line ${lineNo}: \`${rule.selector}\` is a landing-page selector that is not scoped to ` +
          `#landing, so it applies inside the workspace too.`,
      );
    }

    // A dark token VALUE declared anywhere but #landing repaints the light workspace.
    for (const value of DARK_TOKEN_VALUES) {
      if (rule.body.includes(value) && !isScoped(rule.selector)) {
        // Only custom-property declarations matter; the value may legitimately appear elsewhere
        // (the graph's own accent, for instance), so require it to be a token assignment.
        const declaresToken = new RegExp(`--[\\w-]+\\s*:\\s*${value}`).test(rule.body);
        if (declaresToken) {
          problems.push(
            `line ${lineNo}: \`${rule.selector}\` assigns the dark landing value ${value} to a ` +
              `custom property outside #landing — this changes the light workspace.`,
          );
        }
      }
    }
  }
  return problems;
}

describe("the dark landing theme cannot leak into the workspace", () => {
  it("scopes every landing rule and every dark token to #landing", () => {
    const problems = landingLeaks(css);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("actually contains the landing block, so the check above is not scanning nothing", () => {
    // The premise guard. Every assertion in this describe passes trivially against a file with no
    // landing CSS in it at all.
    for (const selector of ["#landing", ".lx-bento", ".lx-hero", ".lx-mode", ".lx-cta", ".lx-foot"]) {
      expect(css, `${selector} is missing from globals.css`).toContain(selector);
    }
    // And the tokens really are declared at their dark values somewhere.
    for (const value of DARK_TOKEN_VALUES) {
      expect(css, `${value} is missing — the landing token block is incomplete`).toContain(value);
    }
  });

  it("keeps the workspace's own light tokens on :root", () => {
    // The other direction: scoping the landing must not have moved the workspace theme.
    const root = collectRules(stripComments(css)).find(
      (r) => r.selector === ":root" && r.body.includes("--muted"),
    );
    expect(root, ":root no longer declares the workspace tokens").toBeTruthy();
    expect(root?.body).toContain("--muted: #6b7280");
  });
});

describe("NEGATIVE CONTROL — the leak scan detects the leaks it was written for", () => {
  it("flags dark tokens declared on :root", () => {
    // One character away from correct, and the failure shows up on a different page entirely.
    const leaked = ":root { --muted: #a3a3a3; --body: #d4d4d4; }\n#landing { color: #fff; }";
    const problems = landingLeaks(leaked);
    expect(problems.length, "a :root dark token was not detected").toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/outside #landing/);
  });

  it("flags an unscoped landing class", () => {
    const leaked = ".lx-card { padding: 24px; }";
    const problems = landingLeaks(leaked);
    expect(problems.length, "an unscoped .lx- rule was not detected").toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/not scoped to #landing/);
  });

  it("flags an unscoped landing class nested inside a media query", () => {
    // The easiest place to forget the prefix, because the surrounding block looks scoped.
    const leaked = "@media (max-width: 900px) {\n  .lx-bento { grid-template-columns: 1fr; }\n}";
    const problems = landingLeaks(leaked);
    expect(problems.length, "the scan did not recurse into @media").toBeGreaterThan(0);
  });

  it("accepts the same rules once they are scoped", () => {
    const fixed = [
      "#landing { --muted: #a3a3a3; --body: #d4d4d4; }",
      "#landing .lx-card { padding: 24px; }",
      "@media (max-width: 900px) { #landing .lx-bento { grid-template-columns: 1fr; } }",
    ].join("\n");
    expect(landingLeaks(fixed)).toEqual([]);
  });
});
