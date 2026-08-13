import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_LENGTH } from "@/lib/feedback";
import { FeedbackWidget, GENERATION_COMPLETE_EVENT } from "./feedback-widget";

/**
 * The feedback widget.
 *
 * Two properties carry most of the value, and both are about NOT being annoying:
 *
 *  1. The prompt appears only after the user has actually generated something — asking on page
 *     load asks someone who has seen nothing, and the answer is worth nothing.
 *  2. Once answered or waved away it never comes back. A prompt that reappears on every
 *     navigation is worse than no prompt at all.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/notes" }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The signal Quick Notes emits when a generation finishes. */
const completeAGeneration = () =>
  window.dispatchEvent(new CustomEvent(GENERATION_COMPLETE_EVENT));

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /feedback/i }));
  return screen.getByRole("dialog");
};

describe("the entry point", () => {
  it("shows a feedback control in the workspace chrome", () => {
    render(<FeedbackWidget />);
    expect(screen.getByRole("button", { name: /feedback/i })).toBeInTheDocument();
  });

  it("opens a labelled modal dialog", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);

    const dialog = await openDialog(user);

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: /send feedback/i })).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    await openDialog(user);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /feedback/i }));
  });
});

describe("submitting", () => {
  it("sends the chosen type, rating and message to the API", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    await openDialog(user);

    await user.click(screen.getByRole("button", { name: "Something is broken" }));
    await user.click(screen.getByRole("button", { name: "Needs work" }));
    await user.type(screen.getByLabelText(/your feedback/i), "Upload spins forever.");
    await user.click(screen.getByRole("button", { name: /send feedback/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      type: "bug",
      rating: "needs_improvement",
      message: "Upload spins forever.",
      source: "workspace",
      route: "/notes",
    });
  });

  it("never sends a userId — the server derives it from the session", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    await openDialog(user);
    await user.type(screen.getByLabelText(/your feedback/i), "Looks good.");
    await user.click(screen.getByRole("button", { name: /send feedback/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body)).not.toContain("userId");
    expect(Object.keys(body)).not.toContain("status");
  });

  it("blocks an empty message before spending a round trip", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    await openDialog(user);

    await user.click(screen.getByRole("button", { name: /send feedback/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a calm failure and keeps the user's words", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    await openDialog(user);
    await user.type(screen.getByLabelText(/your feedback/i), "Something broke.");
    await user.click(screen.getByRole("button", { name: /send feedback/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't send/i);
    // No status code, no vendor name (docs/04 §7).
    expect(alert.textContent).not.toMatch(/500|error|failed to fetch/i);
    expect(screen.getByLabelText(/your feedback/i)).toHaveValue("Something broke.");
  });

  it("caps the message at the shared limit", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    await openDialog(user);
    expect(screen.getByLabelText(/your feedback/i)).toHaveAttribute(
      "maxlength",
      String(MAX_MESSAGE_LENGTH),
    );
  });
});

describe("the post-generation prompt", () => {
  it("is absent until the user has actually generated something", () => {
    render(<FeedbackWidget />);
    expect(screen.queryByText(/how is edgify working/i)).not.toBeInTheDocument();
  });

  it("appears after a generation completes", async () => {
    render(<FeedbackWidget />);
    completeAGeneration();
    expect(await screen.findByText(/how is edgify working/i)).toBeInTheDocument();
  });

  it("does not come back once dismissed, even after another generation", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FeedbackWidget />);
    completeAGeneration();
    await screen.findByText(/how is edgify working/i);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/how is edgify working/i)).not.toBeInTheDocument();

    // A fresh mount is what a navigation looks like — the prompt must stay gone.
    unmount();
    render(<FeedbackWidget />);
    completeAGeneration();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/how is edgify working/i)).not.toBeInTheDocument();
  });

  it("does not come back after feedback has been submitted", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FeedbackWidget />);
    completeAGeneration();
    await screen.findByText(/how is edgify working/i);

    await user.click(screen.getByRole("button", { name: "Good" }));
    await user.type(screen.getByLabelText(/your feedback/i), "Works well.");
    await user.click(screen.getByRole("button", { name: /send feedback/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unmount();
    render(<FeedbackWidget />);
    completeAGeneration();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/how is edgify working/i)).not.toBeInTheDocument();
  });

  it("records that the submission came from the prompt", async () => {
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    completeAGeneration();
    await screen.findByText(/how is edgify working/i);

    // Choosing a rating in the prompt opens the dialog carrying that answer through.
    await user.click(screen.getByRole("button", { name: "Good" }));
    await user.type(screen.getByLabelText(/your feedback/i), "Fast and clear.");
    await user.click(screen.getByRole("button", { name: /send feedback/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source).toBe("prompt");
    expect(body.rating).toBe("good");
  });

  it("survives localStorage being unavailable", async () => {
    // Private-mode browsers throw on setItem. The workspace must not break over a prompt.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => { throw new Error("denied"); });
    const user = userEvent.setup();
    render(<FeedbackWidget />);
    completeAGeneration();
    await screen.findByText(/how is edgify working/i);

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(/how is edgify working/i)).not.toBeInTheDocument();
    setItem.mockRestore();
  });
});
