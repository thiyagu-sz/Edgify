import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth-credentials";

/**
 * The authentication form.
 *
 * Better Auth and the router are mocked at the module boundary: what matters is that this form
 * calls the EXISTING auth client correctly, never invents credentials handling of its own, and
 * never shows the user anything but the message catalogue (docs/04 §7).
 */

const signInEmail = vi.fn();
const signUpEmail = vi.fn();
const signInSocial = vi.fn();
const push = vi.fn();
const refresh = vi.fn();
let search = new URLSearchParams();

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: (...a: unknown[]) => signInEmail(...a),
      social: (...a: unknown[]) => signInSocial(...a),
    },
    signUp: { email: (...a: unknown[]) => signUpEmail(...a) },
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  useSearchParams: () => search,
}));

const { AuthForm } = await import("./auth-form");

const EMAIL = "student@university.edu";
const PASSWORD = "correct horse battery";

beforeEach(() => {
  vi.clearAllMocks();
  search = new URLSearchParams();
  signInEmail.mockResolvedValue({ data: {}, error: null });
  signUpEmail.mockResolvedValue({ data: {}, error: null });
  signInSocial.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const emailBox = () => screen.getByLabelText("Email");
const passwordBox = () => screen.getByLabelText("Password") as HTMLInputElement;
const submit = (name: RegExp) => screen.getByRole("button", { name });

describe("sign-in with email and password", () => {
  it("calls Better Auth's sign-in and lands in the workspace", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);

    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), PASSWORD);
    await user.click(submit(/^sign in$/i));

    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
    expect(signInEmail).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(push).toHaveBeenCalledWith("/notes");
    expect(refresh).toHaveBeenCalled();
  });

  it("answers a wrong password without revealing whether the account exists", async () => {
    signInEmail.mockResolvedValue({ error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 } });
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);

    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), "wrong-password");
    await user.click(submit(/^sign in$/i));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/don't match an account/i);
    // No oracle: nothing that distinguishes "no such user" from "wrong password".
    expect(alert.textContent).not.toMatch(/not found|no account|doesn't exist|incorrect password/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the user on the page and lets them retry", async () => {
    signInEmail.mockResolvedValue({ error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 } });
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);

    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), "wrong");
    await user.click(submit(/^sign in$/i));
    await screen.findByRole("alert");

    expect(submit(/^sign in$/i)).toBeEnabled();
    expect(emailBox()).toHaveValue(EMAIL);
  });

  it("validates before spending a round trip", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);

    await user.type(emailBox(), "not-an-email");
    await user.type(passwordBox(), PASSWORD);
    await user.click(submit(/^sign in$/i));

    expect(await screen.findByText(/valid email address/i)).toBeVisible();
    expect(signInEmail).not.toHaveBeenCalled();
  });
});

describe("sign-up", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, pw: string, confirm: string) => {
    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), pw);
    await user.type(screen.getByLabelText("Confirm password"), confirm);
  };

  it("creates the account and lands in the workspace", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-up" />);
    await fill(user, PASSWORD, PASSWORD);
    await user.click(submit(/create account/i));

    await waitFor(() => expect(signUpEmail).toHaveBeenCalledTimes(1));
    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL, password: PASSWORD }),
    );
    expect(push).toHaveBeenCalledWith("/notes");
  });

  it("blocks mismatched passwords before calling the server", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-up" />);
    await fill(user, PASSWORD, `${PASSWORD}-typo`);
    await user.click(submit(/create account/i));

    expect(await screen.findByText(/don't match/i)).toBeVisible();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("blocks a short password and states the real minimum", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-up" />);
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    await fill(user, short, short);
    await user.click(submit(/create account/i));

    expect(
      await screen.findByText(`Use at least ${MIN_PASSWORD_LENGTH} characters.`),
    ).toBeVisible();
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("shows the password requirement up front, not only after a failure", () => {
    render(<AuthForm mode="sign-up" />);
    expect(screen.getByText(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)).toBeVisible();
  });

  it("explains a duplicate account and points at signing in", async () => {
    signUpEmail.mockResolvedValue({
      error: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", status: 422 },
    });
    const user = userEvent.setup();
    render(<AuthForm mode="sign-up" />);
    await fill(user, PASSWORD, PASSWORD);
    await user.click(submit(/create account/i));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already associated with an account/i);
  });
});

