import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_NOTES } from "@/lib/demo/notes";
import { installFakeNotesApi } from "@/test/fake-notes-api";
import { QuickNotes } from "./quick-notes";

/**
 * Quota as a product surface (docs/04 §5, .claude/rules/ui.md; Phase 4: "approaching quota shows
 * the counter; reaching it shows the friendly state").
 *
 * "You've used today's generations" is a fact about a budget. "Error: quota exceeded" is a
 * failure. Same information, completely different feeling — so these tests assert the FEELING as
 * much as the numbers: what is visible, how it is worded, and that hitting the limit still
 * leaves the user with something usable rather than a dead end.
 */

const SOURCE = "a".repeat(250);

afterEach(() => {
  vi.restoreAllMocks();
});

function counterText(): string | null {
  return document.querySelector(".quota-note")?.textContent ?? null;
}

describe("quota counter — visibility thresholds", () => {
  it("shows nothing well below the limit", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={25} initialLimit={30} />);
    expect(counterText()).toBeNull();
  });

  it("shows nothing just below the 80% line", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={7} initialLimit={30} />);
    expect(counterText()).toBeNull();
  });

  it("shows a quiet counter at 80% used", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={6} initialLimit={30} />);
    expect(counterText()).toBe("6 generations left today");
    // Quiet: it is a note beside the button, not a banner or an alert.
    expect(document.querySelector(".quota-note")).toBeVisible();
    expect(document.querySelector(".notice-banner")).toBeNull();
    expect(document.querySelector(".errbox")).toBeNull();
  });

  it("uses the singular on the last generation", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={1} initialLimit={30} />);
    expect(counterText()).toBe("1 generation left today");
  });

  it("shows the friendly state at zero, with the reset time", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={0} initialLimit={30} />);

    const text = counterText() ?? "";
    expect(text).toContain("You've used today's generations");
    expect(text).toContain("resets at midnight");
    expect(document.querySelector(".quota-note")).toHaveClass("exhausted");
  });

  it("hides the counter when usage is unknown rather than guessing", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={null} initialLimit={null} />);
    expect(counterText()).toBeNull();
  });
});

describe("quota copy is never an error", () => {
  const levels: [string, number][] = [
    ["at 80%", 6],
    ["at one left", 1],
    ["exhausted", 0],
  ];

  for (const [name, remaining] of levels) {
    it(`reads as a budget, not a failure: ${name}`, () => {
      installFakeNotesApi({ notes: { kind: "busy" } });
      render(<QuickNotes initialRemaining={remaining} initialLimit={30} />);

      const text = counterText() ?? "";
      expect(text.length).toBeGreaterThan(0);
      for (const forbidden of [
        /error/i,
        /exceeded/i,
        /denied/i,
        /forbidden/i,
        /too many/i,
        /limit reached/i,
        /\b429\b/,
        /rate.?limit/i,
      ]) {
        expect(text, `quota copy used failure language: ${forbidden}`).not.toMatch(forbidden);
      }
    });
  }

  it("does not disable generation just because the counter is showing", () => {
    installFakeNotesApi({ notes: { kind: "busy" } });
    render(<QuickNotes initialRemaining={0} initialLimit={30} />);
    // Reaching the limit routes to demo content server-side; the button stays live so the user
    // still gets a worked example rather than a wall.
    expect(screen.getByRole("button", { name: /generate revision notes/i })).toBeEnabled();
  });
});

describe("quota refresh after a generation", () => {
  it("re-reads the counter when a generation completes", async () => {
    const user = userEvent.setup();
    const api = installFakeNotesApi({
      notes: { kind: "stream", chunks: ["## Notes\n\n- a point"] },
      usage: { remaining: 5, limit: 30 },
    });
    render(<QuickNotes initialRemaining={6} initialLimit={30} />);
    expect(counterText()).toBe("6 generations left today");

    await user.click(screen.getByRole("textbox"));
    await user.paste(SOURCE);
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    await waitFor(() => expect(counterText()).toBe("5 generations left today"));
    expect(api.calls.some((c) => c.includes("/api/usage"))).toBe(true);
  });

  it("leaves the counter alone when the usage read fails", async () => {
    const user = userEvent.setup();
    installFakeNotesApi({
      notes: { kind: "stream", chunks: ["## Notes\n\n- a point"] },
      usage: { fail: true },
    });
    render(<QuickNotes initialRemaining={6} initialLimit={30} />);

    await user.click(screen.getByRole("textbox"));
    await user.paste(SOURCE);
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    await waitFor(() => expect(screen.getByText("a point")).toBeVisible());
    // A failed counter refresh is a nicety failing, and must not disturb the page.
    expect(counterText()).toBe("6 generations left today");
    expect(document.querySelector(".errbox")).toBeNull();
  });
});

describe("exhausted quota is not a dead end", () => {
  it("still returns usable content, labelled with the quota banner", async () => {
    const user = userEvent.setup();
    installFakeNotesApi({
      notes: { kind: "final", data: DEMO_NOTES.key_points, tier: "demo", notice: "quota" },
      usage: { remaining: 0, limit: 30 },
    });
    render(<QuickNotes initialRemaining={0} initialLimit={30} />);

    await user.click(screen.getByRole("textbox"));
    await user.paste(SOURCE);
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    // The phrase appears twice by design: the standing counter beside the Generate button
    // (docs/04 §5) and the banner labelling this specific result (§2). Scope to the banner.
    await waitFor(() => {
      const banner = document.querySelector(".notice-banner");
      expect(banner).toBeVisible();
      expect(banner?.textContent).toContain("You've used today's generations");
    });
    expect(document.querySelector(".notice-banner")?.textContent).toContain(
      "Here's a worked example in the meantime",
    );

    // Real, complete content — and every tool still works on it.
    const prose = document.querySelector(".prose")?.textContent ?? "";
    expect(prose).toContain("Backpropagation uses the chain rule");
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /pdf/i })).toBeEnabled();

    // The banner explains; the failure box never appears.
    expect(document.querySelector(".notice-banner")).toBeVisible();
    expect(document.querySelector(".errbox")).toBeNull();
    expect(document.querySelector(".spin")).toBeNull();
  });
});
