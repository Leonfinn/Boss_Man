// Milestones the owner put in the CEO's hands (BOS-2581, step 3 of the milestones work). The owner ticks "CEO manages at
// risk" on a milestone (off by default, or on for every milestone at once, which costs more CEO runs). Each sweep reads the
// roadmap's own status rule (milestoneVerdict, via planning.managedMilestones) for the managed milestones only, and wakes that
// company's CEO once each time one turns At risk or Late, with the milestone's title, its target date and the reason line
// under its badge (which names the tickets). Nothing is woken while the status stays the same, and a switched-off milestone
// never wakes anyone. What the CEO was last woken about is kept in settings (milestone_risk:<milestoneId>), so a restart
// neither repeats a wake nor loses one.
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

type Kept = { status: string | null; managed: boolean };

export function milestoneRiskService(db: Db, deps: { planning: ReturnType<typeof planningService>; wake: (input: { agentId: string; reason: string; note: string; priority?: number }) => Promise<unknown>; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  return {
    /** One pass (the sweep calls it every minute). Errors in one company don't stop the others. */
    async run(): Promise<{ woken: number }> {
      const kept = await db.select({ key: settings.key, value: settings.value }).from(settings).where(sql`${settings.key} like 'milestone_risk:%'`);
      const seen = new Map<string, Kept>(kept.map((r) => [r.key.slice("milestone_risk:".length), r.value as Kept]));
      // A milestone switched off (or deleted) forgets its last wake, so switching it on again starts afresh. Done first, so
      // the pass that turns the last one off still clears it.
      const forget = async (managed: Array<{ id: string }>) => {
        const live = new Set(managed.map((m) => m.id));
        for (const id of seen.keys()) if (!live.has(id)) await db.delete(settings).where(eq(settings.key, MILESTONE_RISK_KEY(id))).catch(() => undefined);
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
        if (shouldWake) {
          const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, m.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
          if (ceo) {
            const what = m.targetDate ? `Its date is ${m.targetDate}.` : "It has no date.";
            await deps
              .wake({
                agentId: ceo.id,
                reason: MILESTONE_RISK_REASON,
                priority: 3,
                note: `The milestone "${m.title}" under the objective "${m.objective}" at ${m.company} is now ${status === "late" ? "Late" : "At risk"}: ${reasonForWake(m.reason)}. ${what} The owner asked you to manage this one: plan a remedy for it in plain words, and say it to them when they next ask how it is going.`,
              })
              .catch(() => undefined);
            woken++;
          }
        }
        // Record what the next pass compares against: the status the milestone was last woken about. It is cleared as soon
        // as the status leaves At risk/Late, so a return to that state is a new wake; otherwise the last woken status stays.
        const next: Kept = { status: needsCeoPlan(status) ? (shouldWake ? status : (prev?.status ?? null)) : null, managed: true };
        if (!prev || prev.status !== next.status || prev.managed !== next.managed) {
          await db
            .insert(settings)
            .values({ key: MILESTONE_RISK_KEY(m.id), value: next })
            .onConflictDoUpdate({ target: settings.key, set: { value: next } })
            .catch(() => undefined);
        }
      }
      await forget(managed);
      return { woken };
    },
  };
}
