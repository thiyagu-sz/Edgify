/**
 * First-token latency against the live model (Phase 4: "first token within ~2 seconds").
 *
 * A MEASUREMENT, not a CI gate. Wall-clock latency here is a property of the model, the provider
 * and the network on the day; gating CI on it buys flakiness rather than safety. The structural
 * guarantee — that the route flushes its first byte before the generation completes — is gated
 * deterministically in app/api/notes/generate/route.test.ts.
 *
 * Reports the full distribution rather than one number, and breaks the wait into its parts, so a
 * slow result points at what to change instead of inviting a guess:
 *
 *   click → [cache lookup] → [quota upsert] → [model TTFT] → first byte
 *              Neon round trip   Neon round trip   provider
 *
 * Two Neon round trips precede every model call (docs/05 W2: cache before quota), and Neon
 * suspends when idle, so a cold database can dominate the figure entirely. The `/api/usage`
 * probe measures one warm round trip for comparison.
 *
 * Usage: SESSION_COOKIE=<name=value> node --env-file=.env.local test/e2e/first-token-latency.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const BASE = process.env.APP_BASE ?? "http://localhost:3000";
const SAMPLE = readFileSync(join(repoRoot, "test/e2e/sample-text.txt"), "utf8").trim();
const N = Number(process.env.N ?? 10);

const cookie = process.env.SESSION_COOKIE;
if (!cookie) throw new Error("SESSION_COOKIE is not set (see test/e2e/seed-session.mjs)");

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

const fmt = (s) =>
  `n=${s.n} min=${s.min.toFixed(0)}ms median=${s.median.toFixed(0)}ms ` +
  `p95=${s.p95.toFixed(0)}ms max=${s.max.toFixed(0)}ms mean=${s.mean.toFixed(0)}ms`;

/**
 * A single warm Neon round trip, measured directly against the database.
 *
 * Deliberately NOT inferred from `/api/usage`: that endpoint costs a session lookup *plus* the
 * quota read plus HTTP overhead, so treating it as one round trip double-counts and inflates the
 * database's share of the wait. The number that attributes latency correctly is the cost of one
 * query, multiplied by the number of queries the generate path actually makes.
 */
async function probeDbDirect(pool, samples = 8) {
  await pool.query("select 1"); // warm the pool; the first query pays connection setup
  const times = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    await pool.query("select 1");
    times.push(performance.now() - started);
  }
  return times;
}

/** The full /api/usage request, for reference — session lookup + quota read + HTTP. */
async function probeUsageEndpoint() {
  const started = performance.now();
  const res = await fetch(`${BASE}/api/usage`, { headers: { cookie } });
  await res.json();
  return performance.now() - started;
}

/**
 * Queries on the critical path before the model is called, per docs/05 W2:
 *   1. session lookup (auth)   2. cache lookup (tier 0)   3. quota upsert
 */
const DB_QUERIES_BEFORE_MODEL = 3;

async function measureFirstToken(index) {
  // Unique text per run: a cache hit returns instantly and would measure nothing.
  const text = `${SAMPLE}\n\nRun ${index} ${Date.now()} ${Math.random().toString(36).slice(2)}.`;
  const started = performance.now();

  const res = await fetch(`${BASE}/api/notes/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ text, format: "key_points" }),
  });

  const headersAt = performance.now() - started;
  const kind = res.headers.get("X-Trellis-Kind");
  const tier = res.headers.get("X-Trellis-Tier");

  if (kind !== "stream") {
    const body = await res.json().catch(() => ({}));
    return { kind, tier, headersAt, firstByteAt: null, note: body.notice ?? body.message ?? "" };
  }

  const reader = res.body.getReader();
  let firstByteAt = null;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      if (firstByteAt === null) firstByteAt = performance.now() - started;
      bytes += value.length;
    }
  }
  return { kind, tier, headersAt, firstByteAt, bytes, totalAt: performance.now() - started };
}

console.log(`Base: ${BASE}   samples: ${N}\n`);

// Warm the database first, so the model figure is not confounded by a cold Neon compute that
// only the very first request pays for.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const db = stats(await probeDbDirect(pool));
await pool.end();

const usageSamples = [];
for (let i = 0; i < 3; i++) usageSamples.push(await probeUsageEndpoint());
const usage = stats(usageSamples);

const dbHost = new URL(process.env.DATABASE_URL).host.replace(/^[^.]*/, "<project>");
console.log(`Database: ${dbHost}`);
console.log(`One warm Neon round trip:         ${fmt(db)}`);
console.log(`Full /api/usage request:          ${fmt(usage)}`);
console.log(
  `  (${DB_QUERIES_BEFORE_MODEL} queries run before the model on the generate path: ` +
    `session, cache, quota — about ${(db.median * DB_QUERIES_BEFORE_MODEL).toFixed(0)}ms)\n`,
);

const rows = [];
for (let i = 0; i < N; i++) {
  const r = await measureFirstToken(i);
  rows.push(r);
  console.log(
    `  run ${String(i + 1).padStart(2)}  kind=${r.kind ?? "?"} tier=${r.tier ?? "-"}  ` +
      `headers=${r.headersAt.toFixed(0)}ms  ` +
      `firstByte=${r.firstByteAt === null ? "n/a" : `${r.firstByteAt.toFixed(0)}ms`}  ` +
      `total=${r.totalAt ? `${r.totalAt.toFixed(0)}ms` : "-"}${r.note ? `  (${r.note})` : ""}`,
  );
}

const streamed = rows.filter((r) => r.firstByteAt !== null);
console.log("");
if (streamed.length === 0) {
  console.log("No streaming responses — every run fell to a buffered tier. Nothing to measure.");
} else {
  const ft = stats(streamed.map((r) => r.firstByteAt));
  const dbShare = db.median * DB_QUERIES_BEFORE_MODEL;
  console.log(`First token (streamed runs):      ${fmt(ft)}`);
  console.log("");
  console.log("Attribution of the median wait:");
  console.log(
    `  ~${dbShare.toFixed(0)}ms  our ${DB_QUERIES_BEFORE_MODEL} sequential Neon round trips ` +
      `(${db.median.toFixed(0)}ms each, ${((dbShare / ft.median) * 100).toFixed(0)}% of the wait)`,
  );
  console.log(
    `  ~${(ft.median - dbShare).toFixed(0)}ms  provider time-to-first-token + app overhead`,
  );
  console.log(`\nTarget: median ≤ 2000ms.  Result: ${ft.median <= 2000 ? "MET" : "NOT MET"}`);
  console.log(
    "\nNote: this measures a local server against a remote Neon region, so the per-query RTT\n" +
      "is network distance, not database work. Co-located in production it is single-digit ms.\n" +
      "That is an explanation of the number, not a claim about production — production has not\n" +
      "been measured (Phase 7).",
  );
}
