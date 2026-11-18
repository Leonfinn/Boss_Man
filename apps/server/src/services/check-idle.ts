// R46 (BOS-1814): the alarm for idle check capacity. A machine with a free check slot that has not taken a queued job it
// could take is told to the CEO after 5 minutes and paged to the owner after 30, each once per machine and job. Reasons the
// owner already sees elsewhere (`expected`: the server-update pause, their own per-machine setting) are shown, never alarmed.
import type { IdleSlot } from "./check-dispatcher.js";

export const IDLE_CHECK_SLOT_REASON = "idle check slot";
export const IDLE_CEO_AFTER_MS = 5 * 60_000;
export const IDLE_OWNER_AFTER_MS = 30 * 60_000;

/** One line for the Checks panel and server_status: "free, not taking X because …". */
export const idleLine = (s: Pick<IdleSlot, "machine" | "text" | "minutes"> & { ref?: string | null }) =>
  `${s.machine} has a free slot and is not taking ${s.ref ?? "a queued check"} because ${s.text} (${s.minutes} min).`;

/** The shape the Checks panel and server_status show for one idle slot. */
export const idleView = (s: IdleSlot) => ({
  machine: s.machine,
  jobId: s.jobId,
  ticketId: s.ticketId,
  why: s.text,
  code: s.code,
  expected: s.expected,
  minutes: s.minutes,
  line: idleLine({ ...s, ref: `the queued ${s.kind === "merge" ? "merge" : s.scope} check` }),
});

export function checkIdleService(deps: {
  slots: () => IdleSlot[];
  /** Wakes the company's CEO on the ticket, on a wake that is never dropped. */
  tellCeo: (input: { companyId: string; ticketId: string; note: string }) => Promise<unknown>;
  notify: (input: { companyId: string; level: "note" | "flag" | "page"; title: string; body: string; link: string }) => Promise<unknown>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  // Slot and job pairs already told, so a repeat never happens; forgotten once the pair stops standing.
  const told = new Map<string, { ceo: boolean; owner: boolean }>();

  return {
    /** One pass (the sweep calls it every minute). */
    async run(): Promise<{ ceo: number; owner: number }> {
      const t = now().getTime();
      const out = { ceo: 0, owner: 0 };
      const standing = new Set<string>();
      for (const s of deps.slots()) {
        if (s.expected) continue;
        const key = `${s.machineKey}:${s.jobId}`;
        standing.add(key);
        const age = t - s.since.getTime();
        const state = told.get(key) ?? { ceo: false, owner: false };
        const line = idleLine({ ...s, minutes: Math.floor(age / 60_000) });
        if (!state.ceo && age >= IDLE_CEO_AFTER_MS) {
          state.ceo = true;
          told.set(key, state);
          await deps.tellCeo({ companyId: s.companyId, ticketId: s.ticketId, note: `Idle check capacity: ${line} Find out why, or say why it is right to wait.` }).catch(() => undefined);
          out.ceo++;
        }
        if (!state.owner && age >= IDLE_OWNER_AFTER_MS) {
          state.owner = true;
          told.set(key, state);
          await deps.notify({ companyId: s.companyId, level: "page", title: "A check machine is idle with a check waiting", body: `${line} The CEO was told after 5 minutes and it has not moved.`, link: `#/merge-queue/${s.companyId}` }).catch(() => undefined);
          out.owner++;
        }
      }
      for (const k of [...told.keys()]) if (!standing.has(k)) told.delete(k);
      return out;
    },
  };
}
