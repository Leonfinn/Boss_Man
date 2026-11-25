// Milestones the owner put in the CEO's hands (BOS-2581, step 3 of the milestones work; BOS-2627 fixed its live failure).
// The owner ticks "CEO manages at risk" on a milestone (off by default, or on for every milestone at once, which costs more
// CEO runs). Each sweep reads the roadmap's own status rule (milestoneVerdict, via planning.managedMilestones) for the
// managed milestones only, and wakes that company's CEO once each time one turns At risk or Late, with the milestone's
// title, its target date and the reason line under its badge (which names the tickets). Nothing is woken while the status
// stays the same, and a switched-off milestone never wakes anyone.
//
// What the CEO was last woken about is kept in settings (milestone_risk:<milestoneId>), so a restart neither repeats a
// wake nor loses one. BOS-2627: that row is written BEFORE the wake is sent, and it only says "wake started" once wake()
// really started one (a "dropped" or errored send is not a wake), so a pass that is skipped, that fails part way, or whose
// wake is dropped tries again next minute instead of going quiet for good. That pass also clears a CEO plan left under a
// milestone that is no longer At risk or Late.
import { and, eq, isNull, sql } from "drizzle-orm";
import { ceoPlanWake, dateIn, needsCeoPlan } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, milestones, settings } from "../db/schema.js";
import type { planningService } from "./planning.js";

export const MILESTONE_RISK_REASON = "milestone at risk";
export const MILESTONE_RISK_KEY = (milestoneId: string) => `milestone_risk:${milestoneId}`;

/**
 * The reason line without its heading and final full stop: "At risk: Nothing finished … due in 9 days." becomes "Nothing
 * finished … due in 9 days", so the wake says the status itself once and then quotes the same line the page shows.
 */
export function reasonForWake(reason: string | null): string {
  if (!reason) return "";
  return reason
    .replace(/^(At risk|Late):\s*/, "")
    .replace(/\.$/, "")
    .trim();
}

/** A wake counts only when it was queued, deferred or steered (not dropped, and not one wake() never made). */
const started = (outcome: unknown): boolean => {
  const o = (outcome as { outcome?: unknown } | null | undefined)?.outcome;
  return o === "queued" || o === "deferred" || o === "steered";
};

type Kept = { status: string | null; managed: boolean };

export function milestoneRiskService(db: Db, deps: { planning: ReturnType<typeof planningService>; wake: (input: { agentId: string; reason: string; note: string; priority?: number }) => Promise<unknown>; now?: () => Date; log?: (message: string) => void }) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  return {
    /** One pass (the sweep calls it every minute). Errors in one company don't stop the others. */
    async run(): Promise<{ woken: number }> {
      const kept = await db.select({ key: settings.key, value: settings.value }).from(settings).where(sql`${settings.key} like 'milestone_risk:%'`);
      const seen = new Map<string, Kept>(kept.map((r) => [r.key.slice("milestone_risk:".length), r.value as Kept]));
      // A milestone switched off (or deleted) forgets its last wake, so switching it on again starts afresh. Done first, so
      // the pass that turns the last one off still clears it.
      const forget = async (managed: Array<{ id: string }>) => {
        const live = new Set(managed.map((m) => m.id));
        for (const id of seen.keys()) if (!live.has(id)) await db.delete(settings).where(eq(settings.key, MILESTONE_RISK_KEY(id))).catch((err) => log(`milestone at risk: forgetting ${id} failed: ${(err as Error).message}`));
      };
      // The switch is off on every milestone by default, so most passes have nothing more to do: one read of the switch,
      // before any of the roadmap's own work (the first version rebuilt the whole roadmap each minute, which is what ran
      // the merge check past its 30-minute limit).
      const [anyManaged] = await db.select({ id: milestones.id }).from(milestones).where(eq(milestones.ceoManagesRisk, true)).limit(1);
      if (!anyManaged) {
        await forget([]);
        return { woken: 0 };
      }
      const today = dateIn(now(), "UTC");
      // The same reading the Roadmap shows, for the managed milestones only: each status and reason come from
      // milestoneVerdict (BOS-2579).
      const managed = await deps.planning.managedMilestones(today);
      let woken = 0;
      for (const m of managed) {
        const prev = seen.get(m.id) ?? null;
        const status = m.status;
        const shouldWake = ceoPlanWake({ managed: true, wasManaged: prev?.managed ?? false, status, lastWoken: (prev?.status ?? null) as never });
        // What the next pass compares against: the status the milestone was last WOKEN about. It is cleared as soon as the
        // status leaves At risk/Late, so a return to that state is a new wake; otherwise the last woken status stays.
        const delivered = async () => {
          const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, m.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
          if (!ceo) {
            log(`milestone at risk: "${m.title}" (${m.id}) needs a plan but ${m.company} has no CEO to wake`);
            return false;
          }
          const what = m.targetDate ? `Its date is ${m.targetDate}.` : "It has no date.";
          const outcome = await deps.wake({
            agentId: ceo.id,
            reason: MILESTONE_RISK_REASON,
            priority: 3,
            note: `The milestone "${m.title}" under the objective "${m.objective}" at ${m.company} is now ${status === "late" ? "Late" : "At risk"}: ${reasonForWake(m.reason)}. ${what} The owner asked you to manage this one: work out a short remedy for it and record it with the roadmap tool, action set_plan (milestoneId, plan), so it shows under the milestone's reason on the owner's Roadmap.`,
          });
          if (!started(outcome)) {
            log(`milestone at risk: the wake for "${m.title}" (${m.id}) did not start: ${JSON.stringify(outcome)}`);
            return false;
          }
          return true;
        };
        // BOS-2627: this pass writes a row BEFORE anything is sent, so a pass cut short (a deploy swap, a restart, a throw)
        // is tried again next pass rather than the milestone going quiet for good. That row says status: null ("woken about
        // nothing yet") when a wake is due, unless the status has now left At risk/Late, which is cleared as before. Only a
        // wake that really started replaces it with the status it was about; a dropped or failed wake leaves it, so the next
        // pass tries again.
        const next: Kept = { status: shouldWake || !needsCeoPlan(status) ? null : (prev?.status ?? null), managed: true };
        if (!prev || prev.status !== next.status || prev.managed !== next.managed) {
          await db
            .insert(settings)
            .values({ key: MILESTONE_RISK_KEY(m.id), value: next })
            .onConflictDoUpdate({ target: settings.key, set: { value: next } })
            .catch((err) => log(`milestone at risk: recording the wake for ${m.id} failed: ${(err as Error).message}`));
        }
        if (shouldWake && (await delivered())) {
          woken++;
          const after: Kept = { status, managed: true };
          await db
            .insert(settings)
            .values({ key: MILESTONE_RISK_KEY(m.id), value: after })
            .onConflictDoUpdate({ target: settings.key, set: { value: after } })
            .catch((err) => log(`milestone at risk: recording the wake for ${m.id} failed: ${(err as Error).message}`));
        }
        // BOS-2627: a CEO plan belongs to a milestone the CEO manages while it is At risk or Late; once it leaves those
        // states the line has nothing to explain, so it goes (and asking to manage it again starts afresh).
        if (!needsCeoPlan(status)) await db.update(milestones).set({ ceoPlan: null }).where(and(eq(milestones.id, m.id), sql`${milestones.ceoPlan} is not null`)).catch((err) => log(`milestone at risk: clearing the plan for ${m.id} failed: ${(err as Error).message}`));
      }
      await forget(managed);
      return { woken };
    },
  };
}
