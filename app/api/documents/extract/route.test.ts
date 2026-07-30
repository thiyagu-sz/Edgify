import { beforeEach, describe, expect, it, vi } from "vitest";
import { PARSE_MESSAGES } from "@/lib/parse";
import { corruptPdf, encryptedPdf, scannedPdf, textPdf } from "@/test/fixtures/pdf";

/**
 * POST /api/documents/extract (W3, docs/05).
 *
 * The properties that matter here are the ones a happy-path test would miss: an oversized upload
 * is refused before its body is read, a scanned PDF is diagnosed rather than returned as an empty
 * success, and nothing is ever persisted.
 */

const getSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { get getSession() { return getSession; } } },
}));
// Transparent limiter: coverage and ordering are proven in app/api/rate-limit-coverage.test.ts.
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: (_name: string, handler: unknown) => handler,
}));

const { POST } = await import("./route");

function upload(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  type = "application/pdf",
  headers: Record<string, string> = {},
): Request {
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type }));
  return new Request("http://localhost/api/documents/extract", {
    method: "POST",
    body: form,
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("auth", () => {
  it("requires a session", async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(upload(textPdf(1), "notes.pdf"));
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe("Please sign in again to continue.");
  });
});

describe("size gate", () => {
  /**
   * The acceptance criterion is that an 11 MB file is rejected BEFORE the body is read. Asserting
   * the message alone would pass even if we had buffered the whole thing first, so this asserts
   * the body was never consumed.
   */
  it("rejects an 11 MB declared upload without reading the body", async () => {
    const request = upload(new Uint8Array(16), "huge.pdf", "application/pdf", {
      "content-length": String(11 * 1024 * 1024),
    });

    const res = await POST(request);

    expect((await res.json()).message).toBe(PARSE_MESSAGES.too_large);
    expect(request.bodyUsed, "the oversized body was read before being rejected").toBe(false);
  });

  it("still rejects when the declared length lies about a large body", async () => {
    // 12 MB of payload behind a header claiming 1 KB — the streaming cap is what holds here.
    const big = new Uint8Array(12 * 1024 * 1024);
    const res = await POST(
      upload(big, "sneaky.pdf", "application/pdf", { "content-length": "1024" }),
    );
    expect((await res.json()).message).toBe(PARSE_MESSAGES.too_large);
  });
});

describe("extraction", () => {
  it("returns the extracted text for a real PDF", async () => {
    const res = await POST(upload(textPdf(3), "biology-notes.pdf"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.text).toContain("Edgify test document");
    expect(body.charCount).toBe(body.text.length);
    expect(body.pageCount).toBe(3);
    expect(body.title).toBe("biology-notes");
    expect(body.sourceType).toBe("pdf");
  });

  it("extracts a plain text upload", async () => {
    const text = "Photosynthesis converts light into chemical energy. ".repeat(10);
    const res = await POST(
      upload(new TextEncoder().encode(text), "lecture.txt", "text/plain"),
    );
    const body = await res.json();
    expect(body.text).toContain("Photosynthesis");
    expect(body.pageCount).toBeNull();
  });

  it("diagnoses a scanned PDF instead of returning an empty success", async () => {
    const res = await POST(upload(scannedPdf(4), "phone-photos.pdf"));
    const body = await res.json();

    expect(body.message).toBe(PARSE_MESSAGES.scanned);
    // The distinction the criterion turns on: no text field at all, so nothing downstream can
    // proceed with an empty document.
    expect(body.text).toBeUndefined();
  });

  it("reports an encrypted PDF clearly, not as a crash", async () => {
    const res = await POST(upload(encryptedPdf(), "protected.pdf"));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(PARSE_MESSAGES.encrypted);
  });

  it("reports a damaged PDF clearly", async () => {
    const res = await POST(upload(corruptPdf(), "damaged.pdf"));
    expect((await res.json()).message).toBe(PARSE_MESSAGES.corrupt);
  });

  it("rejects an unsupported type", async () => {
    const res = await POST(
      upload(new Uint8Array([1, 2, 3]), "deck.pptx", "application/vnd.ms-powerpoint"),
    );
    expect((await res.json()).message).toBe(PARSE_MESSAGES.unsupported_type);
  });

  it("never leaks a stack, status code, or vendor name in any failure body", async () => {
    const cases = [
      upload(encryptedPdf(), "protected.pdf"),
      upload(corruptPdf(), "damaged.pdf"),
      upload(scannedPdf(3), "scan.pdf"),
      upload(new Uint8Array([1]), "deck.pptx", "application/octet-stream"),
    ];
    for (const request of cases) {
      const body = JSON.stringify(await (await POST(request)).json());
      expect(body).not.toMatch(/pdf\.js|unpdf|pdfjs|Exception\b|\.js:\d+|\b(4\d\d|5\d\d)\b/);
    }
  });
});
