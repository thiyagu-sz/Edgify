import { env } from "../env";

/**
 * Wall-clock bounds for a graph build (docs/09 §1.6).
 *
 * Shared by the two routes that own opposite ends of the same problem: the build route enforces
 * the budget while a build is running, and the poll route retires builds that outlived it. They
 * must agree on the numbers, so the numbers live here rather than being written twice.
 */

/** How long one build may spend walking the ladder before it abandons to `failed`. */
export function buildBudgetMs(): number {
  return env.GRAPH_BUILD_BUDGET_MS;
}

/**
 * Grace on top of the budget before a claimed build is treated as abandoned.
 *
 * THIS MUST BE POSITIVE. A build inside its own budget is expected to be running, and reaping it
 * would race the fix: a legitimately slow build, seconds from succeeding, would be marked `failed`
 * underneath itself and its result discarded. The reaper is a BACKSTOP for the case the budget
 * cannot cover — the process itself dying — so it deliberately waits until the budget has already
 * had its chance and demonstrably failed to produce a result.
 */
const ABANDON_GRACE_MS = 60_000;

/**
 * The cutoff: a build claimed before this instant, and still `processing`, is abandoned.
 *
 * Derived from the budget rather than configured separately, so raising the budget cannot leave a
 * stale threshold behind it — the failure that would produce is a reaper that kills healthy builds,
 * which is far worse than the zombie it replaces.
 */
export function abandonedBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - (buildBudgetMs() + ABANDON_GRACE_MS));
}
