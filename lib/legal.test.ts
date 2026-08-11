import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COOKIES, CONTACT_URL, GOVERNING_LAW, LEGAL_ENTITY, LEGAL_PAGES, REPO_URL, SUBPROCESSORS } from "./legal";

/**
 * The legal pages, guarded against the two ways they can go wrong.
 *
 * ONE: an unresolved placeholder reaches production. "[JURISDICTION]" or "TODO" on a privacy
 * policy destroys the credibility of every other sentence on the page, and it is the single most
 * likely defect for generated legal copy.
 *
 * TWO: a claim the implementation does not support. A privacy policy is a set of promises about a
 * running system; a promise the code does not keep is a false statement to users. The assertions
 * below pin the specific claims this project decided it could NOT make — no retention period, no
 * deletion guarantee, no compliance certification, no statement about model training.
 */

const ROOT = process.cwd();
const LEGAL_DIR = join(ROOT, "app", "(legal)");

/**
 * Every legal page's source, so the prose itself can be asserted on.
 *
 * `src` is whitespace-NORMALISED. JSX wraps a sentence across source lines with indentation in
 * between, so a phrase a reader sees as continuous ("the IP address and browser user-agent") is
 * split by a newline and eight spaces in the file. Matching the raw text silently fails to find
 * prose that is plainly there — which is a test that reports a problem that does not exist, and
 * worse, would pass if the sentence were later deleted.
 */
function legalSources(): Array<{ file: string; src: string }> {
  const normalise = (s: string) => s.replace(/\s+/g, " ");
  const out: Array<{ file: string; src: string }> = [];
  for (const entry of readdirSync(LEGAL_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(LEGAL_DIR, entry.name, "page.tsx");
    out.push({
      file: `app/(legal)/${entry.name}/page.tsx`,
      src: normalise(readFileSync(file, "utf8")),
    });
  }
  out.push({
    file: "components/legal/legal-page.tsx",
    src: normalise(readFileSync(join(ROOT, "components", "legal", "legal-page.tsx"), "utf8")),
  });
  return out;
}

describe("the pages exist at all", () => {
  it("finds one page per declared legal route", () => {
    // Premise guard: an empty scan would make every assertion below pass vacuously.
    const sources = legalSources();
    expect(sources.length).toBe(LEGAL_PAGES.length + 1);
  });
});

describe("NO UNRESOLVED PLACEHOLDERS", () => {
  const PLACEHOLDERS = [
    /\[LEGAL ENTITY NAME\]/i,
    /\[COMPANY[ _]?NAME\]/i,
    /\[CONTACT[ _]?EMAIL\]/i,
    /\[ADDRESS\]/i,
    /\[JURISDICTION\]/i,
    /\[DOMAIN\]/i,
    /\[INSERT[^\]]*\]/i,
    /\bTODO\b/,
    /\bFIXME\b/,
    /\bXXX\b/,
    /lorem ipsum/i,
    /YOUR_COMPANY/i,
  ];

  it.each(PLACEHOLDERS.map((p) => [String(p), p] as const))(
    "no legal page contains %s",
    (_label, pattern) => {
      const hits = legalSources()
        .filter(({ src }) => pattern.test(src))
        .map(({ file }) => file);
      expect(hits, `placeholder ${pattern} is visible to users in: ${hits.join(", ")}`).toEqual([]);
    },
  );

  it("NEGATIVE CONTROL — the scanner would catch a real placeholder", () => {
    expect(PLACEHOLDERS.some((p) => p.test("governed by the laws of [JURISDICTION]"))).toBe(true);
    expect(PLACEHOLDERS.some((p) => p.test("contact us at [CONTACT EMAIL]"))).toBe(true);
  });
});

