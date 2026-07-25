import { randomUUID } from "node:crypto";
import { user } from "@/lib/db/auth-schema";
import { db } from "@/lib/db/client";

/**
 * Seed a Better Auth user directly (documents/graphs/etc. carry a FK to `user.id`). Returns the
 * new user id. Integration-only — requires the container DB from `global-setup.ts`.
 */
export async function createTestUser(): Promise<string> {
  const id = `user_${randomUUID()}`;
  await db.insert(user).values({
    id,
    name: "Test User",
    email: `${id}@example.test`,
  });
  return id;
}