describe("Google stays the prominent option", () => {
  it("calls the existing social flow with the workspace destination", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() => expect(signInSocial).toHaveBeenCalledTimes(1));
    expect(signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", callbackURL: "/notes" }),
    );
  });

  it("explains an unlinked account instead of showing a raw callback code", async () => {
    search = new URLSearchParams("error=account_not_linked");
    render(<AuthForm mode="sign-in" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already has a password-based account/i);
    expect(alert.textContent).not.toMatch(/account_not_linked|error=|oauth/i);
  });

  it("falls back to a calm message for any other callback error", async () => {
    search = new URLSearchParams("error=invalid_code");
    render(<AuthForm mode="sign-in" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't complete/i);
  });
});

describe("loading states prevent double submission", () => {
  it("disables both buttons while credentials are in flight", async () => {
    let release: (v: unknown) => void = () => {};
    signInEmail.mockImplementation(() => new Promise((r) => { release = r; }));
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);

    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), PASSWORD);
    await user.click(submit(/^sign in$/i));

    expect(await screen.findByRole("button", { name: /signing in…/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /signing in…/i }));
    release({ data: {}, error: null });
    await waitFor(() => expect(signInEmail).toHaveBeenCalledTimes(1));
  });

  it("shows Connecting… while Google is in flight", async () => {
    signInSocial.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(await screen.findByRole("button", { name: /connecting…/i })).toBeDisabled();
  });
});

describe("the password field", () => {
  it("toggles visibility without altering the value", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);
    await user.type(passwordBox(), PASSWORD);
    expect(passwordBox()).toHaveAttribute("type", "password");

    const toggle = screen.getByRole("button", { name: /show password/i });
    await user.click(toggle);
    expect(passwordBox()).toHaveAttribute("type", "text");
    expect(passwordBox()).toHaveValue(PASSWORD);

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(passwordBox()).toHaveAttribute("type", "password");
    expect(passwordBox()).toHaveValue(PASSWORD);
  });

  it("is reachable and operable from the keyboard", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);
    passwordBox().focus();
    await user.tab();

    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");
    expect(passwordBox()).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("carries the right autocomplete for each mode", () => {
    const { unmount } = render(<AuthForm mode="sign-in" />);
    expect(passwordBox()).toHaveAttribute("autocomplete", "current-password");
    unmount();

    render(<AuthForm mode="sign-up" />);
    expect(passwordBox()).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("autocomplete", "new-password");
  });

  it("labels the email field for autofill", () => {
    render(<AuthForm mode="sign-in" />);
    expect(emailBox()).toHaveAttribute("autocomplete", "email");
    expect(emailBox()).toHaveAttribute("type", "email");
  });
});

describe("the password never escapes the form", () => {
  it("is not written to storage, the URL, or the rendered document", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);

    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), PASSWORD);
    await user.click(submit(/^sign in$/i));
    await waitFor(() => expect(signInEmail).toHaveBeenCalled());

    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.search).not.toContain(PASSWORD);
    // Never rendered as text: the value belongs to the input alone, not to the page.
    expect(document.body.textContent ?? "").not.toContain(PASSWORD);
    expect(push).toHaveBeenCalledWith("/notes");
    expect(String(push.mock.calls[0][0])).not.toContain(PASSWORD);
    // Handed to Better Auth and nowhere else — one call, one recipient.
    expect(signInEmail).toHaveBeenCalledTimes(1);
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(signInSocial).not.toHaveBeenCalled();
  });

  it("never renders a server error verbatim", async () => {
    signInEmail.mockResolvedValue({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: 'duplicate key value violates unique constraint "user_email_unique"',
      },
    });
    const user = userEvent.setup();
    render(<AuthForm mode="sign-in" />);
    await user.type(emailBox(), EMAIL);
    await user.type(passwordBox(), PASSWORD);
    await user.click(submit(/^sign in$/i));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/unable to sign in/i);
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/duplicate key|constraint|postgres|500|INTERNAL_SERVER_ERROR/i);
  });
});
