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
