import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeNotesApi } from "@/test/fake-notes-api";
import { QuickNotes } from "./quick-notes";

/**
 * Quiz behaviour (Phase 4: "quiz scores correctly and shows explanations", and quiz formats
 * validate before render).
 *
 * Two distinct guarantees are proven here:
 *  1. A well-formed quiz grades correctly, live, and reveals the right answer and explanation.
 *  2. A malformed quiz degrades to a calm, actionable state — never a crash, never a blank
 *     panel, never a half-rendered question (docs/04 §3).
 */

const SOURCE = "a".repeat(250);

const GOOD_QUIZ = {
  questions: [
    {
      q: "What does a nonlinear activation let a network do?",
      options: ["Model nonlinear relationships", "Skip the loss", "Avoid training", "Drop weights"],
      answer: 0,
      explanation: "Stacked linear layers collapse into a single linear map.",
    },
    {
      q: "What does the loss function measure?",
      options: ["Layer count", "Prediction error", "Learning rate", "Batch size"],
      answer: 1,
      explanation: "Training minimises this measure of error.",
    },
    {
      q: "Backpropagation applies the…",
      options: ["Chain rule", "Matrix inverse", "Softmax", "Random search"],
      answer: 0,
      explanation: "Gradients propagate backward using the chain rule.",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function generateQuiz(data: unknown, formatLabel = "MCQs") {
  const user = userEvent.setup();
  installFakeNotesApi({ notes: { kind: "final", data } });
  render(<QuickNotes initialRemaining={null} initialLimit={null} />);
  await user.click(screen.getByRole("textbox"));
  await user.paste(SOURCE);
  await user.click(screen.getByRole("button", { name: formatLabel }));
  await user.click(screen.getByRole("button", { name: /generate revision notes/i }));
  return user;
}

function questionCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".quiz-q"));
}

function score(): string {
  return document.querySelector(".quiz-score .rs")?.textContent?.trim() ?? "";
}

describe("quiz — live scoring", () => {
  it("renders every question with its options, unanswered", async () => {
    await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));

    expect(score()).toBe("0 / 3");
    expect(screen.getByText("Quiz progress")).toBeVisible();
    for (const card of questionCards()) {
      expect(within(card).getAllByRole("button")).toHaveLength(4);
    }
  });

  it("scores a correct answer and shows its explanation", async () => {
    const user = await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));

    const first = questionCards()[0];
    await user.click(within(first).getAllByRole("button")[0]); // the correct option

    await waitFor(() => expect(score()).toBe("1 / 3"));
    const feedback = first.querySelector(".q-fb");
    expect(feedback).toBeVisible();
    expect(feedback?.textContent).toContain("Correct.");
    expect(feedback?.textContent).toContain("collapse into a single linear map");
    expect(within(first).getAllByRole("button")[0].className).toContain("correct");
  });

  it("marks a wrong answer, reveals the correct one, and still explains", async () => {
    const user = await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));

    const first = questionCards()[0];
    const options = within(first).getAllByRole("button");
    await user.click(options[2]); // wrong

    await waitFor(() => expect(first.querySelector(".q-fb")).toBeTruthy());
    expect(score()).toBe("0 / 3");
    expect(options[2].className).toContain("wrong");
    // The right answer must be shown, or a wrong answer teaches nothing.
    expect(options[0].className).toContain("correct");
    expect(first.querySelector(".q-fb")?.textContent).toContain("Not quite.");
    expect(first.querySelector(".q-fb")?.textContent).toContain("single linear map");
  });

  it("locks a question after it is answered", async () => {
    const user = await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));

    const first = questionCards()[0];
    const options = within(first).getAllByRole("button");
    await user.click(options[1]); // wrong
    await waitFor(() => expect(score()).toBe("0 / 3"));

    // Clicking the correct option afterwards must not retroactively award a point.
    await user.click(options[0]);
    expect(score()).toBe("0 / 3");
    for (const option of options) expect(option).toBeDisabled();
  });

  it("tracks a full run and switches to the final score", async () => {
    const user = await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));

    const cards = questionCards();
    await user.click(within(cards[0]).getAllByRole("button")[0]); // correct
    await user.click(within(cards[1]).getAllByRole("button")[3]); // wrong
    await user.click(within(cards[2]).getAllByRole("button")[0]); // correct

    await waitFor(() => expect(score()).toBe("2 / 3"));
    expect(screen.getByText("Final score")).toBeVisible();
  });

  it("does not offer Copy for a quiz, but does offer PDF and DOC", async () => {
    await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));

    // Matches the prototype: Copy is markdown-only.
    expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /pdf/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /doc/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeVisible();
  });

  it("resets scoring when a new quiz is generated", async () => {
    const user = await generateQuiz(GOOD_QUIZ);
    await waitFor(() => expect(questionCards()).toHaveLength(3));
    await user.click(within(questionCards()[0]).getAllByRole("button")[0]);
    await waitFor(() => expect(score()).toBe("1 / 3"));

    await user.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(score()).toBe("0 / 3"));
    for (const card of questionCards()) {
      expect(card.querySelector(".q-fb")).toBeNull();
    }
  });
});

