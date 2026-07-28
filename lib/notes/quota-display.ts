/**
 * Quota is a product surface, not an error (docs/04-resilience.md §5, .claude/rules/ui.md).
 * This pure helper maps remaining/limit to what the UI shows — nothing under 80% used, a quiet
 * counter from 80%, and a friendly (never alarming) message at 0. Client-safe: no server imports,
 * so it stays out of the browser's server graph; unit-tested in quota-display.test.ts.
 */

export type QuotaDisplay =
  | { show: false }
  | { show: true; exhausted: boolean; text: string };

const APPROACHING_FRACTION = 0.8; // show the counter once 80% of the day's allowance is used

export function quotaState(
  remaining: number | null,
  limit: number | null,
): QuotaDisplay {
  // Unknown (the /api/usage read failed) → show nothing rather than guess.
  if (remaining === null || limit === null || limit <= 0) return { show: false };

  if (remaining <= 0) {
    return {
      show: true,
      exhausted: true,
      // docs/04 §7 catalogue copy — a fact about a budget, not a failure.
      text: "You've used today's generations. Your limit resets at midnight.",
    };
  }

  const used = limit - remaining;
  if (used / limit >= APPROACHING_FRACTION) {
    const unit = remaining === 1 ? "generation" : "generations";
    return { show: true, exhausted: false, text: `${remaining} ${unit} left today` };
  }

  return { show: false };
}
