// Money is held as integer micro-dollars (1 USD = 1_000_000) so sums never drift.
export const MICROS_PER_USD = 1_000_000;

export const usdToMicros = (usd: number): number => Math.round(usd * MICROS_PER_USD);
export const microsToUsd = (micros: number): number => micros / MICROS_PER_USD;

export type Bounds = { start: Date | null; end: Date | null };

function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The anchor moved by n months, keeping its day of month where it exists (31 Jan + 1 → 28/29 Feb). */
export function addMonthsClamped(anchor: Date, n: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonthUtc(year, month));
  return new Date(
    Date.UTC(year, month, day, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()),
  );
}

/**
 * The monthly billing cycle containing `now`, given any past or future cycle start as `anchor`
 * (for example the date the Max plan renews). Cycles run [start, end).
 */
export function billingCycle(anchor: Date, now: Date): { start: Date; end: Date } {
  let n =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  // Step to the cycle whose start is <= now < next start; at most one step either way.
  while (addMonthsClamped(anchor, n).getTime() > now.getTime()) n -= 1;
  while (addMonthsClamped(anchor, n + 1).getTime() <= now.getTime()) n += 1;
  return { start: addMonthsClamped(anchor, n), end: addMonthsClamped(anchor, n + 1) };
}

export type BudgetWindow =
  | { kind: "lifetime" }
  | { kind: "calendar_month" }
  | { kind: "billing_cycle"; anchor: Date }
  | { kind: "rolling_days"; days: number };

export function windowBounds(window: BudgetWindow, now: Date): Bounds {
  switch (window.kind) {
    case "lifetime":
      return { start: null, end: null };
    case "calendar_month":
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      };
    case "billing_cycle":
      return billingCycle(window.anchor, now);
    case "rolling_days":
      return { start: new Date(now.getTime() - window.days * 86_400_000), end: null };
  }
}

export type SpendEvent = { occurredAt: Date; costMicros: number };

/**
 * A window as SQL can compare it: a half-open `[after, before)` in epoch milliseconds, with a null
 * end for "no upper bound". `after` is inclusive and `before` exclusive, exactly like `sumSpend`
 * (`start <= t < end`), so a SQL sum and the JS one count the same rows (BOS-671).
 */
export function boundsAsEpoch(bounds: Bounds): { after: number | null; before: number | null } {
  return { after: bounds.start ? bounds.start.getTime() : null, before: bounds.end ? bounds.end.getTime() : null };
}

/**
 * The total spent inside `bounds`. Callers with many cost rows sum in SQL instead (BOS-671) and
 * pass the total in; this walks the rows in JS for small sets and tests.
 */
export function sumSpend(events: Iterable<SpendEvent>, bounds: Bounds): number {
  let total = 0;
  for (const e of events) {
    const t = e.occurredAt.getTime();
    if (bounds.start && t < bounds.start.getTime()) continue;
    if (bounds.end && t >= bounds.end.getTime()) continue;
    total += e.costMicros;
  }
  return total;
}

export type CreditStatus = {
  cycleStart: Date;
  cycleEnd: Date;
  grantMicros: number;
  spentMicros: number;
  /** Can go negative when spend outran the grant; the UI shows that as overspend. */
  remainingMicros: number;
  fractionUsed: number;
};

/**
 * A monthly grant (e.g. the Max plan's $200 of API credit) against spend recorded in this cycle.
 * `spent` is the cycle's total: a caller with many cost rows sums it in SQL over `billingCycle`
 * instead of handing every row over (BOS-671). Without it, the given events are summed here.
 */
export function creditStatus(
  grant: { grantMicros: number; anchor: Date },
  events: Iterable<SpendEvent>,
  now: Date,
  spent?: number,
): CreditStatus {
  const { start, end } = billingCycle(grant.anchor, now);
  const spentMicros = spent ?? sumSpend(events, { start, end });
  return {
    cycleStart: start,
    cycleEnd: end,
    grantMicros: grant.grantMicros,
    spentMicros,
    remainingMicros: grant.grantMicros - spentMicros,
    fractionUsed: grant.grantMicros > 0 ? spentMicros / grant.grantMicros : 0,
  };
}

export type BudgetPolicy = {
  limitMicros: number;
  window: BudgetWindow;
  /** What happens at the limit: raise a decision for the owner, or pause the scope. */
  onLimit: "ask" | "pause";
  /** Fraction of the limit at which the budget shows a warning. */
  warnAt?: number;
};

export type BudgetState = "ok" | "warning" | "exceeded";

export type BudgetStatus = {
  usedMicros: number;
  limitMicros: number;
  fractionUsed: number;
  state: BudgetState;
  /** Set only when exceeded: what the scheduler must do. */
  action: "ask" | "pause" | null;
  bounds: Bounds;
};

/**
 * A policy's use against its window. `used` is the window's total: a caller with many cost rows
 * sums it in SQL over `windowBounds` instead of handing every row over (BOS-671). Without it, the
 * given events are summed here.
 */
export function budgetStatus(policy: BudgetPolicy, events: Iterable<SpendEvent>, now: Date, used?: number): BudgetStatus {
  const bounds = windowBounds(policy.window, now);
  const usedMicros = used ?? sumSpend(events, bounds);
  const fractionUsed = policy.limitMicros > 0 ? usedMicros / policy.limitMicros : usedMicros > 0 ? Infinity : 0;
  const warnAt = policy.warnAt ?? 0.9;
  const state: BudgetState = fractionUsed >= 1 ? "exceeded" : fractionUsed >= warnAt ? "warning" : "ok";
  return {
    usedMicros,
    limitMicros: policy.limitMicros,
    fractionUsed,
    state,
    action: state === "exceeded" ? policy.onLimit : null,
    bounds,
  };
}
