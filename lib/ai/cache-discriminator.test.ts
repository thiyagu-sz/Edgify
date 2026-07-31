import { describe, expect, it } from "vitest";
import { cacheKey } from "../cache";
import { cacheDiscriminator, type GenerateInput } from "./generate";

/**
 * The cache key's second component (docs/03: `sha256(normalisedText:format:modelId:promptVersion)`).
 *
 * The load-bearing case is `concept_detail`. Every concept in a graph is generated from the SAME
 * document text — grounding is the point — so the text alone cannot distinguish them. Without the
 * slug, all 6-9 concepts in a document collapse onto ONE cache entry: the first concept clicked
 * populates it, and every other concept then "hits" and renders that first concept's definition
 * under its own name. It looks like a working cache, costs nothing, and is wrong.
 */

const DOCUMENT = "the same lecture text, shared by every concept in the graph";
const VERSION = "v1";

/** Exactly how `generate.ts` builds the key. */
function keyFor(input: GenerateInput): string {
  return cacheKey(input.text, cacheDiscriminator(input), VERSION);
}

const conceptDetail = (conceptSlug: string, conceptName: string): GenerateInput => ({
  userId: "u1",
  operation: "concept_detail",
  conceptSlug,
  conceptName,
  text: DOCUMENT,
});

describe("cacheDiscriminator: concept_detail carries the slug", () => {
  it("gives two concepts in the SAME document different keys", () => {
    const gradient = keyFor(conceptDetail("gradient-descent", "Gradient descent"));
    const backprop = keyFor(conceptDetail("backpropagation", "Backpropagation"));

    expect(
      gradient,
      "two concepts from one document collided on a single cache entry",
    ).not.toBe(backprop);
  });

  it("keeps the SAME concept on one key, so a revisit is free (W5)", () => {
    expect(keyFor(conceptDetail("gradient-descent", "Gradient descent"))).toBe(
      keyFor(conceptDetail("gradient-descent", "Gradient descent")),
    );
  });

  it("keys on the slug, not the display name", () => {
    // The name is model output and can drift between runs; the slug is the stable id (docs/03).
    expect(keyFor(conceptDetail("gd", "Gradient descent"))).toBe(
      keyFor(conceptDetail("gd", "Gradient Descent (SGD)")),
    );
  });

  it("distinguishes all nine concepts of a realistic graph", () => {
    const slugs = [
      "calc", "linalg", "prob", "opt", "gd", "bp", "nn", "cnn", "attn",
    ];
    const keys = slugs.map((slug) => keyFor(conceptDetail(slug, slug)));
    expect(new Set(keys).size, "distinct concepts shared a cache entry").toBe(slugs.length);
  });

  /**
   * The negative control, and it has to be an HONEST reimplementation to be worth anything.
   *
   * `sluglessKeyFor` is `keyFor` with one edit — the discriminator is the bare operation name,
   * which is what `cacheDiscriminator` would return if someone dropped `:${input.conceptSlug}`.
   * Everything else (the same text, the same `cacheKey`, the same version) is identical, so the
   * slug is the only variable. It asserts the collision is REAL rather than asserting a collision
   * it manufactured.
   */
  it("negative control: WITHOUT the slug, those same two concepts collide", () => {
    const sluglessKeyFor = (input: GenerateInput) =>
      cacheKey(input.text, input.operation, VERSION);

    const gradient = conceptDetail("gradient-descent", "Gradient descent");
    const backprop = conceptDetail("backpropagation", "Backpropagation");

    expect(
      sluglessKeyFor(gradient),
      "the slug-less discriminator did NOT collide — this control proves nothing, so the test above proves nothing either",
    ).toBe(sluglessKeyFor(backprop));

    // ...and with the slug, the same pair is distinct. One edit, opposite outcome.
    expect(keyFor(gradient)).not.toBe(keyFor(backprop));
  });
});

describe("cacheDiscriminator: the other operations", () => {
  it("graph_structure needs no extra component — one graph per document", () => {
    const input: GenerateInput = {
      userId: "u1",
      operation: "graph_structure",
      text: DOCUMENT,
    };
    expect(cacheDiscriminator(input)).toBe("graph_structure");
  });

  it("quick_notes keeps the bare format id, so pre-Phase-5 entries stay valid", () => {
    const input: GenerateInput = {
      userId: "u1",
      operation: "quick_notes",
      format: "key_points",
      text: DOCUMENT,
    };
    expect(cacheDiscriminator(input)).toBe("key_points");
  });

  it("no operation's discriminator can be mistaken for another's", () => {
    const notes = cacheDiscriminator({
      userId: "u1", operation: "quick_notes", format: "key_points", text: DOCUMENT,
    });
    const graph = cacheDiscriminator({
      userId: "u1", operation: "graph_structure", text: DOCUMENT,
    });
    const detail = cacheDiscriminator(conceptDetail("key_points", "Key Points"));

    // Same text, three operations: three keys. A concept whose slug happens to equal a Quick
    // Notes format id must not collide with that format's notes.
    expect(new Set([notes, graph, detail]).size).toBe(3);
    expect(keyFor({ userId: "u1", operation: "quick_notes", format: "key_points", text: DOCUMENT }))
      .not.toBe(keyFor(conceptDetail("key_points", "Key Points")));
  });
});
