import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envVarNames, requiredEnvVarNames } from "@/lib/env";

/**
 * `docs/07-deployment.md`'s environment table matches `lib/env.ts`.
 *
 * WHY THIS EXISTS. That table is what someone reads while populating Secret Manager on deploy day,
 * so every error in it lands at the worst possible moment — and on 2026-08-05 it had drifted in
 * BOTH directions: three variables listed that exist nowhere in the code
 * (`OPENROUTER_QUALITY_MODEL`, `DAILY_GENERATION_LIMIT`, `MAX_UPLOAD_BYTES`) and five real ones
 * missing.
 *
 * THE ASYMMETRY THAT MAKES THIS WORTH A TEST. A missing REQUIRED variable is loud: `assertEnv()`
 * exits 1 and names it. A misspelled OPTIONAL one is silent by construction — `DAILY_GENERATION_LIMIT`
 * would have been accepted by nothing and ignored by everything, leaving the app on
 * `QUOTA_DAILY_LIMIT`'s default of 30 while the operator believed they had configured a quota.
 * Nothing anywhere would have contradicted them.
 *
 * Truth is DERIVED from the schema at runtime, never listed here. A list in this file would be a
 * third copy that goes stale exactly as the doc did — the same lesson as
 * `test/dockerfile-env.test.ts`, which was written after the Docker image failed to build for the
 * first time it was tried.
 */

const DOC_PATH = join(process.cwd(), "docs", "07-deployment.md");
const DOC = readFileSync(DOC_PATH, "utf8");

/**
 * Everything here is derived from the schema itself — there is deliberately NO sample environment
 * in this file.
 *
 * An earlier draft carried a `VALID` fixture (to work out required-ness by deleting keys and
 * re-parsing). It worked, and it was still wrong twice over: it duplicated the fixture in
 * `test/dockerfile-env.test.ts`, and its Google client-secret entry matched the AGENTS.md secret
 * scan — making this a TENTH credential-shaped file in a baseline of nine, for a fixture the test
 * did not actually need. `lib/env.ts` answers both questions directly instead. Fixtures that carry
 * credential shape should exist only where the shape is load-bearing.
 *
 * Note this prose names no assignment literally, which is not fussiness: the first rewrite of this
 * very comment quoted the offending line to explain it, and tripped the scan again. The scanner
 * reads the whole file and does not care that a string is inside a comment — correctly, since a
 * credential in a comment is still leaked. `test/dockerfile-env.test.ts` records hitting the
 * identical trap, one file over.
 *
 * Reading the schema shape also fixes a subtler bug this test's own negative control caught: an
 * optional variable with no default (`SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`) is absent from
 * `parseEnv`'s OUTPUT when unset, so a parse-based derivation reported both as
 * documented-but-undeclared — a phantom-variable failure against a doc that was, on those two
 * rows, entirely correct.
 */
const declaredEnvNames = envVarNames;
const isRequired = (name: string) => requiredEnvVarNames().includes(name);

/** Variable names appearing in a leading `| \`NAME\` |` table cell in the doc. */
function documentedEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const m of DOC.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)) names.add(m[1]);
  return names;
}

