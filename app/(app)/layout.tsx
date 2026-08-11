import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AnalyticsIdentity } from "@/components/analytics/analytics-identity";
import { TopBar } from "@/components/top-bar";
import { auth } from "@/lib/auth";

/**
 * NOINDEX, NOFOLLOW for the whole authenticated group — `/notes`, `/graph` and `/admin/usage`
 * all inherit it, so a new protected page is private by default rather than by remembering.
 *
 * This is defence in depth, not the access control. The redirect below is what stops a crawler
 * seeing anything; this stops the URLs themselves being indexed if they are ever linked from
 * outside, which `robots.txt` alone cannot do (a disallowed URL can still be indexed from an
 * inbound link, precisely because the crawler is not allowed to fetch it and read a noindex).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Protected route group. The session check runs on the server, so unauthenticated users are
 * redirected before any protected content is sent to the browser.
 *
 * `.edgify-workspace` scopes the light workspace theme (app/globals.css) and hosts the shared
 * TopBar chrome, so every authenticated page inherits the ported design.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }
  return (
    <div className="edgify-workspace">
      {/* The id, not the email — see the component's own note on why. */}
      <AnalyticsIdentity userId={session.user.id} />
      {/* The session is already resolved here to guard the route, so the top bar's profile
          control is fed from it rather than refetching the same thing in the browser. */}
      <TopBar userEmail={session.user.email} />
      {children}
    </div>
  );
}
