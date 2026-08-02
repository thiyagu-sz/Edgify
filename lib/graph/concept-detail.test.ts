import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getOrCreateConceptDetail` (W5, docs/05) — the service behind the concept-detail route.
 *
 * The properties that matter and are checked here:
 *   - a STORED detail is returned without a model call (this is what makes "generates once" true
 *     across sessions, not just within one page),
 *   - ownership is resolved through the graph, so a guessed uuid reads nothing,
 *   - ladder exhaustion falls back to the concept's own summary and never to demo content,
 *   - FIRST COMMIT WINS: when a concurrent request stored a detail first, the loser serves that
 *     value rather than overwriting it.
 */

const generate = vi.fn();
const getConcept = vi.fn();
const setConceptDetail = vi.fn();
const getGraph = vi.fn();
const getDocument = vi.fn();

class FakeServiceBusyError extends Error {
  constructor() {
    super("Server is busy, please try again in a moment.");
    this.name = "ServiceBusyError";
  }
}

vi.mock("../ai/generate", () => ({
  generate: (...args: unknown[]) => generate(...args),
  ServiceBusyError: FakeServiceBusyError,
}));
vi.mock("../db/queries/concepts", () => ({
  getConcept: (...args: unknown[]) => getConcept(...args),
  setConceptDetail: (...args: unknown[]) => setConceptDetail(...args),
}));
vi.mock("../db/queries/graphs", () => ({ getGraph: (...args: unknown[]) => getGraph(...args) }));
vi.mock("../db/queries/documents", () => ({ getDocument: (...args: unknown[]) => getDocument(...args) }));
vi.mock("../log", () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { getOrCreateConceptDetail } = await import("./concept-detail");

const DETAIL = {
  definition: "A definition.",
  example: "An example.",
  quiz: null,
  flashcards: [],
};

const CONCEPT = {
  id: "c1",
  graphId: "g1",
  slug: "calc",
  name: "Calculus",
  summary: "A short summary from the structure pass.",
  detailJson: null as unknown,
};

beforeEach(() => {
  for (const fn of [generate, getConcept, setConceptDetail, getGraph, getDocument]) fn.mockReset();
  getConcept.mockResolvedValue({ ...CONCEPT });
  getGraph.mockResolvedValue({ id: "g1", documentId: "d1", userId: "user-a" });
  getDocument.mockResolvedValue({ id: "d1", extractedText: "The document text." });
  generate.mockResolvedValue({ data: DETAIL, tier: "free", notice: null, modelId: "m" });
  setConceptDetail.mockResolvedValue(true);
});

describe("stored detail", () => {
  it("is returned without calling the model", async () => {
    getConcept.mockResolvedValue({ ...CONCEPT, detailJson: DETAIL });

    const result = await getOrCreateConceptDetail("user-a", "c1");

    expect(result).toEqual({ status: "ready", detail: DETAIL, cached: true });
    expect(generate, "a stored detail cost a model call").not.toHaveBeenCalled();
    expect(getDocument, "a stored detail read the document unnecessarily").not.toHaveBeenCalled();
  });
});

describe("generating a detail", () => {
  it("grounds the generation in the document text and keys the cache on the slug", async () => {
    await getOrCreateConceptDetail("user-a", "c1");

    expect(generate).toHaveBeenCalledWith({
      userId: "user-a",
      operation: "concept_detail",
      conceptSlug: "calc",
      conceptName: "Calculus",
      text: "The document text.",
    });
  });

  it("persists the validated detail and returns it", async () => {
    const result = await getOrCreateConceptDetail("user-a", "c1");
    expect(setConceptDetail).toHaveBeenCalledWith("user-a", "c1", DETAIL);
    expect(result).toEqual({ status: "ready", detail: DETAIL, cached: false });
  });

  it("reports a cache-tier result as cached", async () => {
    generate.mockResolvedValue({ data: DETAIL, tier: "cache", notice: null, modelId: null });
    const result = await getOrCreateConceptDetail("user-a", "c1");
    expect(result).toEqual({ status: "ready", detail: DETAIL, cached: true });
  });
});

describe("ownership", () => {
  it("reports a concept that is not the caller's as not found", async () => {
    getConcept.mockResolvedValue(undefined);
    const result = await getOrCreateConceptDetail("user-b", "c1");
    expect(result).toEqual({ status: "not_found" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("re-checks the graph rather than trusting the concept row", async () => {
    getGraph.mockResolvedValue(undefined);
    const result = await getOrCreateConceptDetail("user-a", "c1");
    expect(result).toEqual({ status: "not_found" });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("ladder exhaustion", () => {
  it("falls back to the concept's own summary, never to demo content", async () => {
    generate.mockRejectedValue(new FakeServiceBusyError());

    const result = await getOrCreateConceptDetail("user-a", "c1");

    // W5: the summary WAS derived from this user's document during the structure pass. There is
    // no demo tier for concept detail — `lib/demo/index.ts` does not answer it.
    expect(result).toEqual({
      status: "unavailable",
      summary: "A short summary from the structure pass.",
    });
    expect(setConceptDetail, "a failed generation was persisted").not.toHaveBeenCalled();
  });

  it("falls back the same way on an unexpected failure", async () => {
    generate.mockRejectedValue(new Error("something else entirely"));
    const result = await getOrCreateConceptDetail("user-a", "c1");
    expect(result.status).toBe("unavailable");
  });

  it("falls back when the document text is missing", async () => {
    getDocument.mockResolvedValue({ id: "d1", extractedText: null });
    const result = await getOrCreateConceptDetail("user-a", "c1");
    expect(result.status).toBe("unavailable");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("first commit wins", () => {
  it("serves the stored value when a concurrent request committed first", async () => {
    /**
     * `setConceptDetail` is conditional on `detailJson IS NULL`, so the loser of a race writes
     * nothing and returns false. It must then serve the WINNER's value: the two are separate
     * generations, and the client caches whichever it is handed — so returning our own would leave
     * two tabs, or two users of the same graph, permanently holding different explanations of one
     * concept.
     */
    const theirs = { ...DETAIL, definition: "The other request's definition." };
    setConceptDetail.mockResolvedValue(false);
    getConcept
      .mockResolvedValueOnce({ ...CONCEPT })
      .mockResolvedValueOnce({ ...CONCEPT, detailJson: theirs });

    const result = await getOrCreateConceptDetail("user-a", "c1");

    expect(result).toEqual({ status: "ready", detail: theirs, cached: true });
  });

  it("reports not_found if the row vanished between the write and the re-read", async () => {
    setConceptDetail.mockResolvedValue(false);
    getConcept.mockResolvedValueOnce({ ...CONCEPT }).mockResolvedValueOnce(undefined);

    const result = await getOrCreateConceptDetail("user-a", "c1");
    expect(result).toEqual({ status: "not_found" });
  });
});