describe("quiz — malformed output degrades cleanly", () => {
  /**
   * The client re-validates with sanitizeQuiz even though the server already did (defence in
   * depth). Each of these must land on the calm "unexpected format" state with a retry — not a
   * crash, not an empty panel, and not a partially-rendered question.
   */
  const malformed: [string, unknown][] = [
    ["empty questions array", { questions: [] }],
    ["questions not an array", { questions: "nope" }],
    ["missing questions key", { items: [] }],
    ["a bare string", "here are your questions"],
    ["null", null],
    ["every answer index out of range", { questions: [{ q: "Q", options: ["a", "b"], answer: 9 }] }],
    ["question missing options", { questions: [{ q: "Q", answer: 0 }] }],
    ["markdown returned for a quiz format", "## Key points\n\n- a point"],
  ];

  for (const [name, data] of malformed) {
    it(`degrades calmly: ${name}`, async () => {
      await generateQuiz(data);

      await waitFor(() => {
        expect(screen.getByText("Unexpected quiz format")).toBeVisible();
      });
      expect(
        screen.getByText(/The quiz came back in an unexpected format\. Try generating it again\./),
      ).toBeVisible();
      // Offers a next action (docs/04 §7).
      expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
      // No half-rendered quiz behind the message.
      expect(document.querySelector(".quiz-q")).toBeNull();
      expect(document.querySelector(".quiz-score")).toBeNull();
    });
  }

  it("keeps the good questions when only some are malformed", async () => {
    await generateQuiz({
      questions: [
        { q: "Valid question", options: ["a", "b"], answer: 0, explanation: "ok" },
        { q: "Broken", options: ["a", "b"], answer: 42, explanation: "" },
      ],
    });

    await waitFor(() => expect(questionCards()).toHaveLength(1));
    expect(screen.getByText("Valid question")).toBeVisible();
    expect(screen.queryByText("Broken")).toBeNull();
    expect(score()).toBe("0 / 1");
  });

  it("recovers when a retry returns a valid quiz", async () => {
    const user = userEvent.setup();
    const api = installFakeNotesApi({ notes: { kind: "final", data: { questions: [] } } });
    render(<QuickNotes initialRemaining={null} initialLimit={null} />);
    await user.click(screen.getByRole("textbox"));
    await user.paste(SOURCE);
    await user.click(screen.getByRole("button", { name: "MCQs" }));
    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    await waitFor(() => expect(screen.getByText("Unexpected quiz format")).toBeVisible());

    api.setNotes({ kind: "final", data: GOOD_QUIZ });
    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(questionCards()).toHaveLength(3));
    expect(screen.queryByText("Unexpected quiz format")).toBeNull();
  });
});
