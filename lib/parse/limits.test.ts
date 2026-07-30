import { describe, expect, it } from "vitest";
import { isParseFailure } from "./failures";
import {
  MAX_BYTES,
  checkContentLength,
  classifySource,
  readCapped,
} from "./limits";

/**
 * The size and type gates (docs/04 §4, docs/05 W3 step 2). The acceptance criterion is "an 11 MB
 * file is rejected BEFORE the body is read" — so the header check and the streaming cap are
 * tested as two separate defences, because the header alone is attacker-controlled.
 */

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe("checkContentLength — reject before reading the body", () => {
  it("rejects an 11 MB declared upload", () => {
    const failure = checkContentLength(String(11 * 1024 * 1024));
    expect(isParseFailure(failure) && failure.kind).toBe("too_large");
    expect(failure?.message).toBe(
      "That file is over the 10 MB limit. Try a smaller file, or paste the text directly.",
    );
  });

  it("allows a file exactly at the limit", () => {
    expect(checkContentLength(String(MAX_BYTES))).toBeNull();
  });

  it("does not reject when the header is absent or unparseable", () => {
    // Not a pass — it means this gate cannot answer, and `readCapped` is what enforces the limit.
    expect(checkContentLength(null)).toBeNull();
    expect(checkContentLength("not-a-number")).toBeNull();
    expect(checkContentLength("")).toBeNull();
  });
});

describe("readCapped — the gate that actually holds", () => {
  it("returns the bytes when under the cap", async () => {
    const result = await readCapped(streamOf([new Uint8Array([1, 2, 3])]), 10);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
  });

  /**
   * Break it on purpose: a client that LIES about its size. `Content-Length` is attacker
   * controlled, so a header-only check is decorative — without a running total we would happily
   * buffer the whole oversized body and only then complain.
   */
  it("aborts an oversized body that declared itself small", async () => {
    const oneMb = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 12 }, () => oneMb); // 12 MB of actual payload
    const declared = checkContentLength("1024"); // header claims 1 KB
    expect(declared, "the header check cannot catch a liar").toBeNull();

    const result = await readCapped(streamOf(chunks), MAX_BYTES);
    expect(isParseFailure(result) && result.kind).toBe("too_large");
  });

  it("stops reading rather than buffering everything past the cap", async () => {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++;
        if (produced > 100) return controller.close();
        controller.enqueue(new Uint8Array(1024));
      },
    });

    const result = await readCapped(stream, 4096);
    expect(isParseFailure(result) && result.kind).toBe("too_large");
    // It gave up near the cap instead of draining all 100 chunks.
    expect(produced).toBeLessThan(20);
  });
});

describe("classifySource", () => {
  it("accepts the four documented types by extension", () => {
    expect(classifySource("lecture.pdf")).toBe("pdf");
    expect(classifySource("notes.DOCX")).toBe("docx");
    expect(classifySource("readme.txt")).toBe("txt");
    expect(classifySource("notes.md")).toBe("md");
    expect(classifySource("notes.markdown")).toBe("md");
  });

  it("falls back to the MIME type when the extension is missing", () => {
    expect(classifySource("scan", "application/pdf")).toBe("pdf");
    expect(classifySource("notes", "text/markdown")).toBe("md");
  });

  it("trusts the extension over a wrong MIME type", () => {
    // Browsers routinely send application/octet-stream for DOCX; rejecting on MIME turns valid
    // uploads away.
    expect(classifySource("essay.docx", "application/octet-stream")).toBe("docx");
  });

  it("rejects legacy .doc rather than parsing it to noise", () => {
    const failure = classifySource("old-essay.doc");
    expect(isParseFailure(failure) && failure.kind).toBe("unsupported_type");
  });

  it("rejects anything else with the catalogue message", () => {
    const failure = classifySource("slides.pptx");
    expect(isParseFailure(failure) && failure.message).toBe(
      "Edgify reads PDF, DOCX, TXT and Markdown files.",
    );
  });
});
