// The soft hold of a waiting server update (BOS-420; the wait itself is deploy-wait.ts). Its own small module,
// with no imports beyond the schema, so the scheduler and both merge-check paths can read it without pulling in
// the decisions service. While a `deploy_wait` row exists (and is under 3 hours old) no new merge check starts
// and the scheduler starts at most `maxRuns` runs at once; what is already going finishes normally.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

export const DEPLOY_WAIT_KEY = "deploy_wait";
export const DEFAULT_QUIET_RUNS = 3;
/** The soft hold never lasts longer than this, in any phase; deploy-wait.ts then ends the wait with a page. */
export const SOFT_HOLD_MAX_MS = 3 * 60 * 60_000;

/** DEPLOY_QUIET_RUNS in the server's environment, else 3. */
export function quietRuns(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DEPLOY_QUIET_RUNS);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_QUIET_RUNS;
}

export type SoftHold = { on: false } | { on: true; phase: string; maxRuns: number; approvedAt: string };

/**
 * BOS-1634: a limit as saved and as enforced. `because`, `since` and `until` are set only when `inForce` is lower than
 * `saved`, so a screen that shows this object can never show a silent difference.
 */
export type LimitInForce = { saved: number; inForce: number; because: string | null; since: string | null; until: string | null };

/**
 * BOS-1634: why the hold is on, in the owner's words, since when, and the latest time it lifts (the 3-hour cap; it
 * usually ends sooner, once the update is live and its standby window is over).
 */
export function softHoldReason(h: Extract<SoftHold, { on: true }>): { because: string; since: string; until: string } {
  const because =
    h.phase === "waiting"
      ? "a server update is waiting for a quiet machine"
      : h.phase === "sent"
        ? "a server update is being applied"
        : "a server update has just gone live and the old server is still on standby";
  return { because, since: h.approvedAt, until: new Date(Date.parse(h.approvedAt) + SOFT_HOLD_MAX_MS).toISOString() };
}

/** BOS-1634: `saved` as the hold leaves it (at most `capTo` while it is on), with the reason when that is lower. */
export function limitUnderHold(saved: number, soft: SoftHold, capTo: number): LimitInForce {
  const inForce = soft.on ? Math.min(saved, capTo) : saved;
  const why = soft.on && inForce < saved ? softHoldReason(soft) : null;
  return { saved, inForce, because: why?.because ?? null, since: why?.since ?? null, until: why?.until ?? null };
}

export async function softHold(db: Db, now: Date = new Date(), maxRuns: number = quietRuns()): Promise<SoftHold> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, DEPLOY_WAIT_KEY));
  const w = row?.value as { phase?: string; approvedAt?: string } | undefined;
  if (!w?.approvedAt) return { on: false };
  const since = Date.parse(w.approvedAt);
  if (!Number.isFinite(since) || now.getTime() - since > SOFT_HOLD_MAX_MS) return { on: false };
  return { on: true, phase: w.phase ?? "waiting", maxRuns, approvedAt: w.approvedAt };
}
