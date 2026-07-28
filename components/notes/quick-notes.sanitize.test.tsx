import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "@/lib/ai/prompts";
import { installFakeNotesApi } from "@/test/fake-notes-api";
import { ALL_PAYLOADS_COMBINED, XSS_PAYLOADS, assertNoExecutableDom } from "@/test/xss-payloads";
import { QuickNotes } from "./quick-notes";

/**
 * Sanitisation, proven where it actually matters: in the mounted DOM, for EVERY Quick Notes
 * format, across every surface that renders model output.
 *
 * `lib/sanitize.test.ts` proves the sanitiser is correct in isolation. This proves the component
 * routes all model output through it — that no format, and no code path, renders model text some
 * other way. Those are different failures: a perfect sanitiser that one branch forgets to call
 * is still the highest-severity bug in the project (.claude/rules/ui.md).
 *
 * Surfaces covered here:
 *   - streaming prose  (6 markdown formats, rendered via dangerouslySetInnerHTML)
 *   - buffered prose   (cache hit / demo fallback, same innerHTML path)
 *   - quiz            (2 quiz formats: question, options and explanation, React-escaped)
 *   - notice banners  (demo / quota, rendered alongside poisoned content)
 *
 * Export surfaces are covered separately in lib/export.test.ts.
 */

const MD_FORMATS = FORMATS.filter((f) => f.mode === "md");
const QUIZ_FORMATS = FORMATS.filter((f) => f.mode === "quiz");

/** Long enough to clear the client's 200-character minimum. */
const SOURCE = "a".repeat(250);

afterEach(() => {
  vi.restoreAllMocks();
});

async function generateWith(formatLabel: string) {
  const user = userEvent.setup();
  render(<QuickNotes initialRemaining={null} initialLimit={null} />);
  // Paste rather than type: one event instead of 250 keystrokes, and it matches how source
  // material actually arrives in this textarea.
  await user.click(screen.getByRole("textbox"));
  await user.paste(SOURCE);
  await user.click(screen.getByRole("button", { name: formatLabel }));
  await user.click(screen.getByRole("button", { name: /generate revision notes/i }));
  return user;
}

/** The whole rendered tree — banners and output body included. */
function renderedRoot(): HTMLElement {
  return document.body;
}

describe("sanitisation — streaming prose, every markdown format", () => {
  for (const format of MD_FORMATS) {
    it(`neutralises poisoned output for "${format.label}"`, async () => {
      installFakeNotesApi({
        notes: { kind: "stream", chunks: ["## Notes\n\n", ALL_PAYLOADS_COMBINED] },
      });

      await generateWith(format.label);

      await waitFor(() => {
        expect(document.querySelector(".prose")).toBeTruthy();
      });

      expect(window.__xss, "injected script executed in the rendered notes").toBeUndefined();
      expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
    });
  }

  it("stays safe on every intermediate streaming tick, not just the final one", async () => {
    // Split mid-attribute so a naive per-tick render reassembles a live handler.
    installFakeNotesApi({
      notes: {
        kind: "stream",
        chunks: ["Intro\n\n<img src=x ", "on", "error=", "\"window.__xss='tick'\"", ">\n\ntail"],
      },
    });

    await generateWith("Key Points");

    await waitFor(() => {
      expect(document.querySelector(".prose")).toBeTruthy();
    });
    expect(window.__xss).toBeUndefined();
    expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
  });

  it("still renders the legitimate notes around the payload", async () => {
    installFakeNotesApi({
      notes: {
        kind: "stream",
        chunks: ["## Backpropagation\n\n- Chain rule, output to input\n\n", ALL_PAYLOADS_COMBINED],
      },
    });

    await generateWith("Key Points");

    await waitFor(() => {
      expect(screen.getByText(/Chain rule, output to input/)).toBeVisible();
    });
    // Stripping the attack must not cost the user their notes.
    expect(screen.getByRole("heading", { name: "Backpropagation" })).toBeVisible();
  });
});

describe("sanitisation — buffered prose (cache hit / demo fallback)", () => {
  it("neutralises poisoned output arriving as a buffered final", async () => {
    installFakeNotesApi({
      notes: { kind: "final", data: ALL_PAYLOADS_COMBINED, tier: "cache" },
    });

    await generateWith("Summary");

    await waitFor(() => {
      expect(document.querySelector(".prose")).toBeTruthy();
    });
    expect(window.__xss).toBeUndefined();
    expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
  });

  it("neutralises poisoned output rendered underneath the demo banner", async () => {
    installFakeNotesApi({
      notes: { kind: "final", data: ALL_PAYLOADS_COMBINED, tier: "demo", notice: "demo" },
    });

    await generateWith("Short Notes");

    await waitFor(() => {
      expect(screen.getByText(/Showing sample content/)).toBeVisible();
    });
    expect(window.__xss).toBeUndefined();
    expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
  });
});

describe("sanitisation — quiz formats", () => {
  /** A quiz whose every text field carries a payload. */
  function poisonedQuiz() {
    return {
      questions: XSS_PAYLOADS.slice(0, 4).map((p, i) => ({
        q: `Question ${i + 1} ${p.payload}`,
        options: XSS_PAYLOADS.slice(0, 4).map((o) => `Option ${o.payload}`),
        answer: i % 4,
        explanation: `Because ${p.payload}`,
      })),
    };
  }

  for (const format of QUIZ_FORMATS) {
    it(`neutralises poisoned quiz content for "${format.label}"`, async () => {
      installFakeNotesApi({ notes: { kind: "final", data: poisonedQuiz() } });

      const user = await generateWith(format.label);

      await waitFor(() => {
        expect(document.querySelector(".quiz-q")).toBeTruthy();
      });

      expect(window.__xss).toBeUndefined();
      expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();

      // Answer one question so the explanation surface renders too — it is model output as well.
      const firstOption = document.querySelectorAll(".q-opt")[0] as HTMLButtonElement;
      await user.click(firstOption);

      await waitFor(() => {
        expect(document.querySelector(".q-fb")).toBeTruthy();
      });
      expect(window.__xss).toBeUndefined();
      expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
    });
  }

  it("renders quiz payloads as literal text (React escaping), not markup", async () => {
    installFakeNotesApi({
      notes: {
        kind: "final",
        data: {
          questions: [
            {
              q: "<script>window.__xss='q'</script>What is a weight?",
              options: ["<img src=x onerror=\"window.__xss='opt'\">A", "B", "C", "D"],
              answer: 0,
              explanation: "<svg onload=\"window.__xss='exp'\"></svg>Because.",
            },
          ],
        },
      },
    });

    const user = await generateWith("MCQs");

    await waitFor(() => {
      expect(document.querySelector(".q-q")).toBeTruthy();
    });

    // The payload is visible as text — which is the correct, honest outcome.
    expect(document.querySelector(".q-q")?.textContent).toContain("<script>");
    expect(document.querySelector(".q-q")?.textContent).toContain("What is a weight?");
    // ...and produced no elements.
    expect(document.querySelector(".q-q")?.querySelector("script")).toBeNull();

    await user.click(document.querySelectorAll(".q-opt")[0] as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".q-fb")).toBeTruthy());

    expect(window.__xss).toBeUndefined();
    expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
  });
});
