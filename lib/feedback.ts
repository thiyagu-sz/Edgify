import { z } from "zod";

/**
 * Feedback vocabularies and validation, in one place.
 *
 * Shared by the database schema, the API route and the form, so the three cannot drift into a
 * state where the UI offers a category the server rejects — the failure mode that produces a
 * submit button which silently does nothing. `lib/feedback.test.ts` pins them together.
 *
 * These schemas ARE a security control on the server side (the route parses with them before any
 * write). On the client they are courtesy only, exactly as `lib/auth-credentials.ts` documents.
 */

/** What the feedback is about. Stored verbatim, so widening this is a migration decision. */
export const FEEDBACK_TYPES = [
  "bug",
  "feature",
  "general",
  "positive",
  "performance",
  "other",
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** How the product is working for them. Optional: a bug report needs no sentiment attached. */
export const FEEDBACK_RATINGS = ["good", "okay", "needs_improvement"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

/**
 * Where the submission came from — the widget in the top bar, or the prompt shown after a
 * generation. Worth recording because the two populations differ: prompted feedback is a sample of
 * everyone, volunteered feedback is a sample of people motivated enough to go looking.
 */
export const FEEDBACK_SOURCES = ["workspace", "prompt"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

/** Triage lifecycle. Nothing reads this yet; it exists so the table is reviewable later. */
export const FEEDBACK_STATUSES = ["new", "triaged", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * Long enough for a real bug report with reproduction steps, short enough that the column is not
 * an unbounded write surface. A single oversized body is not a threat on its own; ten thousand of
 * them are, and the rate limit alone does not bound row SIZE.
 */
export const MAX_MESSAGE_LENGTH = 2000;
export const MIN_MESSAGE_LENGTH = 1;

/**
 * The route the user was on when they submitted. Our OWN pathname only — `/notes`, `/graph` — which
 * carries no identifiers and no query string. It is the difference between "something is broken"
 * and "something is broken on the graph page", which is most of the value of a bug report.
 *
 * Capped and pattern-restricted so a client cannot use it as free storage or smuggle a URL.
 */
const routeSchema = z
  .string()
  .max(128)
  .regex(/^\/[A-Za-z0-9\-_/]*$/, "must be an application path")
  .optional();

/**
 * The wire contract. NOTE WHAT IS ABSENT: there is no `userId` and no `status`. The user is taken
 * from the session server-side, and status is the database default — accepting either from the
 * client would let a caller file feedback as somebody else, or pre-close their own report.
 */
export const feedbackRequestSchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  rating: z.enum(FEEDBACK_RATINGS).optional(),
  message: z
    .string()
    .trim()
    .min(MIN_MESSAGE_LENGTH, "Tell us a little about what happened.")
    .max(MAX_MESSAGE_LENGTH, `Keep it under ${MAX_MESSAGE_LENGTH} characters.`),
  source: z.enum(FEEDBACK_SOURCES).optional(),
  route: routeSchema,
});

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

/** Labels for the form. Kept beside the vocabulary so a new type cannot ship without one. */
export const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "Something is broken",
  feature: "Feature request",
  general: "General feedback",
  positive: "Something you liked",
  performance: "Too slow",
  other: "Other",
};

export const FEEDBACK_RATING_LABELS: Record<FeedbackRating, string> = {
  good: "Good",
  okay: "Okay",
  needs_improvement: "Needs work",
};
