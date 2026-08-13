"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  FEEDBACK_RATING_LABELS,
  FEEDBACK_RATINGS,
  FEEDBACK_TYPE_LABELS,
  FEEDBACK_TYPES,
  MAX_MESSAGE_LENGTH,
  feedbackRequestSchema,
  type FeedbackRating,
  type FeedbackSource,
  type FeedbackType,
} from "@/lib/feedback";

/**
 * The workspace feedback entry point: a quiet control in the top bar, a dialog behind it, and a
 * one-line prompt that appears AFTER the user has actually used the product.
 *
 * WHY THE PROMPT IS EVENT-DRIVEN RATHER THAN TIMED. Asking on page load asks people who have not
 * yet seen anything, and the answer is worth nothing. It waits for
 * `edgify:generation-complete`, dispatched by Quick Notes when a generation finishes — the first
 * moment the user has something to have an opinion about. It never interrupts: it is a bar at the
 * bottom, not a modal, and it does not steal focus.
 *
 * WHY THE DISMISSAL IS IN localStorage. The prompt must not reappear once answered or waved away.
 * There is no user-preference table in this schema, and adding one for a single boolean would be
 * a migration, a query module and an extra read on every workspace load — far more than the
 * problem is worth. A localStorage flag is per-browser rather than per-account, which means the
 * worst case is being asked once more on a second device. That is the right trade for a prompt.
 *
 * The dialog reuses the interaction pattern already established by `components/user-menu.tsx`:
 * Escape closes, a pointer press outside dismisses, focus moves in on open and returns to the
 * trigger on close.
 */

/** Dispatched by Quick Notes on a completed generation. See components/notes/quick-notes.tsx. */
export const GENERATION_COMPLETE_EVENT = "edgify:generation-complete";

/** Per-browser, and deliberately not per-account — see the note above. */
const PROMPT_SEEN_KEY = "edgify.feedback.prompted";

type Status = "idle" | "sending" | "sent" | "error";

/** localStorage throws in private modes and when storage is disabled; never break the workspace. */
function markPrompted() {
  try {
    window.localStorage.setItem(PROMPT_SEEN_KEY, "1");
  } catch {
    /* a prompt shown twice is not worth an error */
  }
}

