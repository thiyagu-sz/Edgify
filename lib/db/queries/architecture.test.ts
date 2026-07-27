import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces .claude/rules/database.md rule 1 mechanically: all database access lives in
 * `lib/db/queries/` (userId-scoped) — no raw `db.<verb>()` in route handlers, server
 * components or service modules. This is the grep from docs/09 §1.2 turned into a test that
 * fails the build, so a stray query outside the isolation-tested layer cannot ship.
 */

const SCAN_DIRS = ["app", "lib"];

// Where direct DB access is legitimate:
const ALLOW_PREFIXES = [
  join("lib", "db", "queries"), // the userId-first query layer itself
  join("lib", "db", "client.ts"), // pool + non-user health ping
  // Infra data modules: deliberately non-tenant (the shared generation cache) or per-key/day
  // counter tables — reviewed and integration-tested, not raw tenant-row access.
  join("lib", "cache.ts"),
  join("lib", "quota.ts"),
  join("lib", "rate-limit.ts"),
];

// Whole-file (not line-by-line): `\s*` spans newlines, so this also catches multi-line chains
// like `db\n  .insert(...)`.
const DB_CALL = /\bdb\s*\.\s*(?:select|insert|update|delete|query|execute)\b/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function isAllowed(rel: string): boolean {
  // Tests seed and assert against `db` directly — that is not production access.
  if (/\.test\.tsx?$/.test(rel)) return true;
  return ALLOW_PREFIXES.some((a) => rel === a || rel.startsWith(a + sep));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

describe("architecture: no DB access outside the query layer", () => {
  it("finds no db.<verb>() calls outside the query layer or allowlisted infra modules", () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(process.cwd(), d))) {
        const rel = relative(process.cwd(), file);
        if (isAllowed(rel)) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(DB_CALL)) {
          offenders.push(`${rel}:${lineOf(text, match.index)}  ${match[0]}`);
        }
      }
    }
    expect(
      offenders,
      `Direct DB access outside the query layer (move it into lib/db/queries):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
