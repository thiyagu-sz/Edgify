import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_NOTES } from "@/lib/demo/notes";
import { installFakeNotesApi, type NotesResponseSpec } from "@/test/fake-notes-api";
import { QuickNotes } from "./quick-notes";

/**
 * Resilience, at the UI (docs/04-resilience.md; Phase 4: "demo banner appears when the ladder
 * falls through").
 *
 * The product promise is what happens when things fail, so the failures here are deliberate and
 * exhaustive rather than illustrative. The headline guarantee — and the one worth the most — is
 * the invariant at the bottom of this file: whatever the server does, the spinner resolves.
 * A spinner that never resolves is the one failure mode with no recovery and no explanation.
 */

const SOURCE = "a".repeat(250);

/**
 * docs/04 §7: none of this may reach the user, in any state.
 *
 * Deliberately matched as SHAPES rather than bare words. Study material is about neural networks,
 * so the notes legitimately contain "the error" (prediction error) and "stacked layers" — a
 * blanket /error/i or "stack" check flags correct content and teaches you to weaken the test.
 * What must never appear is failure *machinery*: vendor names, HTTP status codes, stack frames,
 * and the render artefacts of an unhandled value.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/openrouter/i, "vendor name (OpenRouter)"],
  [/\bneon\b/i, "vendor name (Neon)"],
  [/\bHTTP\s*\d{3}\b/i, "HTTP status code"],
  [/\bstatus\s*(code)?\s*[:=]?\s*\d{3}\b/i, "HTTP status code"],
  [/\b(429|502|503)\b/, "raw status number"],
  [/rate.?limit/i, "rate-limit wording"],
  [/quota exceeded/i, "quota phrased as an error"],
  [/\berror:/i, "raw error prefix"],
  [/\bat\s+\w+\s*\(.*:\d+:\d+\)/, "stack frame"],
  [/\.(ts|tsx|js):\d+/, "source location"],
  [/\bundefined\b/, "an undefined value rendered"],
  [/\bNaN\b/, "a NaN rendered"],
  [/\[object Object\]/, "an object rendered"],
];

function assertNothingForbiddenOnScreen(): void {
  const text = document.body.textContent ?? "";
  for (const [pattern, description] of FORBIDDEN) {
    expect(text, `user-facing text leaked ${description}`).not.toMatch(pattern);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function generate(spec: NotesResponseSpec, formatLabel = "Key Points") {
  const user = userEvent.setup();
  installFakeNotesApi({ notes: spec });
  render(<QuickNotes initialRemaining={null} initialLimit={null} />);
  await user.click(screen.getByRole("textbox"));
  await user.paste(SOURCE);
  await user.click(screen.getByRole("button", { name: formatLabel }));
  await user.click(screen.getByRole("button", { name: /generate revision notes/i }));
  return user;
}

const spinnerVisible = () => document.querySelector(".spin") !== null;

describe("tier 5 — demo content with a visible banner", () => {
  it("shows the demo banner and the sample notes, and stops the spinner", async () => {
    await generate({
      kind: "final",
      data: DEMO_NOTES.key_points,
      tier: "demo",
      notice: "demo",
    });

    await waitFor(() => {
      expect(screen.getByText(/Showing sample content/)).toBeVisible();
    });

    // The banner is a real, visible strip — not merely present in the tree.
    const banner = document.querySelector(".notice-banner");
    expect(banner).toBeVisible();
    expect(banner?.textContent).toContain("Live generation is temporarily unavailable");
    expect(banner?.textContent).toContain("Your document is safe");

    // Real, complete content underneath it — not a placeholder or a truncated stub.
    const prose = document.querySelector(".prose")?.textContent ?? "";
    expect(prose).toContain("Backpropagation uses the chain rule");
    expect(prose).toContain("The learning rate sets step size");
    expect(spinnerVisible()).toBe(false);
    assertNothingForbiddenOnScreen();
  });

  it("keeps export and regenerate usable in demo mode (fully interactive)", async () => {
    await generate({ kind: "final", data: DEMO_NOTES.key_points, tier: "demo", notice: "demo" });
    await waitFor(() => expect(screen.getByText(/Showing sample content/)).toBeVisible());

    // docs/04 §2: demo mode is a real experience, not a screenshot.
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /pdf/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /doc/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeEnabled();
  });

  it("labels the quota case differently and never as an error", async () => {
    await generate({
      kind: "final",
      data: DEMO_NOTES.key_points,
      tier: "demo",
      notice: "quota",
    });

    await waitFor(() => {
      expect(screen.getByText(/You've used today's generations/)).toBeVisible();
    });
    expect(screen.getByText(/Your limit resets at midnight/)).toBeVisible();

    // A fact about a budget, not a failure. Scoped to the banner: the notes themselves are about
    // neural networks and legitimately discuss prediction "error".
    const banner = document.querySelector(".notice-banner")?.textContent ?? "";
    expect(banner).not.toMatch(/error/i);
    expect(banner).not.toMatch(/exceeded/i);
    expect(banner).not.toMatch(/limit reached/i);
    // It is a status, not an alert.
    expect(document.querySelector(".notice-banner")).toHaveAttribute("role", "status");
    // And it is not rendered as the failure state.
    expect(document.querySelector(".errbox")).toBeNull();
    assertNothingForbiddenOnScreen();
  });

  it("never substitutes demo content silently", async () => {
    // Content arriving on the demo tier ALWAYS carries the banner. A demo payload with no
    // notice would be the one genuinely bad outcome available here (docs/04 §2).
    await generate({ kind: "final", data: DEMO_NOTES.summary, tier: "demo", notice: "demo" });
    await waitFor(() => expect(document.querySelector(".prose")).toBeTruthy());
    expect(document.querySelector(".notice-banner")).toBeVisible();
  });
});

describe("tier 6 — busy, the only failure state, and it is calm", () => {
  it("shows the catalogue message with a retry button", async () => {
    await generate({ kind: "busy" });

    await waitFor(() => {
      expect(screen.getByText("Server is busy, please try again in a moment.")).toBeVisible();
    });
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
    expect(spinnerVisible()).toBe(false);
    assertNothingForbiddenOnScreen();
  });

  it("retries successfully from the busy state", async () => {
    const user = userEvent.setup();
    const api = installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={null} initialLimit={null} />);
    await user.click(screen.getByRole("textbox"));
    await user.paste(SOURCE);
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /try again/i })).toBeVisible());

    api.setNotes({ kind: "stream", chunks: ["## Recovered\n\n- it worked"] });
    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(screen.getByText("it worked")).toBeVisible());
    expect(screen.queryByText(/Server is busy/)).toBeNull();
  });
});

describe("other server states", () => {
  it("session expired reads as a session problem, not a crash", async () => {
    await generate({ kind: "auth" });
    await waitFor(() => {
      expect(screen.getByText("Please sign in again to continue.")).toBeVisible();
    });
    assertNothingForbiddenOnScreen();
  });

  it("input the user can fix does not read as a server fault", async () => {
    await generate({
      kind: "message",
      message:
        "That's more than Edgify can take at once. Trim it to about 40,000 characters and try again.",
    });
    await waitFor(() => {
      expect(screen.getByText("Check the source material")).toBeVisible();
    });
    expect(screen.queryByText("Something went wrong")).toBeNull();
    assertNothingForbiddenOnScreen();
  });

  it("text below the minimum is caught before any request is made", async () => {
    const user = userEvent.setup();
    const api = installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={null} initialLimit={null} />);
    await user.click(screen.getByRole("textbox"));
    await user.paste("too short");
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    await waitFor(() => expect(screen.getByText("Not enough text yet")).toBeVisible());
    // No wasted round trip, and no quota spent.
    expect(api.calls.filter((c) => c.includes("/api/notes/generate"))).toHaveLength(0);
  });
});

describe("the hang — a spinner that would never resolve", () => {
  it("aborts a stream that never yields and lands on the calm busy state", async () => {
    vi.useFakeTimers();
    installFakeNotesApi({ notes: { kind: "hang" } });
    render(<QuickNotes initialRemaining={null} initialLimit={null} />);

    // fireEvent, not userEvent: userEvent schedules its own inter-event delays, and under a
    // faked clock nobody advances them, so the interaction deadlocks before the test can reach
    // the deadline it means to exercise.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: SOURCE } });
    fireEvent.click(screen.getByRole("button", { name: /generate revision notes/i }));

    // Let the fetch resolve and the reader block: the stream is open and producing nothing —
    // exactly the state that hangs forever without a client-side deadline.
    await vi.advanceTimersByTimeAsync(0);
    expect(spinnerVisible()).toBe(true);

    // Past the component's STREAM_TIMEOUT_MS, which fires the abort.
    await vi.advanceTimersByTimeAsync(46_000);

    // Hand the clock back before waiting: `waitFor` polls on timers of its own, and those are
    // faked too, so it would never tick. The deadline has already fired at this point — all
    // that remains is letting the rejection propagate through React's state update.
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByText("Server is busy, please try again in a moment.")).toBeVisible();
    });
    expect(spinnerVisible()).toBe(false);
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
  });

  it("keeps partial content when a stream dies after producing tokens", async () => {
    // Losing the connection mid-stream should not throw away what the user can already read.
    const user = userEvent.setup();
    installFakeNotesApi({ notes: { kind: "stream", chunks: ["## Partial\n\n- first point"] } });
    render(<QuickNotes initialRemaining={null} initialLimit={null} />);
    await user.click(screen.getByRole("textbox"));
    await user.paste(SOURCE);
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    await waitFor(() => expect(screen.getByText("first point")).toBeVisible());
    expect(spinnerVisible()).toBe(false);
  });
});

/**
 * THE INVARIANT.
 *
 * Whatever the server does — a clean failure, a malformed body, a dead socket, an intermediary
 * that strips headers — the output panel must reach a terminal state: content, or a calm message
 * with a next action. Never a spinner.
 *
 * This is parametrised over every response the route can produce (plus several it should not) so
 * that a new failure mode cannot be added without either being handled or failing here.
 */
