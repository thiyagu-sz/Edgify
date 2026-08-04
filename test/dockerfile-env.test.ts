import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

/**
 * The Dockerfile's build-time placeholders cover every variable `lib/env.ts` requires.
 *
 * Written 2026-08-04, after the image failed to build for the first time it was ever tried.
 * `next build` evaluates modules that read the environment, so a required variable with no
 * build-time placeholder aborts the build — and the error it produces names neither the variable
 * nor the cause:
 *
 *     Error: Failed to collect page data for /api/auth/[...all]
 *
 * The real message (`OPENROUTER_API_KEY: Invalid input`) appears earlier in the log and is easy
 * to scroll past. What made this possible is that the two facts live in different files and drift
 * apart silently: `OPENROUTER_API_KEY` became required in Phase 3, months after the Dockerfile
 * was written in Phase 1, and nothing connected them. The image had never been built, so nothing
 * failed until Phase 7 would have tried to deploy.
 *
 * This derives the requirement from the SCHEMA rather than listing variables here, because a list
 * is a third copy that goes stale the same way. The check is: strip the Dockerfile's placeholders
 * out of a known-good environment and confirm `parseEnv` then rejects it — i.e. every variable
 * the Dockerfile bothers to set is genuinely needed, and everything genuinely needed is set.
 */

const DOCKERFILE = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

/** Variable names assigned in the builder stage's ENV block(s). */
function dockerBuildEnvNames(): Set<string> {
  const names = new Set<string>();
  // ENV A="x" \<newline>  B="y" — capture every NAME= on a continued ENV instruction.
  const envBlocks = DOCKERFILE.match(/^ENV\s(?:[^\n]*\\\n)*[^\n]*/gm) ?? [];
  for (const block of envBlocks) {
    for (const m of block.matchAll(/([A-Z][A-Z0-9_]*)=/g)) names.add(m[1]);
  }
  return names;
}

/**
 * A complete, valid environment — the baseline both directions are measured against.
 *
 * `DATABASE_URL` deliberately carries NO `user:password@` part. The schema only checks the
 * `postgres://` / `postgresql://` prefix, so credentials add nothing here — and including them
 * would make this a ninth credential-shaped file in the AGENTS.md secret-scan baseline, which is
 * a cost with no benefit. The baseline should only grow when a fixture genuinely needs the shape.
 *
 * The guard caught this twice, and the second time is the funnier one: first when this constant
 * mirrored the Dockerfile's own user:pass form, and again when the comment EXPLAINING the fix
 * quoted that URL literally. A scanner that reads the whole file does not care that a string is
 * inside a comment — which is the correct behaviour, since a leaked credential in a comment is
 * still leaked. Hence no example URL in this prose.
 */
const VALID: Record<string, string> = {
  DATABASE_URL: "postgresql://localhost:5432/build",
  BETTER_AUTH_SECRET: "build-time-placeholder-secret-000000000",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "build-placeholder",
  GOOGLE_CLIENT_SECRET: "build-placeholder",
  OPENROUTER_API_KEY: "build-placeholder",
};

describe("Dockerfile build-time env covers what lib/env.ts requires", () => {
  it("the baseline environment is itself valid", () => {
    // Premise guard: if this ever fails, every assertion below is measuring the wrong thing.
    expect(() => parseEnv(VALID)).not.toThrow();
  });

  it("every variable required without a default has a Dockerfile placeholder", () => {
    const inDockerfile = dockerBuildEnvNames();
    const missing = Object.keys(VALID).filter((name) => {
      // Required iff removing it makes an otherwise-valid environment fail to parse.
      const withoutIt = { ...VALID };
      delete withoutIt[name];
      let required = false;
      try {
        parseEnv(withoutIt);
      } catch {
        required = true;
      }
      return required && !inDockerfile.has(name);
    });

    expect(
      missing,
      `these are required by lib/env.ts but have no build-time placeholder in the Dockerfile, ` +
        `so \`next build\` will abort with a message that does not name them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("the Dockerfile sets the runtime variables Cloud Run depends on", () => {
    const names = dockerBuildEnvNames();
    // PORT and HOSTNAME are not app config — they are how Cloud Run reaches the container at all.
    // Binding to localhost instead of 0.0.0.0 makes every health check fail.
    expect(names.has("PORT")).toBe(true);
    expect(names.has("HOSTNAME")).toBe(true);
    expect(DOCKERFILE).toMatch(/HOSTNAME=0\.0\.0\.0/);
  });
});

describe("NEGATIVE CONTROL — the scan detects a placeholder that goes missing", () => {
  it("flags a required variable absent from the ENV block", () => {
    // Exactly the defect that broke the first build: required by the schema, absent from the
    // Dockerfile. Reconstructed rather than described, so the check is shown working.
    const withoutKey = { ...VALID };
    delete withoutKey.OPENROUTER_API_KEY;
    expect(() => parseEnv(withoutKey)).toThrow(/OPENROUTER_API_KEY/);
  });

  it("parses an ENV block written across continuation lines", () => {
    // The parser must handle the real multi-line shape, or it would report zero names and the
    // "every required var is present" test would fail loudly rather than pass vacuously.
    const names = dockerBuildEnvNames();
    expect(names.size).toBeGreaterThan(4);
    expect(names.has("OPENROUTER_API_KEY")).toBe(true);
    expect(names.has("DATABASE_URL")).toBe(true);
  });
});
