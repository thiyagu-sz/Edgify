"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  fieldErrors,
  MIN_PASSWORD_LENGTH,
  signInSchema,
  signUpSchema,
} from "@/lib/auth-credentials";

/**
 * Google + email/password, in one component so the two screens cannot drift apart.
 *
 * Everything credential-related is delegated to Better Auth's own endpoints through
 * `lib/auth-client` (AGENTS.md: one source of truth for auth). This file never hashes, compares,
 * stores or logs a password: it reads one off the form element at submit time and hands it
 * straight to `authClient`. It is never held in React state — see the note on the refs below.
 */

/** Where both providers land after success — the same destination Google already used. */
const AFTER_AUTH = "/notes";

type Mode = "sign-in" | "sign-up";
type Pending = "google" | "credentials" | null;

/**
 * Better Auth's failure codes → what the user is told (docs/04 §7: plain language, no machinery).
 *
 * `INVALID_EMAIL_OR_PASSWORD` is deliberately answered without saying which was wrong, and
 * without confirming whether the account exists — that answer is an account-existence oracle.
 */
function messageFor(mode: Mode, code: string | undefined, status: number | undefined): string {
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
      return "Those details don't match an account. Check your email and password.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "That email is already associated with an account. Sign in instead.";
    case "PASSWORD_TOO_SHORT":
      return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    case "PASSWORD_TOO_LONG":
      return "That password is too long.";
    case "EMAIL_NOT_VERIFIED":
      return "Confirm your email address before signing in.";
    default:
      if (status === 429) return "Too many attempts. Wait a moment and try again.";
      return mode === "sign-up"
        ? "Unable to create your account. Please try again in a moment."
        : "Unable to sign in. Please try again in a moment.";
  }
}

/**
 * OAuth failures arrive as a redirect back to this page with `?error=`, not as a thrown value.
 *
 * `account_not_linked` is the one that needs a real explanation: it means this Google address
 * already has an email/password account, and Better Auth will not merge them because the local
 * address was never verified (see the account-linking note in lib/auth.ts). Telling the user is
 * safe — completing Google's flow already proved they own the address.
 */
