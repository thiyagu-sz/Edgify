import { vi } from "vitest";

/**
 * A fake `XMLHttpRequest` for the Quick Notes document upload.
 *
 * The component uploads with XHR rather than `fetch` because the upload→extract handover is only
 * observable there (`upload.onload` fires when the request body has been sent). That means the
 * `fetch` fake in test/fake-notes-api.ts cannot see this request, so the transport is faked at
 * the same level the component uses — and the phase callbacks are driven explicitly, so a test
 * asserts the states the user actually sees rather than whatever the timing happened to produce.
 *
 * It speaks the real route contract (app/api/documents/extract/route.ts): 200 with
 * `{ text, charCount }` on success, 200/401 with `{ message }` on a failure the user can act on.
 */

export type ExtractSpec =
  /** Extraction succeeded. */
  | { kind: "ok"; text: string; charCount?: number }
  /** A failure the route already phrased for the user (scanned PDF, too large, wrong type). */
  | { kind: "message"; message: string; status?: number }
  /** A body that is not JSON at all — a proxy error page, say. */
  | { kind: "bad-json" }
  /** The transport itself failed: offline, DNS, connection reset. */
  | { kind: "network-error" };

export type FakeUpload = {
  /** Every URL opened, in order. */
  calls: string[];
  /** The `File` objects actually sent. */
  sent: File[];
  /** Advance the upload progress the component is listening to. */
  progress(loaded: number, total: number): void;
  /** Finish the send phase — this is what moves the UI from "uploading" to "extracting". */
  finishUpload(): void;
  /** Deliver the server's response, resolving the whole operation. */
  respond(): void;
};

/** Only the surface the component actually touches. */
type XhrLike = {
  responseText: string;
  status: number;
  upload: { onprogress?: (e: ProgressEvent) => void; onload?: () => void };
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  open(method: string, url: string): void;
  send(body: FormData): void;
};

/**
 * Install the fake on `globalThis.XMLHttpRequest`. Undone by `vi.unstubAllGlobals()`.
 *
 * Nothing advances on its own: the test calls `progress` / `finishUpload` / `respond`, so each
 * intermediate state can be asserted while it is on screen instead of being raced past.
 */
export function installFakeUpload(spec: ExtractSpec): FakeUpload {
  const calls: string[] = [];
  const sent: File[] = [];
  let current: XhrLike | null = null;

  function create(): XhrLike {
    const xhr: XhrLike = {
      responseText: "",
      status: 200,
      upload: {},
      open(_method, url) {
        calls.push(url);
      },
      send(body) {
        const picked = body.get("file");
        if (picked instanceof File) sent.push(picked);
      },
    };
    current = xhr;
    return xhr;
  }

  // A constructor function that returns an object hands that object back from `new`, which is
  // all the component needs and keeps this free of class/`this` gymnastics.
  vi.stubGlobal("XMLHttpRequest", function FakeXhr() {
    return create();
  });

  return {
    calls,
    sent,
    progress(loaded, total) {
      current?.upload.onprogress?.({
        lengthComputable: true,
        loaded,
        total,
      } as ProgressEvent);
    },
    finishUpload() {
      current?.upload.onload?.();
    },
    respond() {
      if (!current) throw new Error("respond() before any request was opened");
      if (spec.kind === "network-error") {
        current.onerror?.();
        return;
      }
      if (spec.kind === "bad-json") {
        current.responseText = "<!doctype html><html>not json</html>";
      } else if (spec.kind === "ok") {
        current.responseText = JSON.stringify({
          text: spec.text,
          charCount: spec.charCount ?? spec.text.length,
        });
      } else {
        current.status = spec.status ?? 200;
        current.responseText = JSON.stringify({ message: spec.message });
      }
      current.onload?.();
    },
  };
}
