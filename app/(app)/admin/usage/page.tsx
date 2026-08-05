import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAdminEmail } from "@/lib/admin";
import { auth } from "@/lib/auth";
import {
  dailySpend,
  outcomeBreakdown,
  quotaUsedToday,
  tierBreakdown,
  usageByModel,
  usageByUser,
} from "@/lib/db/queries/usage-admin";
import { env } from "@/lib/env";
import { dayKey } from "@/lib/quota";
import { UsageDashboard } from "@/components/admin/usage-dashboard";

/**
 * `/admin/usage` — the internal usage dashboard (docs/06 Phase 7).
 *
 * A SERVER COMPONENT WITH NO API ROUTE BEHIND IT, deliberately. The aggregates are fetched during
 * render and only the finished markup crosses to the browser, so fleet-wide usage never becomes a
 * fetchable endpoint that has to be independently secured. Adding `/api/admin/usage` later would
 * create exactly that second surface — don't.
 *
 * TWO GATES, and both are load-bearing:
 *  1. `app/(app)/layout.tsx` redirects unauthenticated visitors — that is authentication.
 *  2. `isAdminEmail` below — that is AUTHORISATION, and the layout does not provide it. Every
 *     other page in this app shows the caller their own data; this one shows them everyone's, so
 *     a session is not sufficient. Unset `ADMIN_EMAILS` authorises nobody (lib/admin.ts).
 *
 * A non-admin gets `notFound()`, not a 403: a 403 confirms the page exists and is worth probing,
 * which is the same reasoning docs/09 §2.6 applies to `/api/*` 404s.
 */

export const dynamic = "force-dynamic";

/** Reporting window. 30 days covers a month's billing cycle without unbounded scans. */
const WINDOW_DAYS = 30;

export default async function AdminUsagePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdminEmail(session?.user?.email)) {
    notFound();
  }

  const [users, tiers, outcomes, daily, models, quotaToday] = await Promise.all([
    usageByUser(WINDOW_DAYS),
    tierBreakdown(WINDOW_DAYS),
    outcomeBreakdown(WINDOW_DAYS),
    dailySpend(WINDOW_DAYS),
    usageByModel(WINDOW_DAYS),
    // `dayKey` is the SAME day-boundary function quota enforcement uses, honouring
    // QUOTA_TIMEZONE. Computing "today" any other way here would let the dashboard disagree with
    // the counter that actually decides whether a user is blocked.
    quotaUsedToday(dayKey()),
  ]);

  return (
    <UsageDashboard
      windowDays={WINDOW_DAYS}
      users={users}
      tiers={tiers}
      outcomes={outcomes}
      daily={daily}
      models={models}
      quotaToday={quotaToday}
      quotaLimit={env.QUOTA_DAILY_LIMIT}
    />
  );
}
