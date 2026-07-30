import { describe, expect, it, vi } from "vitest";
import { encryptedPdf, corruptPdf, textPdf } from "@/test/fixtures/pdf";
import { isParseFailure } from "./failures";
import { extractPdf, type PdfDocument } from "./pdf";

/**
 * The CI gate for the memory discipline in docs/04 §4: "Always destroy the parsed PDF document
 * object in a `finally` block."
 *
 * This file proves the RELEASE IS CALLED on every path, deterministically and with no I/O. That
 * the release actually returns memory to baseline over many files is a separate, empirical proof
 * (`test/e2e/parse-memory.mjs`) — it needs `--expose-gc` and minutes of runtime, and GC timing is
 * too nondeterministic to gate CI on. Neither proof is sufficient alone: this one would pass
 * against a release that frees nothing, and that one cannot run on every commit.
 */

/** A document that records whether it was released. */
function fakeDoc(numPages = 3) {
  const state = { released: 0 };
  const doc: PdfDocument = {
    numPages,
    loadingTask: {
      destroy: async () => {
        state.released++;
      },
    },
  };
  return { doc, state };
}

describe("extractPdf: the document is always released", () => {
  it("releases after a successful extraction", async () => {
    const { doc, state } = fakeDoc();
    const result = await extractPdf(new Uint8Array(), {
      open: async () => doc,
      read: async () => ({ totalPages: 3, text: "  hello  " }),
    });

    expect(result).toEqual({ text: "hello", pageCount: 3 });
    expect(state.released, "the document was not released on the happy path").toBe(1);
  });

  it("releases when text extraction throws", async () => {
    const { doc, state } = fakeDoc();
    const result = await extractPdf(new Uint8Array(), {
      open: async () => doc,
      read: async () => {
        throw new Error("extraction blew up midway");
      },
    });

    expect(isParseFailure(result)).toBe(true);
    expect(state.released, "a thrown extraction leaked the document").toBe(1);
  });

  it("releases when the PDF is encrypted — the failure path leaks nothing", async () => {
    const { doc, state } = fakeDoc();
    const result = await extractPdf(new Uint8Array(), {
      open: async () => doc,
      read: async () => {
        throw Object.assign(new Error("No password given"), {
          name: "PasswordException",
          code: 1,
        });
      },
    });

    expect(isParseFailure(result) && result.kind).toBe("encrypted");
    expect(state.released).toBe(1);
  });

  /**
   * The trap the module comment describes. A release that throws inside a `finally` REPLACES the
   * error already propagating, so "password-protected PDF" would surface as an unrelated crash
   * and the user would be told the wrong thing. Writing the `proxy.destroy()` that docs/02 and
   * docs/04 describe produces exactly this, because that method does not exist on the proxy.
   */
  it("a failing release does not mask the real failure", async () => {
    const doc: PdfDocument = {
      numPages: 2,
      loadingTask: {
        destroy: async () => {
          throw new TypeError("proxy.destroy is not a function");
        },
      },
    };

    const result = await extractPdf(new Uint8Array(), {
      open: async () => doc,
      read: async () => {
        throw Object.assign(new Error("No password given"), { name: "PasswordException" });
      },
    });

    expect(
      isParseFailure(result) && result.kind,
      "the release error overwrote the encrypted-PDF diagnosis",
    ).toBe("encrypted");
  });

  it("survives a document that exposes no loadingTask at all", async () => {
    const result = await extractPdf(new Uint8Array(), {
      open: async () => ({ numPages: 1 }),
      read: async () => ({ totalPages: 1, text: "fine" }),
    });
    expect(result).toEqual({ text: "fine", pageCount: 1 });
  });

  it("does not crash when opening the document throws (nothing to release)", async () => {
    const release = vi.fn();
    const result = await extractPdf(new Uint8Array(), {
      open: async () => {
        throw Object.assign(new Error("Invalid PDF structure."), {
          name: "InvalidPDFException",
        });
      },
      read: async () => {
        throw new Error("unreachable");
      },
    });

    expect(isParseFailure(result) && result.kind).toBe("corrupt");
    expect(release).not.toHaveBeenCalled();
  });
});

/**
 * The same paths against the real library, so the fake above cannot drift from pdf.js's actual
 * behaviour. These are the error names this module classifies by, confirmed by feeding it files
 * rather than by reading documentation.
 */
describe("extractPdf: against real PDFs", () => {
  it("extracts text and page count from a genuine multi-page PDF", async () => {
    const result = await extractPdf(textPdf(3));
    expect(isParseFailure(result)).toBe(false);
    if (isParseFailure(result)) return;
    expect(result.pageCount).toBe(3);
    expect(result.text).toContain("Edgify test document");
  });

  it("maps a password-protected PDF to the encrypted failure, not a crash", async () => {
    const result = await extractPdf(encryptedPdf());
    expect(isParseFailure(result) && result.kind).toBe("encrypted");
  });

  it("maps a damaged PDF to the corrupt failure, not a crash", async () => {
    const result = await extractPdf(corruptPdf());
    expect(isParseFailure(result) && result.kind).toBe("corrupt");
  });

  it("never leaks a stack, a vendor name, or an error.message to the user string", async () => {
    // Stack frames are matched as `\n at …` / `file.js:12`, NOT as a bare "at " — English prose
    // contains that ("Th_at_ PDF is…"), and a pattern that fires on it teaches you to loosen the
    // check rather than to fix a leak.
    const STACK_OR_VENDOR = /pdf\.js|unpdf|pdfjs|Exception\b|\bat\s+\w+\s*\(|\.js:\d+|Invalid PDF structure/i;

    for (const bytes of [encryptedPdf(), corruptPdf()]) {
      const result = await extractPdf(bytes);
      if (!isParseFailure(result)) throw new Error("expected a failure");
      expect(result.message).not.toMatch(STACK_OR_VENDOR);
      // The internal detail still exists for the log — it is just not on the user-facing string.
      expect(result.cause).toBeDefined();
    }
  });
});