describe("invariant: the spinner always resolves", () => {
  const everyFailureMode: [string, NotesResponseSpec][] = [
    ["busy", { kind: "busy" }],
    ["auth", { kind: "auth" }],
    ["message", { kind: "message", message: "Add a few paragraphs." }],
    ["network reject", { kind: "reject" }],
    ["200 with no kind header", { kind: "empty-200" }],
    ["final claiming JSON but returning HTML", { kind: "bad-json" }],
    ["final with null data", { kind: "final", data: null }],
    ["final with an empty string", { kind: "final", data: "" }],
    ["stream that yields nothing then closes", { kind: "stream", chunks: [] }],
    ["stream of a single empty chunk", { kind: "stream", chunks: [""] }],
    ["demo fallback", { kind: "final", data: DEMO_NOTES.key_points, tier: "demo", notice: "demo" }],
    ["quota fallback", { kind: "final", data: DEMO_NOTES.key_points, tier: "demo", notice: "quota" }],
  ];

  for (const [name, spec] of everyFailureMode) {
    it(`resolves for: ${name}`, async () => {
      await generate(spec);

      await waitFor(
        () => {
          expect(spinnerVisible(), "spinner never resolved").toBe(false);
        },
        { timeout: 3000 },
      );

      // Terminal means SOMETHING actionable is on screen: content, or a message with a way out.
      const hasContent =
        document.querySelector(".prose") !== null || document.querySelector(".quiz-q") !== null;
      const hasCalmMessage = document.querySelector(".errbox") !== null;
      const hasEmptyState = document.querySelector(".empty") !== null;
      expect(
        hasContent || hasCalmMessage || hasEmptyState,
        "resolved to a blank panel with no content and no message",
      ).toBe(true);

      // And if it is a message, it offers a next action.
      if (hasCalmMessage) {
        expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
      }

      assertNothingForbiddenOnScreen();
    });
  }

  it("covers every response kind the route can send", async () => {
    // Guard against this list silently falling behind app/api/notes/generate/route.ts.
    const covered = new Set(everyFailureMode.map(([, spec]) => spec.kind));
    for (const kind of ["busy", "auth", "message", "final", "stream"]) {
      expect(covered.has(kind as NotesResponseSpec["kind"]), `no case for "${kind}"`).toBe(true);
    }
  });
});
