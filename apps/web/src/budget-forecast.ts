export type BudgetForecast =
  | { kind: "too-early" }
  | { kind: "forecast"; projectedMicros: number; capMicros: number | null; status: "no-limit" | "under" | "reaches" | "over"; reachDate: Date | null };

const DAY_MS = 86_400_000;

/**
 * Where this month's spend is heading. `monthStartIso` is the start of the month as the server sent it
 * (an instant, possibly not midnight UTC because it follows the viewer's time zone).
 */
export function budgetForecast(monthMicros: number, monthStartIso: string, capMicros: number | null, now: Date): BudgetForecast {
  const start = new Date(monthStartIso).getTime();
  if (!Number.isFinite(start)) return { kind: "too-early" };
  const elapsedDays = (now.getTime() - start) / DAY_MS;
  if (elapsedDays < 2) return { kind: "too-early" };
  // 15 days in lands inside the same calendar month whatever the zone offset.
  const mid = new Date(start + 15 * DAY_MS);
  const daysInMonth = new Date(Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth() + 1, 0)).getUTCDate();
  const perDay = monthMicros / elapsedDays;
  const projectedMicros = Math.round(perDay * daysInMonth);
  const cap = capMicros && capMicros > 0 ? capMicros : null;
  if (cap === null) return { kind: "forecast", projectedMicros, capMicros: null, status: "no-limit", reachDate: null };
  if (monthMicros >= cap) return { kind: "forecast", projectedMicros, capMicros: cap, status: "over", reachDate: null };
  if (projectedMicros < cap) return { kind: "forecast", projectedMicros, capMicros: cap, status: "under", reachDate: null };
  const daysToCap = cap / perDay;
  return { kind: "forecast", projectedMicros, capMicros: cap, status: "reaches", reachDate: new Date(start + daysToCap * DAY_MS) };
}
