import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_RATINGS,
  FEEDBACK_RATING_LABELS,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_LABELS,
  MAX_MESSAGE_LENGTH,
  feedbackRequestSchema,
} from "./feedback";

/**
 * The feedback vocabularies are used in three places that must agree: the Zod schema at the API
 * boundary, the CHECK constraints in the database, and the labels in the form. A value present in
 * one and missing from another produces a submit button that silently fails — accepted by the
 * route, rejected by Postgres, or offered by the UI and refused by both.
 */

describe("the wire contract", () => {
  const VALID = { type: "bug", message: "Upload spins forever." } as const;

  it("accepts a minimal valid submission", () => {
    expect(feedbackRequestSchema.safeParse(VALID).success).toBe(true);
  });

  it("has no userId or status field at all", () => {
    /**
     * Not "ignores them" — DOES NOT HAVE THEM. Authorship comes from the session and status from
     * the column default; a schema that merely stripped them would still be one careless spread
     * away from trusting a client-sent author.
     */
    const shape = Object.keys(feedbackRequestSchema.shape);
    expect(shape).not.toContain("userId");
    expect(shape).not.toContain("status");
  });

  it.each([
    ["unknown type", { ...VALID, type: "spam" }],
    ["unknown rating", { ...VALID, rating: "amazing" }],
    ["unknown source", { ...VALID, source: "elsewhere" }],
    ["empty message", { ...VALID, message: "" }],
    ["whitespace-only message", { ...VALID, message: "   " }],
    ["oversized message", { ...VALID, message: "a".repeat(MAX_MESSAGE_LENGTH + 1) }],
  ])("rejects an %s", (_label, body) => {
    expect(feedbackRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["an absolute URL", "https://evil.test/steal"],
    ["a protocol-relative URL", "//evil.test"],
    ["a query string", "/notes?token=abc"],
    ["a fragment", "/notes#secret"],
    ["something that is not a path", "notes"],
  ])("rejects %s as a route", (_label, route) => {
    // `route` is our own pathname and nothing else — not a place to smuggle data or a link.
    expect(feedbackRequestSchema.safeParse({ ...VALID, route }).success).toBe(false);
  });

  it("accepts the application's own paths as a route", () => {
    for (const route of ["/notes", "/graph", "/admin/usage", "/"]) {
      expect(feedbackRequestSchema.safeParse({ ...VALID, route }).success, route).toBe(true);
    }
  });
});

describe("the vocabularies agree everywhere they are used", () => {
  const schemaSrc = readFileSync(join(process.cwd(), "lib", "db", "schema.ts"), "utf8");
  const migration = readFileSync(
    join(process.cwd(), "drizzle", "0003_loving_giant_girl.sql"),
    "utf8",
  );

  it("every type and rating has a label in the form", () => {
    for (const t of FEEDBACK_TYPES) expect(FEEDBACK_TYPE_LABELS[t], t).toBeTruthy();
    for (const r of FEEDBACK_RATINGS) expect(FEEDBACK_RATING_LABELS[r], r).toBeTruthy();
  });

  it("the database CHECK constraints are derived from these arrays, not retyped", () => {
    // If someone hardcodes the list in schema.ts, a new type here would pass Zod and fail the
    // insert — the exact drift this whole module exists to prevent.
    expect(schemaSrc).toMatch(/inList\(FEEDBACK_TYPES\)/);
    expect(schemaSrc).toMatch(/inList\(FEEDBACK_RATINGS\)/);
    expect(schemaSrc).toMatch(/inList\(FEEDBACK_STATUSES\)/);
    expect(schemaSrc).toMatch(/inList\(FEEDBACK_SOURCES\)/);
  });

  it("the generated migration contains exactly the current vocabularies", () => {
    // The migration is the thing that actually runs against Neon. If it drifts from the code, the
    // failure appears only in production, on an insert.
    for (const t of FEEDBACK_TYPES) expect(migration, `type ${t}`).toContain(`'${t}'`);
    for (const r of FEEDBACK_RATINGS) expect(migration, `rating ${r}`).toContain(`'${r}'`);
    for (const s of FEEDBACK_STATUSES) expect(migration, `status ${s}`).toContain(`'${s}'`);
    for (const s of FEEDBACK_SOURCES) expect(migration, `source ${s}`).toContain(`'${s}'`);
    expect(migration).toContain(`between 1 and ${MAX_MESSAGE_LENGTH}`);
  });

  it("the migration only ADDS — it alters and drops nothing", () => {
    // A feedback feature must never be able to touch existing production data.
    expect(migration).not.toMatch(/\bDROP\b/i);
    expect(migration).not.toMatch(/ALTER TABLE (?!"feedback")/i);
    expect(migration).toMatch(/CREATE TABLE "feedback"/);
  });
});
