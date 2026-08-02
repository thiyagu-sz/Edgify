import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "@/lib/ai/prompts";
import { installFakeNotesApi } from "@/test/fake-notes-api";
import {
  ALL_PAYLOADS_COMBINED,
  XSS_PAYLOADS,
  assertNoExecutableDom,
  fireDeferredHandlers,
  xssFired,
} from "@/test/xss-payloads";
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

/**
 * Drive the events a real browser would drive, then assert nothing executed and nothing
 * executable survived.
 *
 * The dispatch step is not decoration. jsdom loads no subresources, so an injected
 * `<img src=x>` never errors on its own and its handler is compiled but never invoked; without
 * driving the event, "the sentinel did not fire" would be true of an unsanitised renderer too.
 * The sentinel itself is `document.title`, not `window.__xss` — see test/xss-payloads.ts for the
 * measurement showing why the latter can never fire here.
 */
function expectNothingExecuted(): void {
  fireDeferredHandlers(renderedRoot());
  expect(xssFired(), "injected script executed in the rendered notes").toBeNull();
  expect(() => assertNoExecutableDom(renderedRoot())).not.toThrow();
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

      expectNothingExecuted();
    });
  }

  it("stays safe on every intermediate streaming tick, not just the final one", async () => {
    // Split mid-attribute so a naive per-tick render reassembles a live handler.
    installFakeNotesApi({
      notes: {
        kind: "stream",
        chunks: ["Intro\n\n<img src=x ", "on", "error=", "\"document.title='EDGIFY-XSS:tick'\"", ">\n\ntail"],
      },
    });

    await generateWith("Key Points");

    await waitFor(() => {
      expect(document.querySelector(".prose")).toBeTruthy();
    });
    expectNothingExecuted();
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
    expectNothingExecuted();
  });

  it("neutralises poisoned output rendered underneath the demo banner", async () => {
    installFakeNotesApi({
      notes: { kind: "final", data: ALL_PAYLOADS_COMBINED, tier: "demo", notice: "demo" },
    });

    await generateWith("Short Notes");

    await waitFor(() => {
      expect(screen.getByText(/Showing sample content/)).toBeVisible();
    });
    expectNothingExecuted();
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

      expectNothingExecuted();

      // Answer one question so the explanation surface renders too — it is model output as well.
      const firstOption = document.querySelectorAll(".q-opt")[0] as HTMLButtonElement;
      await user.click(firstOption);

      await waitFor(() => {
        expect(document.querySelector(".q-fb")).toBeTruthy();
      });
    expectNothingExecuted();
    });
  }

  /**
   * CHANGED 2026-08-01, and the change is the point.
   *
   * This used to assert the payload was VISIBLE as literal text — `.q-q` containing the string
   * `<script>` — which was the correct outcome when React escaping was the only defence. Model
   * output is now stripped of markup at the validation seam (`lib/ai/schemas`), upstream of the
   * cache, the database and the clone, so the tag is gone before it is ever stored and the
   * question renders as the question. The surrounding legitimate text survives, which is the
   * property that matters: sanitisation must not cost the user their content.
   */
  it("strips markup from quiz text at the seam, keeping the legitimate content", async () => {
    installFakeNotesApi({
      notes: {
        kind: "final",
        data: {
          questions: [
            {
              q: "<script>document.title='EDGIFY-XSS:q'</script>What is a weight?",
              options: ["<img src=x onerror=\"document.title='EDGIFY-XSS:opt'\">A", "B", "C", "D"],
              answer: 0,
              explanation: "<svg onload=\"document.title='EDGIFY-XSS:exp'\"></svg>Because.",
            },
          ],
        },
      },
    });

    const user = await generateWith("MCQs");

    await waitFor(() => {
      expect(document.querySelector(".q-q")).toBeTruthy();
    });

    // The markup is gone — not escaped-and-shown, removed before it was ever stored.
    expect(document.querySelector(".q-q")?.textContent).not.toContain("<script>");
    expect(document.querySelector(".q-q")?.textContent).not.toContain("document.title");
    // ...the question itself is intact...
    expect(document.querySelector(".q-q")?.textContent).toContain("What is a weight?");
    // ...and no element was produced.
    expect(document.querySelector(".q-q")?.querySelector("script")).toBeNull();
    // The option keeps its visible label even though its payload was removed.
    expect(document.querySelectorAll(".q-opt")[0]?.textContent).toContain("A");

    await user.click(document.querySelectorAll(".q-opt")[0] as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".q-fb")).toBeTruthy());

    expectNothingExecuted();
  });
});
