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
  join("lib", "db", "queries"), // the query layer itself
  join("lib", "db", "client.ts"), // pool + non-user health ping
];

const DB_CALL = /\bdb\s*\.\s*(?:select|insert|update|delete|query|execute)\b/;

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

describe("architecture: no DB access outside the query layer", () => {
  it("finds no db.<verb>() calls outside lib/db/queries or lib/db/client.ts", () => {
    const offenders: string[] = [];
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(process.cwd(), d))) {
        const rel = relative(process.cwd(), file);
        if (isAllowed(rel)) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (DB_CALL.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          });
      }
    }
    expect(
      offenders,
      `Direct DB access outside the query layer (move it into lib/db/queries):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
