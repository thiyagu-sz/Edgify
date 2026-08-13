import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { check } from "drizzle-orm/pg-core";
import {
  FEEDBACK_RATINGS,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  MAX_MESSAGE_LENGTH,
} from "../feedback";
import { user } from "./auth-schema";

/**
 * Application schema — see docs/03-data-model.md for the authoritative spec.
 *
 * Better Auth owns `user` / `session` / `account` / `verification` (lib/db/auth-schema.ts,
 * CLI-generated, do not hand-edit). Every application table carries a `userId` text FK to
 * `user.id`; isolation is enforced in lib/db/queries/* (there is no row-level security).
 */

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true });

/** Uploaded source material. The original file is never stored — only its extracted text. */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    contentHash: text("content_hash").notNull(),
    charCount: integer("char_count"),
    pageCount: integer("page_count"),
    sourceType: text("source_type"),
    extractedText: text("extracted_text"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("documents_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    index("documents_content_hash_idx").on(table.contentHash),
  ],
);

/** One knowledge graph per document. */
export const graphs = pgTable(
  "graphs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    // Denormalised on purpose — avoids a join on every read.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    status: text("status").notNull().default("processing"),
    failureReason: text("failure_reason"),
    promptVersion: text("prompt_version").notNull(),
    modelId: text("model_id").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    /**
     * When a build claimed this row — the only thing that distinguishes a LIVE build from an
     * ABANDONED one (docs/09 §1.6). `createdAt` cannot do it: the row is created at upload, before
     * the client fires the build, so an old `createdAt` says nothing about whether anything is
     * still running. Null means never claimed.
     */
    buildStartedAt: timestamptz("build_started_at"),
  },
  (table) => [
    index("graphs_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("graphs_document_idx").on(table.documentId),
  ],
);

/** Nodes of the graph. `detailJson` is null until the user first clicks the concept. */
export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    graphId: uuid("graph_id")
      .notNull()
      .references(() => graphs.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    difficulty: text("difficulty"),
    summary: text("summary"),
    detailJson: jsonb("detail_json"),
    detailGeneratedAt: timestamptz("detail_generated_at"),
    estimatedMinutes: integer("estimated_minutes"),
    layoutX: integer("layout_x"),
    layoutY: integer("layout_y"),
    layoutW: integer("layout_w"),
  },
  (table) => [unique("concepts_graph_slug_unique").on(table.graphId, table.slug)],
);

/** Prerequisite relationships: `prerequisiteId` must be learned before `dependentId`. */
export const edges = pgTable(
  "edges",
  {
    graphId: uuid("graph_id")
      .notNull()
      .references(() => graphs.id, { onDelete: "cascade" }),
    prerequisiteId: uuid("prerequisite_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    dependentId: uuid("dependent_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({
      columns: [table.graphId, table.prerequisiteId, table.dependentId],
    }),
  ],
);

/** Generated Quick Notes output. */
export const notes = pgTable("notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Null when the user pasted text directly.
  documentId: uuid("document_id").references(() => documents.id, {
    onDelete: "set null",
  }),
  format: text("format").notNull(),
  contentMd: text("content_md"),
  modelId: text("model_id"),
  promptVersion: text("prompt_version"),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
});

/** Per-user concept progress. */
export const mastery = pgTable(
  "mastery",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    state: text("state"),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.conceptId] })],
);

/**
 * The deduplication table — what keeps the system affordable. Deliberately NOT scoped to a
 * user: two students uploading the same lecture PDF share the entry. Never expose cacheKey in
 * an API response (docs/03-data-model.md).
 */
export const generationCache = pgTable("generation_cache", {
  cacheKey: text("cache_key").primaryKey(),
  resultJson: jsonb("result_json").notNull(),
  hitCount: integer("hit_count").default(0).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  lastAccessedAt: timestamptz("last_accessed_at").defaultNow().notNull(),
});

/** Quota enforcement — one row per user per day. */
export const usageCounters = pgTable(
  "usage_counters",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    generations: integer("generations").default(0).notNull(),
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.day] })],
);

