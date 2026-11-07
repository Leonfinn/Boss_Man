// A limit on how many merge checks (quick or full) run at once, so a burst of approvals can't exhaust the
// host's memory (BOS-446). The rest wait in order; urgent and "Arch fix" tickets go first. The limit is
// a setting, read on every grant, so changing it takes effect without a restart. The default is host-neutral.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { softHold } from "./deploy-wait-hold.js";

export const MERGE_CHECK_LIMIT_KEY = "merge_check_limit";
export const DEFAULT_MERGE_CHECK_LIMIT = 2;
export const MAX_MERGE_CHECK_LIMIT = 16;
/** While a server update's soft hold parks new checks, how often the gate looks again (BOS-420). */
export const PARKED_RETRY_MS = 30_000;

/** Tickets that jump the queue: owner-marked urgent work, and arch fixes (the gate's own repairs). */
export function checkPriority(t: { urgent?: boolean | null; title?: string | null }): number {
  if (t.urgent) return 0;
  if (/^\s*arch fix\b/i.test(t.title ?? "")) return 0;
  return 1;
}

type Waiter = { priority: number; seq: number; alone: boolean; grant: () => void; cancelled: boolean };

export function checkGate(db: Db) {
  let running = 0;
  let aloneRunning = false;
  let seq = 0;
  const queue: Waiter[] = [];

  async function limit(): Promise<number> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MERGE_CHECK_LIMIT_KEY));
    const n = Number(row?.value);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_MERGE_CHECK_LIMIT) : DEFAULT_MERGE_CHECK_LIMIT;
  }

  let parked: ReturnType<typeof setTimeout> | null = null;
  async function pump() {
    // A server update waiting for a quiet machine (BOS-420): checks already running finish, no new one starts.
    // One timer looks again every 30 s, so the parked checks start soon after the hold lifts.
    if (queue.some((w) => !w.cancelled) && (await softHold(db).catch(() => ({ on: false as const }))).on) {
      parked ??= setTimeout(() => {
        parked = null;
        void pump();
      }, PARKED_RETRY_MS);
      parked.unref?.();
      return;
    }
    const max = await limit().catch(() => DEFAULT_MERGE_CHECK_LIMIT);
    while (!aloneRunning && running < max && queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const next = queue[0]!;
      // A check that must run alone waits for the others to finish, and holds back those behind it.
      if (next.alone && running > 0) break;
      queue.shift();
      if (next.cancelled) continue;
      running++;
      if (next.alone) aloneRunning = true;
      next.grant();
    }
  }

  return {
    limit,
    async setLimit(n: number): Promise<number> {
      const value = Math.min(Math.max(Math.trunc(n), 1), MAX_MERGE_CHECK_LIMIT);
      await db.insert(settings).values({ key: MERGE_CHECK_LIMIT_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      void pump();
      return value;
    },
    /** What is running and what waits, for tests and status. */
    state: () => ({ running, waiting: queue.filter((w) => !w.cancelled).length }),
    /** Looks at the queue again now, e.g. when a server update's soft hold lifts (BOS-420). */
    pump: () => pump(),
    /** Runs `work` once a slot is free; lower priority numbers go first, ties in arrival order. `alone`: nothing else runs beside it. */
    async run<T>(priority: number, alone: boolean, work: () => Promise<T>): Promise<T> {
      await new Promise<void>((resolve) => {
        queue.push({ priority, seq: seq++, alone, grant: resolve, cancelled: false });
        void pump();
      });
      try {
        return await work();
      } finally {
        running--;
        if (alone) aloneRunning = false;
        void pump();
      }
    },
  };
}
