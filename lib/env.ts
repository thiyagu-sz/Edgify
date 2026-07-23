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
