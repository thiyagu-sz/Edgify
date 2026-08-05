/**
 * Model pricing, in micros (millionths of a dollar) — what turns `usage_ledger.costMicros` from a
 * column into an answer.
 *
 * WHY THIS EXISTS. `recordLedger` has accepted `costMicros` since Phase 3 and **no caller ever
 * passed it**, so every row in the ledger was written `0`. Nothing was broken in a way anything
 * could notice: the column was populated, queries summed it happily, and docs/08's weekly ritual
 * (`sum(cost_micros)/1e6 AS usd`) returned a confident $0.00. A cost dashboard built on that would
 * have shown every user spending nothing, forever, and looked entirely healthy — which is worse
 * than having no dashboard, because a number nobody doubts is a number nobody checks.
 *
 * COST IS COMPUTED AT RECORD TIME, NOT AT READ TIME. A ledger row is a historical fact, so it must
 * carry the price that applied WHEN THE CALL HAPPENED. Pricing it at read time would silently
 * re-price all of history every time this table changes — last month's spend would move because
 * a vendor changed a rate this morning, and no report built on it could be reconciled against a
 * bill. It also keeps docs/08's existing SQL working with no changes.
 *
 * UNKNOWN MODELS RECORD `null`, NEVER `0`. Free-tier ids rotate (docs/02) and a paid id can be
 * swapped by an env change, so this table WILL fall behind at some point. When it does, the
 * failure has to be visible: `null` reads as "unpriced" on the dashboard, while `0` would look
 * exactly like a free model and quietly under-report real spend. Silence is the one thing this
 * module must not do.
 */

export type ModelPrice = {
  /** Micros per 1,000,000 input (prompt) tokens. */
  inputMicrosPerMillion: number;
  /** Micros per 1,000,000 output (completion) tokens. */
  outputMicrosPerMillion: number;
};

const FREE: ModelPrice = { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };

/**
 * Paid models, keyed by the exact OpenRouter id. Micros per million tokens: $0.15/M is 150_000.
 *
 * Keep this in step with the ids in `lib/env.ts` — `OPENROUTER_PAID_MODEL` is the one that costs
 * money. An id here that nobody uses is harmless; a paid id MISSING from here is under-reporting,
 * which is why the dashboard surfaces unpriced rows rather than folding them into the total.
 */
const PRICES: Record<string, ModelPrice> = {
  // $0.15 / $0.60 per million tokens.
  "openai/gpt-4o-mini": {
    inputMicrosPerMillion: 150_000,
    outputMicrosPerMillion: 600_000,
  },
};

/**
 * OpenRouter marks zero-cost variants with a `:free` suffix, so this is structural rather than a
 * list to maintain — a newly rotated-in free id is priced correctly the day it appears, without
 * anyone remembering to add it here. That matters because free ids rotate with little notice
 * (docs/02) and the whole ladder's first rungs are free.
 */
export function isFreeModelId(modelId: string): boolean {
  return modelId.endsWith(":free");
}

/** The price for a model id, or null when it is not known — never a silent zero. */
export function priceFor(modelId: string): ModelPrice | null {
  if (isFreeModelId(modelId)) return FREE;
  return PRICES[modelId] ?? null;
}

/**
 * Cost of one call in micros, or null when the model is unpriced.
 *
 * Integer micros throughout: money in floating point drifts, and at these magnitudes (a single
 * generation is often a few hundred micros) the drift would be a meaningful share of the total.
 * docs/03 chose the unit for exactly this reason.
 */
export function costMicrosFor(
  modelId: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
): number | null {
  if (!modelId) return null;
  const price = priceFor(modelId);
  if (!price) return null;
  const micros =
    (tokensIn * price.inputMicrosPerMillion) / 1_000_000 +
    (tokensOut * price.outputMicrosPerMillion) / 1_000_000;
  return Math.round(micros);
}

/** Model ids this module can price — for the dashboard's "unpriced models" warning. */
export function pricedModelIds(): string[] {
  return Object.keys(PRICES).sort();
}
