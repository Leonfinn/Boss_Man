// A limit on how many merge checks (quick or full) run at once, so a burst of approvals can't exhaust the
// host's memory (BOS-446). The rest wait in order; urgent and "Arch fix" tickets go first. The limit is
// a setting, read on every grant, so changing it takes effect without a restart. The default is host-neutral.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, settings } from "../db/schema.js";

export const MERGE_CHECK_LIMIT_KEY = "merge_check_limit";
export const DEFAULT_MERGE_CHECK_LIMIT = 2;
export const MAX_MERGE_CHECK_LIMIT = 16;

/**
 * Whether an agent's job title puts it in the background lane (BOS-1403). The assignee's title ("Background Developer")
 * is used, not the ticket's "(Background lane)" suffix: the suffix is typed by hand and can be missing or copied.
 */
export function isBackgroundLaneTitle(agentTitle: string | null | undefined): boolean {
  return /\bbackground\b/i.test(agentTitle ?? "");
}

/**
 * Where a ticket's check starts in the line: 0 for owner-marked urgent work and arch fixes (the gate's own repairs), 1 for
 * ordinary tickets, 2 for background-lane tickets, which go last (BOS-1403). It only orders the start; every merge still runs
 * its full check, and a lane ticket with nothing ahead of it starts at once. The owner's Move to front sorts above all of this.
 */
export function checkPriority(t: { urgent?: boolean | null; title?: string | null; background?: boolean | null }): number {
  if (t.urgent) return 0;
  if (/^\s*arch fix\b/i.test(t.title ?? "")) return 0;
  return t.background ? 2 : 1;
}

/** checkPriority for a ticket row, looking up the assignee's job title for the lane. */
export async function ticketCheckPriority(db: Db, t: { urgent?: boolean | null; title?: string | null; assigneeAgentId?: string | null }): Promise<number> {
  let background = false;
  if (t.assigneeAgentId) {
    const [a] = await db.select({ title: agents.title }).from(agents).where(eq(agents.id, t.assigneeAgentId));
    background = isBackgroundLaneTitle(a?.title);
  }
  return checkPriority({ urgent: t.urgent, title: t.title, background });
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

  async function pump() {
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
