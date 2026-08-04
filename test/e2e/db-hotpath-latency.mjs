import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Per-call latency for the database work on the generation hot path.
 *
 * The aggregate figure (~811ms) is not actionable on its own — it says nothing about which calls
 * are sequential by necessity and which are merely sequential by habit. This times each one
 * against the real database so any restructuring is aimed at a measured cost.
 *
 * Runs raw SQL that mirrors what the query layer emits, rather than importing the app modules,
 * so it can be run before and after a change without the change affecting the measurement.
 *
 * Usage: node --env-file=.env.local test/e2e/db-hotpath-latency.mjs
 */

const N = Number(process.env.N ?? 12);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Fail safe, matching lib/db/client.ts. Inert while DATABASE_URL carries an sslmode — pg merges
  // the parsed connection string OVER this option — but live the moment one does not.
  ssl: { rejectUnauthorized: true },
  max: 8,
});

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
  };
}
const fmt = (s) => `min=${s.min.toFixed(0)}ms median=${s.median.toFixed(0)}ms max=${s.max.toFixed(0)}ms`;

async function time(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const userId = `perf-${randomUUID()}`;
const token = randomUUID();
const day = new Date().toISOString().slice(0, 10);

await pool.query(
  `insert into "user" (id, name, email, email_verified, created_at, updated_at)
   values ($1,'perf','${userId}@perf.invalid',true,now(),now())`,
  [userId],
);
await pool.query(
  `insert into session (id, expires_at, token, created_at, updated_at, user_id)
   values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
  [randomUUID(), token, userId],
);

const calls = {
  // Better Auth resolves the session by token, joining the user row.
  "session lookup      (SELECT, auth)": () =>
    pool.query(
      `select s.id, s.expires_at, u.id as user_id, u.email
         from session s join "user" u on u.id = s.user_id
        where s.token = $1`,
      [token],
    ),

  // getCached is an UPDATE ... RETURNING: it bumps hit stats on read.
  "cache lookup MISS   (UPDATE…RETURNING)": () =>
    pool.query(
      `update generation_cache
          set hit_count = hit_count + 1, last_accessed_at = now()
        where cache_key = $1
      returning result_json`,
      [`miss-${randomUUID()}`],
    ),

  "quota consume       (INSERT…ON CONFLICT)": () =>
    pool.query(
      `insert into usage_counters (user_id, day, generations)
       values ($1, $2, 1)
       on conflict (user_id, day) do update
          set generations = usage_counters.generations + 1
        where usage_counters.generations < 100000
      returning generations`,
      [userId, day],
    ),

  "quota read          (SELECT)": () =>
    pool.query(
      `select generations from usage_counters where user_id = $1 and day = $2`,
      [userId, day],
    ),

  "ledger write        (INSERT)": () =>
    pool.query(
      `insert into usage_ledger (user_id, operation, tier, outcome, tokens_in, tokens_out, latency_ms)
       values ($1,'quick_notes','cache','ok',0,0,1)`,
      [userId],
    ),
};

console.log(`Database: ${new URL(process.env.DATABASE_URL).host.replace(/^[^.]*/, "<project>")}`);
console.log(`Samples per call: ${N}\n`);

// Warm the pool so connection setup is not charged to the first call measured.
await pool.query("select 1");

const measured = {};
for (const [name, fn] of Object.entries(calls)) {
  const times = [];
  for (let i = 0; i < N; i++) times.push(await time(fn));
  measured[name] = stats(times);
  console.log(`${name}  ${fmt(measured[name])}`);
}

// ── what the sequencing costs ────────────────────────────────────────────────
const session = measured["session lookup      (SELECT, auth)"].median;
const cache = measured["cache lookup MISS   (UPDATE…RETURNING)"].median;
const quota = measured["quota consume       (INSERT…ON CONFLICT)"].median;
const ledger = measured["ledger write        (INSERT)"].median;

/** Time a pair of statements issued together. Concurrency is not free — measure, do not assume max(). */
async function measurePair(a, b) {
  const times = [];
  for (let i = 0; i < N; i++) times.push(await time(() => Promise.all([a(), b()])));
  return stats(times);
}

const cacheWrite = () =>
  pool.query(
    `insert into generation_cache (cache_key, result_json) values ($1,$2)
     on conflict do nothing`,
    [`perf-${randomUUID()}`, JSON.stringify("result")],
  );

const completionPair = await measurePair(cacheWrite, calls["ledger write        (INSERT)"]);
const sessionCachePair = await measurePair(
  calls["session lookup      (SELECT, auth)"],
  calls["cache lookup MISS   (UPDATE…RETURNING)"],
);

console.log("\n── CHANGED: generation completion (setCached + recordLedger) ──");
console.log(`  sequential (before):  ~${(cache + ledger).toFixed(0)}ms`);
console.log(`  parallel   (after):   ${fmt(completionPair)}`);
console.log(`  saving:               ~${(cache + ledger - completionPair.median).toFixed(0)}ms per completed generation`);

console.log("\n── NOT CHANGED: first-token path (session → cache → quota) ──");
console.log(`  sequential:           ~${(session + cache + quota).toFixed(0)}ms`);
console.log(`  session ∥ cache:      ${fmt(sessionCachePair)}`);
console.log(
  `  available saving:     ~${(session + cache + quota - sessionCachePair.median - quota).toFixed(0)}ms ` +
    `— NOT taken: it means a DB write before auth on an unrate-limited route`,
);
console.log(
  `  cache ∥ quota:        unsafe — a cache HIT would consume quota (.claude/rules/ai.md)`,
);

await pool.query(`delete from "user" where id = $1`, [userId]);
await pool.end();
