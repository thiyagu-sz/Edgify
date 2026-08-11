"use client";

import { useEffect } from "react";
import { initAnalytics } from "@/lib/analytics";

/**
 * Mounts product analytics once, at the root.
 *
 * Renders NOTHING and wraps nothing — deliberately. The obvious shape for this is a context
 * provider around `{children}`, but that would turn the entire application tree into a child of a
 * Client Component boundary and cost every page its Server Component rendering. A sibling that
 * returns `null` gets the same initialisation with no effect on the tree above or below it.
 *
 * When `NEXT_PUBLIC_POSTHOG_KEY` is unset — the default — `initAnalytics` returns immediately and
 * this component is inert. posthog-js is still in the bundle, so switching analytics on is a
 * rebuild with a key rather than a code change (lib/analytics.ts).
 *
 * Pageviews, referrer and UTM parameters are captured by posthog-js itself, including on client
 * navigations (`capture_pageview: "history_change"`). There is deliberately no `usePathname` /
 * `useSearchParams` effect here: reading search params in a component this high would opt every
 * route out of static rendering unless wrapped in Suspense, which is a real cost for something
 * the SDK already does.
 */
export function AnalyticsProvider() {
  useEffect(() => {
    initAnalytics();
  }, []);

  return null;
}
