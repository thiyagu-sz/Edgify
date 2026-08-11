"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/**
 * Fires one property-less event when a page mounts.
 *
 * Exists so a Server Component page can record that it was opened without becoming a Client
 * Component itself, and without an effect being bolted onto whatever large component it happens
 * to render. Renders nothing.
 *
 * Restricted by its type to events that take no properties, so it cannot become a general-purpose
 * escape hatch around the typed vocabulary in lib/analytics.ts.
 */
export function TrackOnMount({ event }: { event: "demo_opened" }) {
  useEffect(() => {
    track(event);
  }, [event]);

  return null;
}
