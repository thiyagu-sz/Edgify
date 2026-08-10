import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The account control (top bar, right).
 *
 * Better Auth and the router are the two things this component does not own, so both are mocked
 * at the module boundary: what matters is that logging out calls the EXISTING sign-out and then
 * leaves the workspace, not how either of those is implemented.
 */

const signOut = vi.fn(async () => undefined);
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: () => signOut() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const { UserMenu } = await import("./user-menu");

const EMAIL = "student@example.edu";

beforeEach(() => {
  signOut.mockClear();
  push.mockClear();
  refresh.mockClear();
  signOut.mockImplementation(async () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const trigger = () => screen.getByRole("button", { expanded: false });

describe("the signed-in address is visible and honest", () => {
  it("shows the authenticated email, and again inside the menu", async () => {
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);

    // Visible in the bar itself (the label is hidden by CSS on narrow screens, not removed).
    expect(screen.getByTitle(EMAIL)).toHaveTextContent(EMAIL);

    await user.click(trigger());
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Signed in as");
    expect(menu).toHaveTextContent(EMAIL);
  });

  it("renders whatever address it is given rather than anything baked in", async () => {
    render(<UserMenu email="someone.else@school.org" />);
    expect(screen.getByTitle("someone.else@school.org")).toBeVisible();
    expect(document.body.textContent).not.toContain("student@example.edu");
  });
});

describe("the menu behaves like a menu", () => {
  it("opens, exposes a single Log out item, and reports its state", async () => {
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    const btn = trigger();
    expect(btn).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAccessibleName(/log out/i);
  });

  it("moves focus to the menu on open so the keyboard path works", async () => {
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    await user.click(trigger());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem")),
    );
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    const btn = trigger();
    await user.click(btn);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(btn);
  });

  it("closes when the pointer goes down outside it", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <UserMenu email={EMAIL} />
        <button type="button">elsewhere</button>
      </div>,
    );
    await user.click(trigger());
    expect(screen.getByRole("menu")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("stays open while the pointer moves within it", async () => {
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    await user.click(trigger());
    await user.click(screen.getByText("Signed in as"));
    expect(screen.getByRole("menu")).toBeVisible();
  });
});

describe("logging out uses the existing Better Auth flow", () => {
  it("signs out, then leaves the workspace for the sign-in page", async () => {
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: /log out/i }));

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/sign-in");
    // Without this the cached authenticated render survives and the user still looks signed in.
    expect(refresh).toHaveBeenCalled();
  });

  /**
   * Better Auth's client resolves with `{ error }` rather than rejecting, so this — not a
   * thrown exception — is what a failed sign-out actually looks like. Treating it as success
   * would show the sign-in page while the session was still live.
   */
  it("does not pretend to log out when the server refuses", async () => {
    signOut.mockImplementation(async () => ({ error: { status: 500 } }) as never);
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: /log out/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't log out/i);
    expect(push).not.toHaveBeenCalled();
    // No stack, no status code, no vendor name reaches the user (docs/04 §7).
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/\b500\b|\bstatus\b|better.?auth/i);
    // And it can be retried.
    expect(screen.getByRole("menuitem", { name: /log out/i })).toBeEnabled();
  });

  it("says the same calm thing when the request rejects outright", async () => {
    signOut.mockImplementation(async () => {
      throw new Error("network");
    });
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: /log out/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't log out/i);
    expect(push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/network/i);
  });

  it("cannot be fired twice by an impatient double click", async () => {
    let release: () => void = () => {};
    signOut.mockImplementation(
      () => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }),
    );
    const user = userEvent.setup();
    render(<UserMenu email={EMAIL} />);
    await user.click(trigger());

    const item = screen.getByRole("menuitem", { name: /log out/i });
    await user.click(item);
    expect(screen.getByRole("menuitem")).toBeDisabled();
    release();

    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
});
