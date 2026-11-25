// R46 (BOS-1814): the alarm for idle check capacity. A machine with a free check slot that has not taken a queued job it
// could take is told to the CEO after 5 minutes and paged to the owner after 30, each once per machine and job. Reasons the
// owner already sees elsewhere (`expected`: the server-update pause, their own per-machine setting) are shown, never alarmed.
import type { IdleSlot } from "./check-dispatcher.js";
import { tellOnce, type Told } from "./tell-once.js";

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

/**
 * A free slot held back by the "slots kept for merges" rule is the design working, not a fault, while the company has merge
 * activity (a merge check queued or running, or an approved ticket in the merge line, which includes one waiting on GitHub CI
 * for its merge copy; a freshly approved ticket enters the line at once, so no separate "approved N minutes ago" window is
 * needed). Only when the company has had none for this long is the reservation really wasting capacity: then the CEO is told once.
 */
export const IDLE_RESERVE_AFTER_MS = 60 * 60_000;
/** The owner's page for such a slot comes this long after the CEO's, as for any other idle slot (30 min after 5). */
const OWNER_AFTER_CEO_MS = IDLE_OWNER_AFTER_MS - IDLE_CEO_AFTER_MS;

export function checkIdleService(deps: {
  slots: () => IdleSlot[];
  /** True while the company has merge activity (see IDLE_RESERVE_AFTER_MS). Absent: the reserve rule gets no special treatment. */
  mergeActive?: (companyId: string) => Promise<boolean>;
  /** Wakes the company's CEO on the ticket, on a wake that is never dropped. */
  tellCeo: (input: { companyId: string; ticketId: string; note: string }) => Promise<Told>;
  notify: (input: { companyId: string; level: "note" | "flag" | "page"; title: string; body: string; link: string }) => Promise<Told>;
  now?: () => Date;
  /** Where a tell that did not get through is logged (BOS-2632); it is tried again on the next pass. */
  log?: (message: string) => void;
}) {
  const now = deps.now ?? (() => new Date());
  // shortcut: lost on restart, harmless because a restart at worst repeats one wake or page per standing pair; upgrade if that ever annoys.
  // Slot and job pairs already told, so a repeat never happens; forgotten once the pair stops standing.
  const told = new Map<string, { ceo: boolean; owner: boolean }>();

  // shortcut: when each company last had merge activity; lost on restart, harmless because the 60 minutes then count from when the slot was first seen idle.
  const lastActive = new Map<string, number>();

  /** The slots with the merge-reserve rule applied: expected while merges are active, else timed from the last activity. Never throws. */
  async function judged(): Promise<Array<IdleSlot & { ceoAfter: number }>> {
    const t = now().getTime();
    const slots = deps.slots();
    const active = new Map<string, boolean>();
    for (const s of slots) {
      if (s.code !== "slot_rules" || s.expected || !deps.mergeActive || active.has(s.companyId)) continue;
      const on = await deps.mergeActive(s.companyId).catch(() => true); // can't tell: stay quiet rather than wake the CEO for nothing
      active.set(s.companyId, on);
      if (on) lastActive.set(s.companyId, t);
    }
    return slots.map((s) => {
      if (s.code !== "slot_rules" || s.expected || !deps.mergeActive) return { ...s, ceoAfter: IDLE_CEO_AFTER_MS };
      if (active.get(s.companyId)) return { ...s, expected: true, text: `${s.text}; merges are active, so this is the slot kept for them`, ceoAfter: IDLE_CEO_AFTER_MS };
      const last = lastActive.get(s.companyId);
      const since = last && last > s.since.getTime() ? new Date(last) : s.since;
      return { ...s, since, ceoAfter: IDLE_RESERVE_AFTER_MS };
    });
  }

  return {
    /** The slots as the Checks panel and server_status show them (the merge-reserve rule applied). */
    async view(companyId?: string): Promise<IdleSlot[]> {
      const t = now().getTime();
      return (await judged()).filter((s) => !companyId || s.companyId === companyId).map(({ ceoAfter: _c, ...s }) => ({ ...s, minutes: Math.max(0, Math.floor((t - s.since.getTime()) / 60_000)) }));
    },
    /** One pass (the sweep calls it every minute). */
    async run(): Promise<{ ceo: number; owner: number }> {
      const t = now().getTime();
      const out = { ceo: 0, owner: 0 };
      const standing = new Set<string>();
      for (const s of await judged()) {
        if (s.expected) continue;
        const key = `${s.machineKey}:${s.jobId}`;
        standing.add(key);
        const age = t - s.since.getTime();
        const state = told.get(key) ?? { ceo: false, owner: false };
        const line = idleLine({ ...s, minutes: Math.floor(age / 60_000) });
        told.set(key, state);
        // BOS-2632: marked told only once the tell got through; a failed one is logged and tried again next pass.
        if (!state.ceo && age >= s.ceoAfter) {
          state.ceo = !!(await tellOnce(`check idle CEO ${key}`, () => deps.tellCeo({ companyId: s.companyId, ticketId: s.ticketId, note: `Idle check capacity: ${line} Find out why, or say why it is right to wait.` }), deps.log));
          if (state.ceo) out.ceo++;
        }
        if (!state.owner && age >= s.ceoAfter + OWNER_AFTER_CEO_MS) {
          state.owner = !!(await tellOnce(`check idle owner ${key}`, () => deps.notify({ companyId: s.companyId, level: "page", title: "A check machine is idle with a check waiting", body: `${line} The CEO was told after 5 minutes and it has not moved.`, link: `#/merge-queue/${s.companyId}` }), deps.log));
          if (state.owner) out.owner++;
        }
      }
      for (const k of [...told.keys()]) if (!standing.has(k)) told.delete(k);
      return out;
    },
  };
}
