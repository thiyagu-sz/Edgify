/**
 * Product analytics — the single place events are defined and the single place they are sent.
 *
 * DESIGN RULE, and the reason this file is a closed union rather than a thin `track(name, props)`
 * wrapper: the risk with analytics in THIS product is not tracking too little, it is accidentally
 * shipping a user's coursework to a third party. Edgify handles uploaded PDFs, pasted lecture
 * notes, extracted document text, model output and concept names — every one of which is private
 * user content, and every one of which is sitting in scope at exactly the call sites where an
 * event is most natural to fire.
 *
 * A free-form properties bag makes `track("generation_completed", { text: notes })` a typo away.
 * The discriminated union below makes it a COMPILE ERROR: each event declares its own property
 * shape, every property is a primitive drawn from a fixed vocabulary (a format id, a file
 * extension, a bucket label), and there is no property anywhere in this file that can hold free
 * text. `lib/analytics.test.ts` pins that property.
 *
 * NEVER ADD: document text, extracted text, file names, note content, concept names, quiz
 * questions, prompts, model output, email addresses, or anything derived from them. If a new
 * event seems to need one, it needs a bucket or an id instead.
 *
 * NO-OP UNTIL CONFIGURED. `NEXT_PUBLIC_POSTHOG_KEY` is unset by default (lib/env.ts), and every
 * function here returns immediately when it is absent — the same pattern the Sentry DSN already
 * uses in this repo. Analytics can therefore ship inert and be switched on by rebuilding with a
 * key, rather than by a code change.
 *
 * CLIENT-ONLY. This module reads `process.env.NEXT_PUBLIC_*` directly and never imports
 * `lib/env.ts`, which is server-only (AGENTS.md).
 */

import posthog from "posthog-js";

/** Revision formats, as the product already names them (lib/ai/schemas.ts vocabulary). */
type NotesFormat = string;

/** Where the material came from. Not the material itself. */
type MaterialSource = "paste" | "upload";

/** How a credential arrived. Never the credential. */
type AuthMethod = "google" | "email";

/**
 * File type as a bare extension — never the file NAME, which routinely carries a person's name,
 * a course code or a client's name ("Sarah_thesis_final.pdf").
 */
type FileKind = "pdf" | "docx" | "txt" | "md" | "other";

/**
 * The complete event vocabulary. Adding an event means adding a member here, which is the point:
 * the taxonomy cannot drift into whatever string a call site felt like passing.
 */
export type AnalyticsEvent =
  // --- Acquisition ---------------------------------------------------------
  // Pageviews, referrer and every utm_* parameter are captured automatically by posthog-js on
  // load and on History API navigation, so there is no hand-rolled event for them. Product Hunt
  // attribution is therefore just `utm_source=producthunt` on the submitted URL.
  | { name: "demo_opened"; props?: Record<string, never> }

  // --- Authentication ------------------------------------------------------
  | { name: "signup_submitted"; props: { method: AuthMethod } }
  | { name: "signup_completed"; props: { method: AuthMethod } }
  | { name: "signin_submitted"; props: { method: AuthMethod } }
  | { name: "signin_completed"; props: { method: AuthMethod } }
  | { name: "signout_completed"; props?: Record<string, never> }
  /**
   * `reason` is Better Auth's own error CODE (e.g. `INVALID_EMAIL_OR_PASSWORD`), never the
   * message and never the submitted email. The code is a fixed vocabulary; the message is not.
   */
  | { name: "auth_failed"; props: { method: AuthMethod; mode: "sign-in" | "sign-up"; reason: string } }

  // --- Activation: getting material in ------------------------------------
  | { name: "document_upload_started"; props: { fileKind: FileKind; sizeBytes: number } }
  | { name: "document_parse_succeeded"; props: { fileKind: FileKind; extractedChars: number } }
  | { name: "document_parse_failed"; props: { fileKind: FileKind; reason: string } }

  // --- Core product: Quick Notes ------------------------------------------
  | { name: "notes_generation_started"; props: { format: NotesFormat; source: MaterialSource } }
  | {
      name: "notes_generation_completed";
      props: { format: NotesFormat; source: MaterialSource; durationMs: number };
    }
  | { name: "notes_generation_failed"; props: { format: NotesFormat; reason: string } }
  | { name: "notes_exported"; props: { format: NotesFormat; target: "pdf" | "word" } }

  // --- Core product: Knowledge Graph --------------------------------------
  | { name: "graph_build_started"; props?: Record<string, never> }
  | { name: "graph_build_completed"; props: { conceptCount: number; durationMs: number } }
  | { name: "graph_build_failed"; props: { reason: string } }
  /**
   * DELIBERATELY CARRIES NO IDENTIFIER. The obvious design is `{ conceptId }`, and it is wrong
   * here: the id available at the call site is the concept SLUG, and `lib/ai/schemas.ts` is
   * explicit that the slug is model output — derived from the user's own document, so a slug like
   * `photosynthesis-in-c4-plants` is a fragment of their material. A count of opens answers the
   * only question worth asking ("do people explore the graph?") and leaks nothing.
   */
  | { name: "concept_opened"; props?: Record<string, never> }

  // --- Limits, which are a product surface rather than an error ------------
  | { name: "quota_reached"; props?: Record<string, never> };

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/** True only in a browser with a key configured. Every entry point checks it. */
export function analyticsEnabled(): boolean {
  return typeof window !== "undefined" && Boolean(KEY);
}

