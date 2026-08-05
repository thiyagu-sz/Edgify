import { describe, expect, it } from "vitest";
import { costMicrosFor, isFreeModelId, priceFor, pricedModelIds } from "./pricing";

/**
 * Model pricing (docs/06 Phase 7, "cost dashboard shows per-user spend").
 *
 * THE DEFECT THIS MODULE EXISTS FOR. `recordLedger` accepted `costMicros` from Phase 3 and no
 * caller ever passed it, so every ledger row was written `0`. Nothing looked wrong: the column was
 * populated, `sum(cost_micros)` worked, and docs/08's weekly ritual returned a confident $0.00. A
 * dashboard built on that shows every user spending nothing, forever, and is trusted precisely
 * because nobody has a reason to doubt it.
 *
 * So the load-bearing assertions here are the ones about NOT returning zero: `0` and `null` must
 * stay distinguishable, because `0` means "genuinely free" and `null` means "we cannot price
 * this", and collapsing them is exactly how the defect returns.
 */

describe("free models are priced structurally, not from a list", () => {
  it.each([
    "google/gemma-4-26b-a4b-it:free",
    "inclusionai/ling-3.0-flash:free",
    "some/model-nobody-has-added-yet:free",
  ])("%s is free", (modelId) => {
    expect(isFreeModelId(modelId)).toBe(true);
    expect(costMicrosFor(modelId, 10_000, 5_000)).toBe(0);
  });

  /**
   * The point of the `:free` suffix rule. Free-tier ids rotate with little notice (docs/02), and a
   * newly rotated-in id must price correctly the day it appears — not the day someone remembers to
   * add it here. A list-based implementation would return `null` for the third case above and
   * raise a false "unpriced" alarm on every free generation.
   */
  it("a free id that is not in the price table still costs nothing", () => {
    expect(pricedModelIds()).not.toContain("brand-new/model:free");
    expect(costMicrosFor("brand-new/model:free", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("paid models produce a real, non-zero cost", () => {
  it("prices gpt-4o-mini at its published rate", () => {
    // $0.15 / 1M in, $0.60 / 1M out → 1M in + 1M out = 150_000 + 600_000 micros = $0.75.
    expect(costMicrosFor("openai/gpt-4o-mini", 1_000_000, 1_000_000)).toBe(750_000);
  });

  it("a realistic generation costs a non-zero number of micros", () => {
    // The shape of an actual Quick Notes call: a few thousand tokens in, a few hundred out.
    const cost = costMicrosFor("openai/gpt-4o-mini", 3_000, 800);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(Math.round(3_000 * 0.15 + 800 * 0.6));
  });

  it("returns integer micros, never a float", () => {
    // Money in floating point drifts, and a single generation is often only a few hundred micros,
    // so the drift would be a meaningful share of the total (docs/03 chose the unit for this).
    const cost = costMicrosFor("openai/gpt-4o-mini", 777, 333);
    expect(Number.isInteger(cost)).toBe(true);
  });
});

describe("unknown models record null, never a silent zero", () => {
  /**
   * THE ASSERTION THAT MATTERS MOST IN THIS FILE.
   *
   * A paid model missing from the table is real spend. Returning `0` for it would be
   * indistinguishable from a free model and would under-report the bill with nothing anywhere
   * looking wrong — the same silent-zero failure the whole module was written to end. `null` makes
   * it visible: the dashboard shows the rows as unpriced and warns that totals are an undercount.
   */
  it.each([
    "anthropic/claude-not-in-the-table",
    "openai/gpt-5-turbo-hypothetical",
    "unknown",
  ])("%s is unpriced rather than free", (modelId) => {
    expect(priceFor(modelId)).toBeNull();
    expect(costMicrosFor(modelId, 50_000, 20_000)).toBeNull();
    expect(costMicrosFor(modelId, 50_000, 20_000)).not.toBe(0);
  });

  it("a missing model id is unpriced, not free", () => {
    expect(costMicrosFor(null, 100, 100)).toBeNull();
    expect(costMicrosFor(undefined, 100, 100)).toBeNull();
  });
});

describe("NEGATIVE CONTROL — the zero-cost defect cannot return unnoticed", () => {
  /**
   * Reconstructs the original bug: every call priced at zero. If a future change made
   * `costMicrosFor` return 0 for paid models — by defaulting an unknown price to zero, say — this
   * fails, whereas a suite that only checked free models and totals would stay green.
   */
  it("not every model prices to zero", () => {
    const paid = costMicrosFor("openai/gpt-4o-mini", 10_000, 10_000);
    expect(paid, "paid models price to zero — this is the original ledger defect").not.toBe(0);
    expect(paid).toBeGreaterThan(0);
  });

  it("the price table is not empty", () => {
    // An empty table would make every paid model unpriced, which the dashboard would report
    // honestly — but it would mean this build can price nothing at all.
    expect(pricedModelIds().length).toBeGreaterThan(0);
  });

  it("zero tokens on a paid model is zero cost, which is correct and not the defect", () => {
    // The one legitimate zero on a paid model: no tokens were used. Distinguishing this from the
    // defect is why the tests above assert non-zero at realistic token counts rather than "> 0"
    // everywhere.
    expect(costMicrosFor("openai/gpt-4o-mini", 0, 0)).toBe(0);
  });
});