function alreadyPrompted(): boolean {
  try {
    return window.localStorage.getItem(PROMPT_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function FeedbackWidget() {
  const pathname = usePathname();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [promptVisible, setPromptVisible] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [type, setType] = useState<FeedbackType>("general");
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [message, setMessage] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [source, setSource] = useState<FeedbackSource>("workspace");

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const titleId = `${ids}-title`;
  const messageId = `${ids}-message`;
  const errorId = `${ids}-error`;

  const close = useCallback(() => {
    setOpen(false);
    setStatus("idle");
    setFieldError(null);
    triggerRef.current?.focus();
  }, []);

  /** Open from either entry point, recording which one so the two populations stay separable. */
  const openWith = useCallback((from: FeedbackSource, preset?: FeedbackRating | FeedbackType) => {
    setSource(from);
    if (preset && (FEEDBACK_RATINGS as readonly string[]).includes(preset)) {
      setRating(preset as FeedbackRating);
      setType("general");
    } else if (preset) {
      setType(preset as FeedbackType);
    }
    setOpen(true);
  }, []);

  // Wait for the user to have actually used the product before asking anything.
  useEffect(() => {
    if (alreadyPrompted()) return;
    const onDone = () => setPromptVisible(true);
    window.addEventListener(GENERATION_COMPLETE_EVENT, onDone);
    return () => window.removeEventListener(GENERATION_COMPLETE_EVENT, onDone);
  }, []);

  // Escape closes; a press outside dismisses. Listeners rather than blur, so moving between the
  // trigger and the dialog does not close it (the user-menu note applies here too).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (!dialogRef.current?.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  // Focus the field the user came here to fill in.
  useEffect(() => {
    if (open) messageRef.current?.focus();
  }, [open]);

  function dismissPrompt() {
    setPromptVisible(false);
    markPrompted();
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;

    const payload = {
      type,
      ...(rating ? { rating } : {}),
      message,
      source,
      ...(pathname ? { route: pathname } : {}),
    };

    // The same schema the server enforces. Courtesy only — the route re-validates.
    const parsed = feedbackRequestSchema.safeParse(payload);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Tell us a little about what happened.");
      return;
    }

    setFieldError(null);
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) throw new Error("send failed");
      setStatus("sent");
      // Answered counts as prompted: never ask this browser again.
      markPrompted();
      setPromptVisible(false);
      setMessage("");
      setRating(null);
    } catch {
      // No status code, no vendor name (docs/04 §7). Their words stay in the box to retry.
      setStatus("error");
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="fb-trigger"
        onClick={() => openWith("workspace")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
        </svg>
        Feedback
      </button>

      {/* Asked only after a generation has completed, and only once per browser. A bar, not a
          modal: it must never sit on top of the notes the user just generated. */}
      {promptVisible && !open && (
        <div className="fb-prompt" role="status">
          <span className="fb-prompt-q">How is Edgify working for you?</span>
          <div className="fb-prompt-actions">
            {FEEDBACK_RATINGS.map((r) => (
              <button
                key={r}
                type="button"
                className="fb-chip"
                onClick={() => {
                  markPrompted();
                  setPromptVisible(false);
                  openWith("prompt", r);
                }}
              >
                {FEEDBACK_RATING_LABELS[r]}
              </button>
            ))}
            <button
              type="button"
              className="fb-chip"
              onClick={() => {
                markPrompted();
                setPromptVisible(false);
                openWith("prompt", "bug");
              }}
            >
              Report a bug
            </button>
            <button type="button" className="fb-prompt-x" onClick={dismissPrompt} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}

      {open && (
        <div className="fb-overlay">
          <div
            className="fb-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            ref={dialogRef}
          >
            <div className="fb-head">
              <h2 id={titleId}>Send feedback</h2>
              <button type="button" className="fb-close" onClick={close} aria-label="Close">
                ×
              </button>
            </div>

            {status === "sent" ? (
              <div className="fb-sent" role="status">
                <p className="t">Thank you — that landed.</p>
                <p className="d">We read everything sent through here.</p>
                <button type="button" className="fb-submit" onClick={close}>
                  Done
                </button>
              </div>
            ) : (
              <form className="fb-form" onSubmit={submit} noValidate>
                <fieldset className="fb-field">
                  <legend>What kind of feedback?</legend>
                  <div className="fb-chips">
                    {FEEDBACK_TYPES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="fb-chip"
                        aria-pressed={type === t}
                        onClick={() => setType(t)}
                      >
                        {FEEDBACK_TYPE_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="fb-field">
                  <legend>How is it working for you? (optional)</legend>
                  <div className="fb-chips">
                    {FEEDBACK_RATINGS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className="fb-chip"
                        aria-pressed={rating === r}
                        onClick={() => setRating(rating === r ? null : r)}
                      >
                        {FEEDBACK_RATING_LABELS[r]}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div className="fb-field">
                  <label htmlFor={messageId}>Your feedback</label>
                  <textarea
                    id={messageId}
                    ref={messageRef}
                    className="fb-textarea"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={MAX_MESSAGE_LENGTH}
                    rows={5}
                    placeholder="Tell us what happened or what we could improve…"
                    aria-invalid={Boolean(fieldError)}
                    aria-describedby={fieldError ? errorId : undefined}
                  />
                  <p className="fb-count" aria-hidden="true">
                    {message.length}/{MAX_MESSAGE_LENGTH}
                  </p>
                </div>

                {fieldError && (
                  <p className="fb-error" id={errorId} role="alert">
                    {fieldError}
                  </p>
                )}
                {status === "error" && (
                  <p className="fb-error" role="alert">
                    Couldn&apos;t send that just now. Your message is still here — try again in a moment.
                  </p>
                )}

                <button type="submit" className="fb-submit" disabled={status === "sending"}>
                  {status === "sending" ? "Sending…" : "Send feedback"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