let started = false;

/**
 * Initialise once. Safe to call repeatedly (React 18 mounts effects twice in development).
 *
 * The options that are NOT defaults are the privacy ones, and each is deliberate:
 *
 *  - `autocapture: false` — autocapture records the text content of clicked elements. In this app
 *    those elements include concept nodes, generated note bodies and quiz options, i.e. the
 *    user's own material and model output. This single flag is the difference between analytics
 *    and a document exfiltration channel, and it is why every event below is explicit.
 *  - `disable_session_recording: true` — session replay would capture the workspace verbatim:
 *    uploaded document text, generated notes, everything. Sentry is already configured WITHOUT
 *    `replayIntegration` for the same reason; turning replay on here would reintroduce the exact
 *    risk that decision avoided.
 *  - `capture_pageview: "history_change"` — the App Router navigates client-side, so the default
 *    (initial load only) would miss every in-app navigation.
 *  - `person_profiles: "identified_only"` — no person profile for anonymous visitors, which keeps
 *    the profile store to real users and avoids paying to profile crawlers.
 */
export function initAnalytics(): void {
  if (!analyticsEnabled() || started) return;
  started = true;

  posthog.init(KEY as string, {
    api_host: HOST,
    autocapture: false,
    disable_session_recording: true,
    capture_pageview: "history_change",
    capture_pageleave: true,
    person_profiles: "identified_only",
    // Respect the browser's Do Not Track signal rather than overriding it.
    respect_dnt: true,
  });
}

/**
 * Record an event. A no-op when analytics is off, so call sites need no guard of their own.
 *
 * Overloaded so events with no properties can be called as `track("demo_opened")`.
 */
export function track(event: AnalyticsEvent): void;
export function track(name: Extract<AnalyticsEvent, { props?: Record<string, never> }>["name"]): void;
export function track(eventOrName: AnalyticsEvent | string): void {
  if (!analyticsEnabled()) return;
  try {
    if (typeof eventOrName === "string") {
      posthog.capture(eventOrName);
      return;
    }
    posthog.capture(eventOrName.name, eventOrName.props);
  } catch {
    // Analytics must never be able to break the product. A failed capture is not worth an error
    // boundary, a retry or a log line the user could see (AGENTS.md rule 4).
  }
}

/**
 * Tie subsequent events to a user.
 *
 * The DISTINCT ID IS THE DATABASE USER ID, never the email address. The id is an opaque key that
 * already exists on both sides; the email is personal data that would then sit in analytics
 * forever, be searchable by anyone with project access, and be exported into every downstream
 * integration. Nothing in the funnel needs it — a user is a unit here, not a person to contact.
 */
export function identifyUser(userId: string): void {
  if (!analyticsEnabled()) return;
  try {
    posthog.identify(userId);
  } catch {
    /* never break the product */
  }
}

/**
 * Clear the identity on sign-out, so the next person to use a shared library machine is not
 * attributed to the previous one.
 */
export function resetAnalytics(): void {
  if (!analyticsEnabled()) return;
  try {
    posthog.reset();
  } catch {
    /* never break the product */
  }
}

/**
 * Map a file name to a coarse `FileKind` at the call site, so the name itself never travels.
 * Exported because several call sites need the same mapping and a second copy would drift.
 */
export function fileKindOf(fileName: string): FileKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  return "other";
}
