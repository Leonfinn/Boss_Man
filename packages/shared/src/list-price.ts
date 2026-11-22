// The second source for a run's cost (BOS-1866): what its own tokens cost at the model's published list price.
// The cost Boss Man records comes from the agent tool's own counter; if that counter is read wrongly (BOS-1857: a
// resumed session recorded its whole earlier cost again, about 8x too high) no test written on the same belief would
// notice. This table does not use that counter, so a run whose two figures disagree widely is flagged.
//
// Prices are US dollars per million tokens, Anthropic's first-party list prices. A bare alias ("opus") could be any
// recent version of that family, so it carries a range, and the check only flags a figure outside the whole range.
// Update this table when a model's price changes; a model missing from it is skipped (never flagged) and named.

export type PriceRange = { lo: number; hi: number };
export type ListPrice = { input: PriceRange; output: PriceRange };

const p = (lo: number, hi = lo): PriceRange => ({ lo, hi });

/** First match wins, so specific versions come before the family's alias. Matched on the model id after any "provider/" prefix. */
const PRICES: Array<{ match: RegExp; price: ListPrice }> = [
  { match: /fable/, price: { input: p(10), output: p(50) } },
  { match: /opus-5-5|opus-5\.5/, price: { input: p(4), output: p(20) } },
  { match: /opus-(5|4-[5-9]|4\.[5-9])(?![0-9])/, price: { input: p(5), output: p(25) } },
  { match: /opus-4(-1)?(?![0-9.-])|opus-4-1|opus-4\.1|opus-4-20/, price: { input: p(15), output: p(75) } },
  { match: /^opus/, price: { input: p(4, 5), output: p(20, 25) } },
  { match: /sonnet-5/, price: { input: p(2), output: p(10) } },
  { match: /sonnet-(4|3-7|3\.7)/, price: { input: p(3), output: p(15) } },
  { match: /^sonnet/, price: { input: p(2, 3), output: p(10, 15) } },
  { match: /haiku-5/, price: { input: p(0.1, 0.5), output: p(0.5, 2.5) } }, // the higher figure applies to prompts over 100K tokens
  { match: /haiku-4/, price: { input: p(1), output: p(5) } },
  { match: /^haiku/, price: { input: p(0.1, 1), output: p(0.5, 5) } },
];

/** Cache reads cost 0.025x to 0.1x the input price by model, and cache writes 1.25x (5-minute) to 2x (1-hour). */
const CACHE_READ = { lo: 0.025, hi: 0.1 };
const CACHE_WRITE = { lo: 1.25, hi: 2 };

/** A recorded figure may be this many times the highest expected, or this fraction of the lowest, before it is out of band. */
export const COST_BAND_FACTOR = 2;
/** Below this the two figures are not compared: a few cents of rounding or short-run overhead is not a wrong figure. */
export const COST_BAND_MIN_MICROS = 50_000;

export function listPriceFor(model: string | null | undefined): ListPrice | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  const bare = id.slice(id.lastIndexOf("/") + 1).replace(/^claude[-.]/, "").replace(/\[.*\]$/, "");
  for (const row of PRICES) if (row.match.test(bare)) return row.price;
  return null;
}

export type RunTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** What the run's tokens should cost at list price, as a low and a high figure in micro-dollars, or null with no price for the model. */
export function expectedCostMicros(model: string | null | undefined, t: RunTokens): { lo: number; hi: number } | null {
  const price = listPriceFor(model);
  if (!price) return null;
  const at = (side: "lo" | "hi") => {
    const inPrice = price.input[side];
    return t.input * inPrice + t.output * price.output[side] + t.cacheRead * inPrice * CACHE_READ[side] + t.cacheWrite * inPrice * CACHE_WRITE[side];
  };
  // Prices are dollars per million tokens, so tokens x price is already micro-dollars.
  return { lo: Math.round(at("lo")), hi: Math.round(at("hi")) };
}

export type CostCheck =
  | { status: "ok" }
  | { status: "out_of_band"; recordedMicros: number; expectedLo: number; expectedHi: number }
  | { status: "skipped"; reason: "no_list_price" | "no_recorded_cost" | "no_tokens" | "too_small" };

/** Compares a run's recorded cost with its tokens at list price. Skips (never flags) what it cannot judge. */
export function checkRunCost(model: string | null | undefined, t: RunTokens, recordedMicros: number): CostCheck {
  const expected = expectedCostMicros(model, t);
  if (!expected) return { status: "skipped", reason: "no_list_price" };
  if (recordedMicros <= 0) return { status: "skipped", reason: "no_recorded_cost" };
  if (expected.hi <= 0) return { status: "skipped", reason: "no_tokens" };
  if (Math.max(recordedMicros, expected.hi) < COST_BAND_MIN_MICROS) return { status: "skipped", reason: "too_small" };
  if (recordedMicros > expected.hi * COST_BAND_FACTOR || recordedMicros < expected.lo / COST_BAND_FACTOR) {
    return { status: "out_of_band", recordedMicros, expectedLo: expected.lo, expectedHi: expected.hi };
  }
  return { status: "ok" };
}

/** Plain words for why a run was not checked, for the panel. */
export const COST_SKIP_TEXT: Record<string, string> = {
  no_list_price: "no list price known for the model",
  no_recorded_cost: "no cost recorded (a subscription tool that reports none)",
  no_tokens: "no tokens recorded",
  too_small: "too small to compare",
};
