import { db, withDbRetry } from "../client";
import { feedback } from "../schema";
import type { FeedbackRequest } from "../../feedback";

/**
 * Product feedback writes (AGENTS.md rule 2 / .claude/rules/database.md).
 *
 * `userId` is the FIRST parameter and is the ONLY source of authorship — the route derives it
 * from the session and it is never accepted from a request body. That is the whole isolation
 * story for this table: rows are written under the caller and nothing here reads across users.
 *
 * There is deliberately no reader yet. A `listFeedback` for an admin view would read across the
 * whole tenancy and would need its own gate and its own isolation coverage
 * (isolation.integration.test.ts documents why those are a different category); adding one
 * speculatively would put an ungated cross-user read in the codebase before anything needs it.
 */

export type NewFeedback = FeedbackRequest;

/**
 * Record one piece of feedback. Returns the new row's id.
 *
 * `status` is not a parameter: it takes the column default (`new`). Letting a caller set it would
 * mean a client could file a report already closed.
 */
export async function createFeedback(
  userId: string,
  input: NewFeedback,
): Promise<string> {
  return withDbRetry(async () => {
    const [row] = await db
      .insert(feedback)
      .values({
        userId,
        type: input.type,
        rating: input.rating ?? null,
        message: input.message,
        source: input.source ?? null,
        route: input.route ?? null,
      })
      .returning({ id: feedback.id });
    return row.id;
  });
}
