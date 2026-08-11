"use client";

import { useEffect } from "react";
import { identifyUser } from "@/lib/analytics";

/**
 * Ties analytics events to the signed-in user, mounted from the authenticated layout.
 *
 * It receives the DATABASE USER ID and nothing else. The layout also has the email to hand — it
 * passes it to the top bar — and deliberately does not pass it here: an id is an opaque key that
 * already exists on both sides, whereas an email is personal data that would then live in
 * analytics indefinitely, be searchable by anyone with project access, and propagate into every
 * downstream integration. No funnel question needs it.
 *
 * This is also the completion signal for Google sign-in. That flow leaves the page for Google's
 * consent screen, so the form cannot observe its own success; arriving here with a session is the
 * first moment the browser knows it worked (see components/auth/auth-form.tsx).
 *
 * A no-op when analytics is unconfigured, like everything else in lib/analytics.ts.
 */
export function AnalyticsIdentity({ userId }: { userId: string }) {
  useEffect(() => {
    identifyUser(userId);
  }, [userId]);

  return null;
}
