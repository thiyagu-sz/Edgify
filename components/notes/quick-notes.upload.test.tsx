import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeNotesApi } from "@/test/fake-notes-api";
import { type ExtractSpec, installFakeUpload } from "@/test/fake-upload-api";
import { QuickNotes } from "./quick-notes";

/**
 * Document upload, from the user's side (W3, docs/05).
 *
 * The guarantee under test is that the user is never looking at an unchanged screen wondering
 * whether anything happened, and — the invariant this file exists for — that the extracted
 * document text NEVER lands in the textarea while still reaching the generator unchanged.
 */

const DOC_TEXT = "Extracted document body. ".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function file(name = "lecture.pdf", type = "application/pdf") {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

async function pickFile(spec: ExtractSpec, name?: string) {
  const user = userEvent.setup();
  const api = installFakeNotesApi({ notes: { kind: "final", data: "# ok" } });
  const upload = installFakeUpload(spec);
  render(<QuickNotes initialRemaining={null} initialLimit={null} />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input missing");
  await user.upload(input, file(name));
  return { user, api, upload };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("the upload states are visible as they happen", () => {
  it("shows uploading with real progress, then extracting, then ready", async () => {
    const { upload } = await pickFile({ kind: "ok", text: DOC_TEXT, charCount: 1234 });

    // STATE 2 — uploading. Present the moment the file is picked, before anything resolves.
    expect(await screen.findByText(/Uploading document…/)).toBeVisible();
    expect(screen.getByText("lecture.pdf")).toBeVisible();

    // The percentage is measured from the transport, not invented.
    act(() => upload.progress(50, 100));
    expect(screen.getByText(/Uploading document… 50%/)).toBeVisible();

    // STATE 3 — extracting, at the moment the body has finished sending.
    act(() => upload.finishUpload());
    expect(screen.getByText(/Extracting document…/)).toBeVisible();
    expect(
      screen.getByText(/Reading your document and preparing it for processing/),
    ).toBeVisible();

    // STATE 4 — ready.
    act(() => upload.respond());
    expect(await screen.findByText("Document ready")).toBeVisible();
    expect(screen.getByText(/lecture\.pdf · 1,234 characters/)).toBeVisible();
  });

  it("announces each state to assistive technology without trapping focus", async () => {
    const { upload } = await pickFile({ kind: "ok", text: DOC_TEXT });
    expect(await screen.findByRole("status")).toHaveTextContent(/Uploading document…/);

    // Wherever focus happens to be, the status transitions must not move it.
    const focusedBefore = document.activeElement;
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");
    expect(screen.getByRole("status")).toHaveTextContent("Document ready");
    expect(document.activeElement).toBe(focusedBefore);
  });
});

describe("the extracted text never reaches the textarea", () => {
  it("leaves the source box empty and still generates from the document", async () => {
    const { user, api, upload } = await pickFile({ kind: "ok", text: DOC_TEXT });
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");

    // The invariant.
    expect(textarea().value).toBe("");
    expect(document.body.textContent).not.toContain("Extracted document body.");

    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));

    // The generator still receives the document, byte for byte — only its holding place moved.
    await waitFor(() => expect(api.generateBodies).toHaveLength(1));
    expect(api.generateBodies[0].text).toBe(DOC_TEXT.trim());
  });

  it("counts the document's characters, not the empty box", async () => {
    const { upload } = await pickFile({ kind: "ok", text: DOC_TEXT, charCount: 999 });
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");
    expect(screen.getByText(`${DOC_TEXT.length.toLocaleString()} characters`)).toBeVisible();
  });

  it("stands the textarea down while a document is loaded, and hands it back on remove", async () => {
    const { user, upload } = await pickFile({ kind: "ok", text: DOC_TEXT });
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");
    expect(textarea()).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /remove document/i }));
    expect(textarea()).toBeEnabled();
    expect(screen.queryByText("Document ready")).not.toBeInTheDocument();
  });

  it("drops the document when the sample is loaded, so the sample is what generates", async () => {
    const { user, api, upload } = await pickFile({ kind: "ok", text: DOC_TEXT });
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");

    await user.click(screen.getByRole("button", { name: /load sample/i }));
    expect(screen.queryByText("Document ready")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /generate revision notes/i }));
    await waitFor(() => expect(api.generateBodies).toHaveLength(1));
    expect(api.generateBodies[0].text).toContain("Neural networks learn by adjusting");
    expect(api.generateBodies[0].text).not.toContain("Extracted document body.");
  });
});

describe("failures stay calm and recoverable", () => {
  const cases: [string, ExtractSpec, RegExp][] = [
    [
      "a scanned PDF the route already phrased",
      { kind: "message", message: "This PDF looks like scanned images, so there is no text to read. Try pasting the text instead." },
      /scanned images/i,
    ],
    ["a body that is not JSON", { kind: "bad-json" }, /couldn't be read/i],
    ["the transport failing outright", { kind: "network-error" }, /went wrong on our side/i],
  ];

  for (const [label, spec, expected] of cases) {
    it(`explains ${label} without leaking machinery`, async () => {
      const { upload } = await pickFile(spec);
      act(() => {
        upload.finishUpload();
        upload.respond();
      });

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/Couldn't process this document/);
      expect(alert).toHaveTextContent(expected);

      const body = document.body.textContent ?? "";
      for (const forbidden of [/\bHTTP\s*\d{3}\b/i, /\bat\s+\w+\s*\(.*:\d+:\d+\)/, /\bundefined\b/, /\[object Object\]/]) {
        expect(body).not.toMatch(forbidden);
      }
      // A failed document must not become the source material.
      expect(textarea()).toBeEnabled();
    });
  }

  it("treats an empty extraction as a failure rather than a ready document", async () => {
    const { upload } = await pickFile({ kind: "ok", text: "   " });
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByText("Document ready")).not.toBeInTheDocument();
  });

  it("offers another attempt, which reopens the picker", async () => {
    const { user, upload } = await pickFile({ kind: "bad-json" });
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByRole("alert");

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    const click = vi.spyOn(input!, "click");
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(click).toHaveBeenCalled();
  });
});

describe("the document pipeline is untouched", () => {
  it("posts the picked file once, to the existing extract route", async () => {
    const { upload } = await pickFile({ kind: "ok", text: DOC_TEXT }, "notes.docx");
    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");

    expect(upload.calls).toEqual(["/api/documents/extract"]);
    expect(upload.sent).toHaveLength(1);
    expect(upload.sent[0].name).toBe("notes.docx");
  });

  it("blocks generation while a document is still being read", async () => {
    const { upload } = await pickFile({ kind: "ok", text: DOC_TEXT });
    expect(screen.getByRole("button", { name: /generate revision notes/i })).toBeDisabled();

    act(() => {
      upload.finishUpload();
      upload.respond();
    });
    await screen.findByText("Document ready");
    expect(screen.getByRole("button", { name: /generate revision notes/i })).toBeEnabled();
  });
});