describe("claims the implementation cannot support are NOT made", () => {
  /** Each pattern is a statement this repository has no evidence for. */
  const FORBIDDEN_CLAIMS: Array<[RegExp, string]> = [
    [/\bGDPR[- ]compliant\b/i, "no compliance assessment exists"],
    [/\bCCPA[- ]compliant\b/i, "no compliance assessment exists"],
    [/\bSOC ?2\b/i, "no certification exists"],
    [/\bISO ?27001\b/i, "no certification exists"],
    [/\bHIPAA\b/i, "no certification exists"],
    [/we (never|do not) (share|sell) your data\b/i, "data IS shared with the processors listed"],
    [
      /(never|not|don't|do not) (use|used) (your |the )?(data|content|material) (to |for )?train/i,
      "nothing in this repo establishes what model providers do with submitted text",
    ],
    [/deleted immediately/i, "no immediate-deletion mechanism exists"],
    [/\b(guarantee|guaranteed) (uptime|availability)\b/i, "no SLA exists"],
    [/\b99\.9\b/i, "no uptime figure is measured or promised"],
    [/lawyer[- ]reviewed|legally compliant/i, "no legal review has taken place"],
    [/\bdata residency\b/i, "the production database region is not established in this repo"],
    [/\bwe are incorporated\b/i, "no incorporation details exist"],
  ];

  it.each(FORBIDDEN_CLAIMS.map(([p, why]) => [String(p), p, why] as const))(
    "does not claim %s",
    (_label, pattern, why) => {
      const hits = legalSources()
        .filter(({ src }) => pattern.test(src))
        .map(({ file }) => file);
      expect(hits, `unsupported claim (${why}) in: ${hits.join(", ")}`).toEqual([]);
    },
  );
});

describe("the facts that ARE stated are sourced", () => {
  it("names no email address anywhere, because the project has none", () => {
    // The exact failure mode this whole module exists to prevent: an invented support address.
    for (const { file, src } of legalSources()) {
      const emails = src.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
      // `@` in prose (e.g. describing the part of an address before the @) is fine; a full
      // address literal is not.
      expect(emails, `${file} contains an email address literal: ${emails.join(", ")}`).toEqual([]);
    }
  });

  it("points contact at the verified public repository", () => {
    expect(CONTACT_URL.startsWith(REPO_URL)).toBe(true);
    expect(REPO_URL).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });

  it("keeps owner-supplied legal facts unset rather than invented", () => {
    // If these are ever filled in, they must be real — this test documents that they are not
    // guessed. It is intentionally not asserting they stay null forever.
    expect(LEGAL_ENTITY === null || typeof LEGAL_ENTITY === "string").toBe(true);
    expect(GOVERNING_LAW === null || typeof GOVERNING_LAW === "string").toBe(true);
  });

  it("renders no governing-law clause while the jurisdiction is unknown", () => {
    const terms = legalSources().find(({ file }) => file.includes("terms"))!.src;
    if (GOVERNING_LAW === null) {
      // The clause must be behind a conditional, never emitted unconditionally.
      expect(terms).toMatch(/GOVERNING_LAW\s*&&/);
    }
  });

  it("lists only processors with recorded evidence", () => {
    expect(SUBPROCESSORS.length).toBeGreaterThan(0);
    for (const s of SUBPROCESSORS) {
      expect(s.evidence.length, `${s.name} has no evidence recorded`).toBeGreaterThan(10);
    }
  });

  it("names only cookies taken from the libraries in use", () => {
    const names = COOKIES.map((c) => c.name);
    expect(names).toContain("better-auth.session_token");
    // No invented analytics vendor.
    expect(names.join(" ")).not.toMatch(/_ga|_gid|_fbp|fr\b/);
  });
});

describe("the documents disclose the awkward truths", () => {
  const privacy = () => legalSources().find(({ file }) => file.includes("privacy"))!.src;

  it("discloses that the generation cache is shared rather than per-user", () => {
    // A real, non-obvious property of the system (lib/db/schema.ts generationCache is not
    // user-scoped). Omitting it would make the isolation section misleading.
    expect(privacy()).toMatch(/not partitioned per user|shared/i);
  });

  it("discloses that submitted text leaves Edgify for a third-party model provider", () => {
    expect(privacy()).toMatch(/OpenRouter/);
  });

  it("states plainly that there is no self-service deletion today", () => {
    expect(privacy()).toMatch(/no self-service control/i);
  });

  it("states plainly that no retention schedule exists", () => {
    expect(privacy()).toMatch(/does not currently operate a defined retention schedule/i);
  });

  it("discloses that sessions record IP address and user agent", () => {
    expect(privacy()).toMatch(/IP address and browser user-agent/i);
  });
});
