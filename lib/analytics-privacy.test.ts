import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NO ANALYTICS EVENT MAY CARRY USER CONTENT.
 *
 * Edgify handles uploaded PDFs, pasted lecture notes, extracted document text, model output and
 * model-generated concept names. Every one is private user material, and every one is in scope at
 * exactly the call sites where an event is most natural to fire — `generate()` has the document
 * text in a local, `onFilePicked` has the File, the graph poller has the document title.
 *
 * The type system already blocks the obvious version of this (lib/analytics.ts declares a closed
 * union whose properties are all bounded primitives), but a type cannot stop
 * `reason: body.message` — a `string` that happens to be prose about the user's file. So this
 * test reads the SOURCE of every call site and fails on the identifiers known to hold content.
 *
 * Deliberately source-scanning rather than behavioural, and deliberately in the unit project: it
 * imports nothing, so it cannot be defeated by a mock, and it catches the leak in review rather
 * than in production where the data has already left the building. Same reasoning as
 * test/secret-scan.test.ts, one directory over.
 */

const ROOT = process.cwd();

/**
 * Identifiers that hold user content or model output in this codebase. Each is a real local from
 * a file that calls `track()`.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfile\.name\b/, "the uploaded file's NAME — routinely carries a person's or client's name"],
  [/\bbody\.message\b/, "user-facing prose that can describe the user's material"],
  [/\bbody\.title\b/, "the uploaded document's title"],
  [/\bdocText\b/, "extracted document text"],
  [/\bcurrentMarkdown\(\)/, "the generated notes themselves"],
  [/\bconcept\.name\b/, "a model-generated concept name, derived from the user's document"],
  [/\bslug\b/, "the concept slug is model output (lib/ai/schemas.ts)"],
  [/\bout\.md\b/, "generated markdown"],
  [/\bsource\.trim\(\)/, "the source material"],
  [/\bparsed\.data\.password\b/, "a password"],
  /**
   * An email VALUE, not the literal string `"email"`.
   *
   * The quote lookarounds matter: `props: { method: "email" }` is the auth-method vocabulary and
   * is entirely safe, while `email`, `user.email` or `parsed.data.email` is personal data. A bare
   * `\bemail\b` flags the first as a violation — it did, on the first run of this test — and a
   * rule that cries wolf on correct code is one people delete.
   */
  [/(?<!["'])\bemail\b(?!["'])/, "an email address — identify with the user id instead"],
];

/**
 * Every `.ts`/`.tsx` file under the source directories.
 *
 * A hand-rolled walk rather than `fs.promises.glob`: that lands in Node 22 and this repo pins
 * `@types/node` at v20, so it does not typecheck even though it would run.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      sourceFiles(rel, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(rel);
    }
  }
  return acc;
}

/** Every `track({ ... })` / `track("...")` invocation in the repo, with its full argument text. */
function trackCallSites(): Array<{ file: string; call: string }> {
  const out: Array<{ file: string; call: string }> = [];

  for (const rel of [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib")]) {
    // The definition itself names these identifiers in prose; it is not a call site.
    if (rel.endsWith("lib/analytics.ts")) continue;
    if (rel.includes("analytics-privacy.test")) continue;

    const src = readFileSync(join(ROOT, rel), "utf8");
    // Balanced-enough capture: from `track(` to the end of that statement.
    for (const m of src.matchAll(/\btrack\(([\s\S]{0,400}?)\);/g)) {
      out.push({ file: rel, call: m[1] });
    }
  }
  return out;
}

describe("analytics call sites carry no user content", () => {
  it("finds the call sites at all", () => {
    // Premise guard: if this regex ever stops matching, every assertion below passes vacuously
    // while checking nothing — the "empty pattern reports a confident all-clear" failure mode.
    const sites = trackCallSites();
    expect(sites.length, "no track() call sites found — the scanner is broken").toBeGreaterThan(10);
  });

  it("passes no identifier that holds document text, a file name or model output", () => {
    const sites = trackCallSites();
    const violations: string[] = [];

    for (const { file, call } of sites) {
      for (const [pattern, why] of FORBIDDEN) {
        if (pattern.test(call)) {
          violations.push(`${file}: track(${call.trim().slice(0, 80)}…) passes ${why}`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("NEGATIVE CONTROL — the scanner would catch a real leak", () => {
    // Reconstructed rather than described: the exact shape the rule forbids must be detected.
    const leak = `{ name: "document_parse_failed", props: { fileKind, reason: file.name } }`;
    const caught = FORBIDDEN.filter(([pattern]) => pattern.test(leak));
    expect(caught.length).toBeGreaterThan(0);
  });

  it("NEGATIVE CONTROL — the email rule separates a value from the method literal", () => {
    // The distinction the first run of this test got wrong, pinned in both directions.
    const emailRule = FORBIDDEN.find(([, why]) => why.includes("email address"))![0];
    expect(emailRule.test(`props: { method: "email" }`), "flags the safe method literal").toBe(false);
    expect(emailRule.test(`props: { who: parsed.data.email }`), "misses a real address").toBe(true);
  });
});

describe("the analytics module itself", () => {
  const src = readFileSync(join(ROOT, "lib", "analytics.ts"), "utf8");

  it("disables autocapture, which would record clicked element text", () => {
    // Autocapture records the text of clicked elements — in this app, concept nodes, generated
    // notes and quiz options. This one flag is the difference between analytics and exfiltration.
    expect(src).toMatch(/autocapture:\s*false/);
  });

  it("disables session replay, which would record the workspace verbatim", () => {
    expect(src).toMatch(/disable_session_recording:\s*true/);
  });

  it("identifies people by an opaque id, never by email", () => {
    expect(src).toMatch(/posthog\.identify\(userId\)/);
    expect(src).not.toMatch(/posthog\.identify\([^)]*email/i);
  });

  it("is inert unless a key is configured", () => {
    // Every exported entry point must be guarded, or analytics fires against a null instance.
    expect(src).toMatch(/if\s*\(!analyticsEnabled\(\)\)\s*return/);
  });
});
