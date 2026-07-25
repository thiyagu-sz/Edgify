import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Strip anything that could carry user content out of a Sentry event before it leaves the
 * process (docs/09 §2.6: "document text is not attached to error reports").
 *
 * Pure and dependency-free so it is safe to share across the server, edge and browser Sentry
 * inits. Combined with `sendDefaultPii: false`, this keeps request bodies (pasted or uploaded
 * document text), cookies, auth headers and IPs out of error reports.
 */
export function scrubPii(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    // The request body is the highest-risk field — it can contain the user's document text.
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
  }
  if (event.user) {
    delete event.user.ip_address;
  }
  return event;
}
