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
  // Verified live 2026-07-27 (reasoning_tokens=0, ~1.2s streaming first token).
  OPENROUTER_FREE_MODEL: z.string().min(1).default("google/gemma-4-26b-a4b-it:free"),
  // Comma-separated additional free ids tried before falling to the paid tier — a different
  // provider (InclusionAI) so a Google-side rotation/429 doesn't take the free tier down. Kept to
  // ONE verified-live, non-reasoning id: most other free models today reason heavily (token burn,
  // slow first token) or are saturated. The paid tier is the backstop beyond this (docs/04 §1).
  OPENROUTER_FREE_FALLBACKS: z.string().default("inclusionai/ling-3.0-flash:free"),
  OPENROUTER_PAID_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
  // Bump to invalidate the generation cache when prompt templates change (docs/08 §prompts).
  PROMPT_VERSION: z.string().min(1).default("v1"),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

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
