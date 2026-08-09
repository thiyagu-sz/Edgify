import { z } from "zod";

/**
 * Environment validation.
 *
 * Phase 1 validates only the variables Phase 1 actually uses. Later phases extend
 * `envSchema` as they introduce new variables (OpenRouter, quota, Sentry, …) — do not add
 * them here before there is code that reads them, or the app refuses to boot for a variable
 * nothing needs yet.
 *
 * Validation is lazy: importing this module does nothing. The first property access on `env`
 * (or an explicit `assertEnv()` call) parses `process.env` once and caches it. `assertEnv()`
 * runs at server boot from `instrumentation.ts`, so a missing/malformed value stops the app
 * at startup with a clear message rather than failing mysteriously at request time.
 *
 * Server-only: never import this from a Client Component. None of these values may ever be
 * exposed to the browser, so none is prefixed `NEXT_PUBLIC_`.
 */
/**
 * An optional URL that also accepts the empty string. Committed `.env` templates ship
 * `SENTRY_DSN=""`; treat that as "not set" rather than a malformed URL so dev still boots.
 */
const optionalUrl = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.url("must be a valid URL").optional(),
);

/** A named IANA time zone. A bad value must stop boot, not silently fall back to UTC. */
const timeZone = z
  .string()
  .refine(
    (v) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be a valid IANA time zone, e.g. UTC or Asia/Kolkata" },
  )
  .default("UTC");

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "required — Neon pooled connection string")
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "must be a postgres:// or postgresql:// connection string",
    })
    /**
     * Reject the SSL modes that are about to get WEAKER (added 2026-08-05).
     *
     * In pg 8.x, `prefer`, `require` and `verify-ca` are all treated as aliases for `verify-full`,
     * so the certificate IS verified and the connection is safe today. In pg 9 /
     * pg-connection-string 3.0 they adopt standard libpq semantics, where `require` means
     * "encrypt, but do not verify who you are talking to". The connection would silently weaken on
     * a routine dependency bump — no code change, no error, and no warning at the moment it
     * happens. This is the user-data database, so encryption without authentication is not enough.
     *
     * `lib/db/client.ts` already documented this as a latent footgun and commit 2698f69 pinned
     * `verify-full` "across app and e2e scripts" — but `.env.local` is gitignored, so that pin
     * could never reach the one file that actually configures a running app. It drifted there and
     * stayed `require` until Node's own deprecation warning surfaced it. Documenting a security
     * property does not enforce it; this does.
     *
     * Omitting `sslmode` entirely is still fine: with no mode in the URL, `lib/db/client.ts`'s
     * `rejectUnauthorized: true` applies, which is the same guarantee. Only the modes that
     * OVERRIDE that fallback with something about to weaken are rejected.
     */
    .refine((v) => !/[?&]sslmode=(prefer|require|verify-ca)\b/i.test(v), {
      message:
        "must not use sslmode=prefer, require or verify-ca. These alias to verify-full in pg 8.x " +
        "but adopt weaker libpq semantics in pg 9, dropping certificate verification silently on a " +
        "dependency upgrade. Use sslmode=verify-full, or omit sslmode entirely so the " +
        "rejectUnauthorized:true fallback in lib/db/client.ts applies",
    }),
  BETTER_AUTH_SECRET: z
    .string()
    .min(16, "required — at least 16 chars (use `openssl rand -base64 32`)"),
  BETTER_AUTH_URL: z.url("must be a valid URL, e.g. http://localhost:3000"),
  GOOGLE_CLIENT_ID: z.string().min(1, "required — Google OAuth client id"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "required — Google OAuth client secret"),

  // --- Phase 2: guardrails ---------------------------------------------------
  // Error reporting. Optional so the app still boots in dev without Sentry configured.
  // A Sentry DSN is a public ingestion key, not a secret — NEXT_PUBLIC_ is safe here and
  // does NOT match the secret-leak grep in docs/09 §1.1.
  SENTRY_DSN: optionalUrl,
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
  // Per-user daily generation quota. Reset boundary is the calendar day in QUOTA_TIMEZONE.
  QUOTA_DAILY_LIMIT: z.coerce.number().int().positive().default(30),
  QUOTA_TIMEZONE: timeZone,
  // Fixed-window rate limiting for unauthenticated routes.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // --- Phase 3: the AI layer -------------------------------------------------
  // OpenRouter. SERVER-ONLY — never NEXT_PUBLIC_ (AGENTS.md rule 1). Required: the app should
  // not boot pretending it can generate when it cannot.
  OPENROUTER_API_KEY: z
    .string()
    .min(1, "required — OpenRouter API key (server-only, never NEXT_PUBLIC_)"),
  // Model routing. Free-tier ids rotate on OpenRouter, so they live in env with fallbacks —
  // a retirement is a config change, not an outage (docs/02-tech-stack.md). Prefer a
  // NON-reasoning instruct model: a reasoning model doubles free-quota token spend on a
  // summarisation task and hides the first content token behind its reasoning phase (measured).
  // Verified live 2026-07-27 (reasoning_tokens=0). The "~1.2s first token" noted then did NOT
  // reproduce: measured 2026-07-28 over n=10 against a production build, median first byte was
  // 2958ms end to end, of which ~2.1s is provider TTFT (docs/06 Phase 4 results). Treat free-tier
  // latency as variable — p95 was 12.7s — and re-measure before relying on a figure.
  OPENROUTER_FREE_MODEL: z.string().min(1).default("google/gemma-4-26b-a4b-it:free"),
  // Comma-separated additional free ids tried before falling to the paid tier. Kept to ONE
  // verified-live, non-reasoning id: most free models today reason heavily (token burn, slow first
  // token) or are saturated. The paid tier is the backstop beyond this (docs/04 §1).
  //
  // CHANGED 2026-08-09. Held `inclusionai/ling-3.0-flash:free` until that id was RETIRED —
  // confirmed absent from the live catalogue while the primary and paid ids are both still
  // present. A retired id is not a harmless leftover: it spends two attempts collecting 4xx before
  // the ladder reaches the paid backstop, so it costs latency on exactly the requests where the
  // free primary has already failed.
  //
  // THE REPLACEMENT TRADES PROVIDER DIVERSITY FOR THE NON-REASONING REQUIREMENT, deliberately.
  // The previous id was chosen to be a DIFFERENT provider so a Google-side rotation or 429 could
  // not take the whole free tier down. Nothing currently in the free catalogue satisfies both
  // constraints: the non-Google candidates checked (`openai/gpt-oss-20b`,
  // `nvidia/nemotron-3-super-120b-a12b`) both carry `reasoning`/`include_reasoning`/
  // `reasoning_effort`, and `lib/ai/models.ts` never passes those, so their reasoning cannot be
  // turned down from here.
  //
  // Non-reasoning won because its cost is measured and continuous — it applies to EVERY fallback
  // call — while the provider-diversity loss is conditional on a Google-wide outage. What survives
  // is protection against per-model saturation and rotation, which is the common case; what is
  // lost is protection against Google going down entirely, where the ladder now falls to paid one
  // rung sooner. Revisit if a non-reasoning free id appears on another provider.
  OPENROUTER_FREE_FALLBACKS: z.string().default("google/gemma-4-31b-it:free"),
  OPENROUTER_PAID_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
  // Bump to invalidate the generation cache when prompt templates change (docs/08 §prompts).
  PROMPT_VERSION: z.string().min(1).default("v2"),

  // --- Phase 7: bounding the graph build's wall clock (docs/09 §1.6) ---------
  /**
   * Wall-clock budget for ONE graph build: checked between ladder rungs and enforced per model
   * call. The graph build is the longest operation in the product and the ladder's own arithmetic
   * can exceed the platform request timeout — at the measured ~65s median call latency, a build
   * that repairs once and falls through reaches ~260s and one reaching the paid rung exceeds 300s.
   *
   * This MUST stay comfortably below the platform request timeout (300s on Cloud Run). The
   * remainder is what pays for writing `status = "failed"` and returning a response, which is the
   * entire difference between an honest failure and a row stuck on `processing` forever.
   *
   * In the environment because the deadline it hides under is a DEPLOYMENT property: changing the
   * Cloud Run request timeout must not require a code release.
   */
  GRAPH_BUILD_BUDGET_MS: z.coerce.number().int().positive().default(200_000),

  /**
   * Comma-separated emails allowed to open the internal usage dashboard (`/admin/usage`).
   *
   * **Defaults to empty, which means NOBODY** — the gate fails closed. That is deliberate: the
   * dashboard reads every user's spend, generation counts and identity across the whole tenancy,
   * so the dangerous failure is it being accidentally open, not accidentally shut. An unset
   * variable in production must lock everyone out rather than let everyone in.
   *
   * A session alone is NOT sufficient authorisation here. Every other page in the app shows the
   * caller their own data; this one shows them everyone's.
   */
  ADMIN_EMAILS: z.string().default(""),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Every variable name this schema declares, derived from the schema itself.
 *
 * Exported for `test/deploy-env-docs.test.ts`, which checks docs/07's Secret Manager table against
 * it. Deriving from `Object.keys(parseEnv(...))` instead would be subtly WRONG: an optional
 * variable with no default (`SENTRY_DSN`) is absent from the parsed result when unset, so it would
 * look undeclared and the doc listing it would be reported as a phantom. The schema shape is the
 * only complete answer.
 */
