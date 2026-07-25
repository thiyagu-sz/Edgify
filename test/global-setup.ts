import { rmSync, writeFileSync } from "node:fs";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { DB_URL_FILE } from "./db-url";

/**
 * Integration-test global setup: start ONE ephemeral Postgres container, apply the committed
 * Drizzle migrations to it, and publish its connection string for the worker (via DB_URL_FILE).
 * Runs once per `vitest run`; the returned teardown stops the container.
 *
 * Hermetic and offline-friendly after the first image pull — no Neon credentials required.
 */
export default async function setup() {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();

  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }

  writeFileSync(DB_URL_FILE, url);
  process.env.DATABASE_URL = url;

  return async () => {
    try {
      rmSync(DB_URL_FILE, { force: true });
    } catch {
      // best effort
    }
    await container.stop();
  };
}