describe("docs/07 environment table matches lib/env.ts", () => {
  it("the schema derivation returns something sane", () => {
    // Premise guard: if either of these is empty, every assertion below passes vacuously.
    expect(declaredEnvNames().length).toBeGreaterThan(10);
    const required = requiredEnvVarNames();
    expect(required.length).toBeGreaterThan(0);
    // Required is a strict subset — a schema where everything is required would mean the
    // required/optional split below is meaningless.
    expect(required.length).toBeLessThan(declaredEnvNames().length);
    // Spot-check both sides against facts that are true by construction, not by convention:
    // no default anywhere in the schema for the key, a default of 30 for the quota.
    expect(required).toContain("OPENROUTER_API_KEY");
    expect(required).not.toContain("QUOTA_DAILY_LIMIT");
  });

  it("the doc's table is actually being parsed", () => {
    // Guards against a regex that quietly matches nothing, which would make the two directions
    // below pass vacuously — the "empty pattern reports a confident all-clear" failure mode
    // AGENTS.md rule 1 calls out for the secret scan.
    const documented = documentedEnvNames();
    expect(documented.size).toBeGreaterThan(10);
    expect(documented.has("DATABASE_URL")).toBe(true);
    expect(documented.has("OPENROUTER_API_KEY")).toBe(true);
  });

  it("every variable the schema declares is documented", () => {
    const documented = documentedEnvNames();
    const undocumented = declaredEnvNames().filter((n) => !documented.has(n));

    expect(
      undocumented,
      `declared in lib/env.ts but absent from docs/07 — an operator populating Secret Manager ` +
        `from that table would never know to set them: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("every variable the doc lists actually exists in the schema", () => {
    const declared = new Set(declaredEnvNames());
    /**
     * Names that appear in a table cell but are legitimately not app config. `PORT`/`HOSTNAME` are
     * how Cloud Run reaches the container; they are set by the platform and the Dockerfile, not by
     * `lib/env.ts`.
     */
    const NOT_APP_CONFIG = new Set(["PORT", "HOSTNAME"]);

    const phantom = [...documentedEnvNames()].filter(
      (n) => !declared.has(n) && !NOT_APP_CONFIG.has(n),
    );

    expect(
      phantom,
      `documented in docs/07 but declared nowhere in lib/env.ts. Setting one of these in Secret ` +
        `Manager does nothing and reports nothing — the deploy looks configured and is not: ` +
        `${phantom.join(", ")}`,
    ).toEqual([]);
  });

  it("required and optional are not mixed up, because the failure modes differ", () => {
    /**
     * A required variable that goes missing is LOUD (the app exits 1 naming it). An optional one
     * that is misspelled is SILENT (ignored, default applied). Documenting a required variable as
     * optional understates the consequence of omitting it; the reverse sends someone hunting for a
     * value they never needed. The doc splits them under two headings — assert that split is real.
     */
    const requiredHeading = DOC.indexOf("**Required");
    const optionalHeading = DOC.indexOf("**Optional");
    expect(requiredHeading, "docs/07 no longer separates required from optional").toBeGreaterThan(-1);
    expect(optionalHeading).toBeGreaterThan(requiredHeading);

    const requiredSection = DOC.slice(requiredHeading, optionalHeading);
    const optionalSection = DOC.slice(optionalHeading);

    for (const name of declaredEnvNames()) {
      const section = isRequired(name) ? requiredSection : optionalSection;
      const other = isRequired(name) ? optionalSection : requiredSection;
      // Listed under the correct heading, and not under the other one.
      expect(
        section.includes(`\`${name}\``),
        `${name} is ${isRequired(name) ? "REQUIRED" : "optional"} in lib/env.ts but is not listed ` +
          `under that heading in docs/07`,
      ).toBe(true);
      expect(
        other.includes(`| \`${name}\` |`),
        `${name} is listed under the wrong heading in docs/07`,
      ).toBe(false);
    }
  });
});

describe("NEGATIVE CONTROL — the comparison can actually fail", () => {
  it("detects a phantom variable, the exact defect found on 2026-08-05", () => {
    // Reconstructed rather than described: a name in the doc's table shape that the schema does
    // not declare must be caught. `DAILY_GENERATION_LIMIT` is the real one that was there.
    const declared = new Set(declaredEnvNames());
    expect(declared.has("DAILY_GENERATION_LIMIT")).toBe(false);
    expect(declared.has("OPENROUTER_QUALITY_MODEL")).toBe(false);
    expect(declared.has("MAX_UPLOAD_BYTES")).toBe(false);

    const fakeDoc = "| `DAILY_GENERATION_LIMIT` | `30` | per user |";
    const found = [...fakeDoc.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]);
    expect(found).toEqual(["DAILY_GENERATION_LIMIT"]);
    expect(found.filter((n) => !declared.has(n))).toEqual(["DAILY_GENERATION_LIMIT"]);
  });

  it("detects a declared variable that the doc omits", () => {
    const documented = documentedEnvNames();
    // A variable the schema declares but a stripped-down doc does not mention.
    const strippedDoc = new Set([...documented].filter((n) => n !== "GRAPH_BUILD_BUDGET_MS"));
    const missing = declaredEnvNames().filter((n) => !strippedDoc.has(n));
    expect(missing).toEqual(["GRAPH_BUILD_BUDGET_MS"]);
  });
});