export function envVarNames(): string[] {
  return Object.keys(envSchema.shape).sort();
}

/**
 * The subset with no default and no optionality — the ones whose absence stops the app at boot.
 *
 * The distinction is worth exporting because the two failure modes are opposite. A missing
 * REQUIRED variable is loud: `assertEnv()` throws naming it and `instrumentation.ts` exits 1. A
 * misspelled OPTIONAL one is SILENT: nothing rejects the unknown name, the default applies, and
 * the operator sees a setting they believe they configured. docs/07 splits its Secret Manager
 * table on exactly this line, and `test/deploy-env-docs.test.ts` checks that split against here.
 *
 * Derived by asking each field whether it accepts `undefined`, rather than by listing names — a
 * list would be the third copy that goes stale, which is the failure this whole check exists for.
 */
export function requiredEnvVarNames(): string[] {
  return envVarNames().filter(
    (name) =>
      !envSchema.shape[name as keyof typeof envSchema.shape].safeParse(undefined).success,
  );
}

/**
 * Validate a raw environment record. Pure and side-effect free — the unit tests call this
 * directly. Throws an Error whose message names every offending variable.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. The app cannot start.\n${details}`,
    );
  }
  return result.data;
}

let cached: Env | null = null;

/** Parse and cache once. Throws (with a clear message) on the first bad boot. */
export function assertEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/**
 * Typed, validated environment. Access is lazy: the first property read triggers validation.
 * Use as `env.DATABASE_URL`.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return assertEnv()[prop as keyof Env];
  },
});