function oauthMessage(error: string | null): string | null {
  if (!error) return null;
  if (error === "account_not_linked") {
    return "This email already has a password-based account. Sign in with your email and password below.";
  }
  return "Google sign-in didn't complete. Please try again.";
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const ids = useId();

  /**
   * The fields are UNCONTROLLED, deliberately, and this is a security decision rather than a
   * style one.
   *
   * React keeps a controlled input's `value` in sync as a DOM ATTRIBUTE, not just as the element
   * property. Verified in Chromium against the production build: with `value={password}`, the
   * typed password appears in `document.body.innerHTML`. Nothing in this project serialises the
   * DOM today — Sentry runs without `replayIntegration` — but anything that ever does (session
   * replay, a DOM snapshot on error) would capture it, and `type="password"` masking would not
   * help while the Show toggle has flipped the field to `type="text"`.
   *
   * Uncontrolled, the value exists only on the element, is read once on submit, and is handed
   * straight to Better Auth. Nothing here needs to re-render as the user types, so this costs
   * nothing.
   */
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isSignUp = mode === "sign-up";
  // An OAuth error survives until the user acts; a form error replaces it.
  const banner = formError ?? oauthMessage(params.get("error"));
  const busy = pending !== null;

  const emailId = `${ids}-email`;
  const passwordId = `${ids}-password`;
  const confirmId = `${ids}-confirm`;
  const bannerId = `${ids}-banner`;

  async function onGoogle() {
    if (busy) return;
    setPending("google");
    setFormError(null);
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: AFTER_AUTH,
        // Without this, a failed callback lands on Better Auth's own /error route, which this
        // app does not serve. Send it back here where the message can be explained instead.
        errorCallbackURL: mode === "sign-up" ? "/sign-up" : "/sign-in",
      });
      // On success the browser has already left for Google; nothing below runs.
    } catch {
      setPending(null);
      setFormError("Unable to reach Google right now. Please try again in a moment.");
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;

    // Read once, here. The values are never copied into component state.
    const email = emailRef.current?.value ?? "";
    const password = passwordRef.current?.value ?? "";
    const confirmPassword = confirmRef.current?.value ?? "";

    const parsed = isSignUp
      ? signUpSchema.safeParse({ email, password, confirmPassword })
      : signInSchema.safeParse({ email, password });

    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      setFormError(null);
      return;
    }

    setErrors({});
    setFormError(null);
    setPending("credentials");

    // Better Auth's client resolves with `{ error }` rather than rejecting, so the result has to
    // be inspected — a bare await would read every failure as a success.
    const result = isSignUp
      ? await authClient.signUp.email({
          email: parsed.data.email,
          password: parsed.data.password,
          // Better Auth requires a name. The address is the only thing asked for, so its local
          // part stands in until the user has somewhere to change it.
          name: parsed.data.email.split("@")[0] || parsed.data.email,
        })
      : await authClient.signIn.email({
          email: parsed.data.email,
          password: parsed.data.password,
        });

    if (result?.error) {
      setPending(null);
      setFormError(messageFor(mode, result.error.code, result.error.status));
      return;
    }

    router.push(AFTER_AUTH);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="auth-google"
        onClick={() => void onGoogle()}
        disabled={busy}
      >
        <GoogleMark />
        {pending === "google" ? "Connecting…" : "Continue with Google"}
      </button>

      <div className="auth-or">
        <span>or</span>
      </div>

      {banner && (
        <p className="auth-error" id={bannerId} role="alert">
          {banner}
        </p>
      )}

      <form className="auth-fields" onSubmit={onSubmit} noValidate>
        <div className="auth-field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            ref={emailRef}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            disabled={busy}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? `${emailId}-err` : undefined}
            placeholder="you@university.edu"
          />
          {errors.email && (
            <p className="auth-hint err" id={`${emailId}-err`}>
              {errors.email}
            </p>
          )}
        </div>

        <div className="auth-field">
          <label htmlFor={passwordId}>Password</label>
          <div className="auth-pw">
            <input
              id={passwordId}
              ref={passwordRef}
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete={isSignUp ? "new-password" : "current-password"}
              disabled={busy}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={
                errors.password ? `${passwordId}-err` : isSignUp ? `${passwordId}-hint` : undefined
              }
            />
            {/* Toggles the input's type only; the value is never copied, stored or transformed. */}
            <button
              type="button"
              className="auth-pw-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-controls={passwordId}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          {errors.password ? (
            <p className="auth-hint err" id={`${passwordId}-err`}>
              {errors.password}
            </p>
          ) : isSignUp ? (
            <p className="auth-hint" id={`${passwordId}-hint`}>
              Use at least {MIN_PASSWORD_LENGTH} characters.
            </p>
          ) : null}
        </div>

        {isSignUp && (
          <div className="auth-field">
            <label htmlFor={confirmId}>Confirm password</label>
            <input
              id={confirmId}
              ref={confirmRef}
              name="confirmPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              disabled={busy}
              aria-invalid={Boolean(errors.confirmPassword)}
              aria-describedby={errors.confirmPassword ? `${confirmId}-err` : undefined}
            />
            {errors.confirmPassword && (
              <p className="auth-hint err" id={`${confirmId}-err`}>
                {errors.confirmPassword}
              </p>
            )}
          </div>
        )}

        <button type="submit" className="auth-submit" disabled={busy}>
          {pending === "credentials"
            ? isSignUp
              ? "Creating account…"
              : "Signing in…"
            : isSignUp
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
    </>
  );
}

/**
 * Google's four-colour "G". Drawn from Google's published brand paths rather than approximated,
 * because an invented lookalike is both wrong and a trademark problem.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 010-3.44V4.95H.96a9 9 0 000 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
