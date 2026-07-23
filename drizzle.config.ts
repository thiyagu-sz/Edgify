import type { Config } from "drizzle-kit";

// drizzle-kit does not load .env.local automatically. Node 22 can.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local (e.g. CI uses real env vars) — fall through to process.env.
}

export default {
  schema: ["./lib/db/schema.ts", "./lib/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