/**
 * Fixed-window rate limiting for unauthenticated routes. Postgres counters are the chosen
 * mechanism at this volume (docs/02-tech-stack.md deliberately excludes Redis: "Postgres
 * counters are sufficient at this volume"). One row per (bucket, window); the count is
 * incremented atomically with ON CONFLICT ... DO UPDATE. Rows for elapsed windows are dead
 * weight and are pruned opportunistically — never read after their window closes.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    // Identifies who/what is limited for a given rule, e.g. `health:1.2.3.4`.
    bucketKey: text("bucket_key").notNull(),
    // Start of the fixed window this count belongs to (floor(now / windowMs)).
    windowStart: timestamptz("window_start").notNull(),
    count: integer("count").default(0).notNull(),
  },
  (table) => [primaryKey({ columns: [table.bucketKey, table.windowStart] })],
);

/** Append-only record of every model call — how quotas, cost visibility and abuse detection work. */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operation: text("operation"),
    modelId: text("model_id"),
    tier: text("tier"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costMicros: integer("cost_micros"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("usage_ledger_user_created_idx").on(
      table.userId,
      table.createdAt.desc(),
    ),
    index("usage_ledger_created_idx").on(table.createdAt.desc()),
  ],
);

/**
 * Quote a fixed vocabulary for a SQL `IN` list.
 *
 * Safe against injection by construction: the only callers pass module constants from
 * `lib/feedback.ts`, never anything derived from a request. Deriving the constraint from that
 * array rather than retyping the values is the point — a new feedback type added there and not
 * here would otherwise be accepted by Zod and rejected by Postgres, which surfaces as a submit
 * button that silently fails.
 */
const inList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

/**
 * User-submitted product feedback (bug reports, requests, sentiment).
 *
 * Deliberately NOT a general-purpose events table. It holds what a person chose to tell us and
 * nothing derived about them: no email, no name, no IP, no user-agent. The author is the `userId`
 * foreign key and nothing else, so a deleted account takes its feedback with it (`onDelete:
 * cascade`) without a separate erasure step.
 *
 * `route` is our OWN pathname (`/notes`, `/graph`) — no query string, no identifiers — which is
 * the difference between "something is broken" and "something is broken on the graph page". It is
 * pattern-restricted at the API boundary so a client cannot use the column as free storage.
 *
 * CHECK constraints rather than trusting the application alone. Zod already rejects an unknown
 * type at the route, so these are the second line: they hold for anything that reaches the table
 * by another path (a future admin tool, a manual backfill, a migration script) and they document
 * the vocabulary to anyone reading the database rather than the code.
 */
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** Optional: a bug report does not need a sentiment attached to be useful. */
    rating: text("rating"),
    message: text("message").notNull(),
    /** Triage lifecycle. Nothing reads it yet; it exists so the table is reviewable later. */
    status: text("status").notNull().default("new"),
    /** Which entry point produced this — the top-bar widget, or the post-generation prompt. */
    source: text("source"),
    route: text("route"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    // The reader's own history, newest first — the only user-facing query shape.
    index("feedback_user_created_idx").on(table.userId, table.createdAt.desc()),
    // Triage: "what is new", newest first. The shape an admin view would use.
    index("feedback_status_created_idx").on(table.status, table.createdAt.desc()),
    index("feedback_type_idx").on(table.type),
    check("feedback_type_valid", sql.raw(`type in (${inList(FEEDBACK_TYPES)})`)),
    check("feedback_rating_valid", sql.raw(`rating is null or rating in (${inList(FEEDBACK_RATINGS)})`)),
    check("feedback_status_valid", sql.raw(`status in (${inList(FEEDBACK_STATUSES)})`)),
    check("feedback_source_valid", sql.raw(`source is null or source in (${inList(FEEDBACK_SOURCES)})`)),
    // Bounds the write surface at the table, not only at the route.
    check(
      "feedback_message_length",
      sql.raw(`char_length(message) between 1 and ${MAX_MESSAGE_LENGTH}`),
    ),
  ],
);
