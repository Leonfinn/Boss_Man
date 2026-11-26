// Milestones the owner put in the CEO's hands (BOS-2581, step 3 of the milestones work; BOS-2627 fixed its live failure).
// The owner ticks "CEO manages at risk" on a milestone (off by default, or on for every milestone at once, which costs more
// CEO runs). Each sweep reads the roadmap's own status rule (milestoneVerdict, via planning.managedMilestones) for the
// managed milestones only, and wakes that company's CEO once each time one turns At risk or Late, with the milestone's
// title, its target date and the reason line under its badge (which names the tickets). Nothing is woken while the status
// stays the same, and a switched-off milestone never wakes anyone.
//
// What the CEO was last woken about is kept in settings (milestone_risk:<milestoneId>), so a restart neither repeats a
// wake nor loses one. BOS-2627: that row is written BEFORE the wake is sent, and it only says "wake started" once the wake
// really started one, so a pass that is skipped, that fails part way, or whose wake is dropped tries again next minute
// instead of going quiet for good. That pass also clears a CEO plan left under a milestone that is no longer At risk or Late.
//
// BOS-2633: the wake goes through tellOnce (services/tell-once.ts), the one rule every sweep uses since BOS-2632: it counts
// only when it resolved with a real wake row, and a throw, a "no CEO" null or a dropped wake is logged and answered null, so
// the milestone stays "not woken yet" and the next pass tries again. A company with no CEO has nobody to retry for, so that
// case stays quiet (logged by tellOnce once per pass, not as an error every pass) until a CEO is hired.
import { and, eq, isNull, sql } from "drizzle-orm";
import { ceoPlanWake, dateIn, needsCeoPlan } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, milestones, settings, tickets } from "../db/schema.js";
import type { planningService } from "./planning.js";
import { tellOnce, type Told } from "./tell-once.js";

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

// BOS-2627 follow-up: `woke` says a wake for that status really started. Rows written before 25dcf039 have no `woke`
// (the old code recorded the status whether or not the wake started, so a live row can say "late" with nothing sent);
// those are treated as not woken, so the first pass after the update wakes the CEO once instead of going quiet for good.
// BOS-2650: `sentAt` (a misnomer kept for the row's shape) is the id of the wake that resolved: sender, milestone and time
// in one. A wake the scheduler saved while the CEO could not start (quiet hours, a quota hold, too many ticketless wakes
// that hour) resolves as "queued" the moment it is written, which proves the request was saved, not that the CEO was told.
// So the next pass reads that wake's row and, while it is still "queued" and older than WAKE_GRACE_MS, treats the row as
// not woken and sends again. Without it a saved-but-never-started wake would go quiet for good.
type Kept = { status: string | null; managed: boolean; woke?: boolean; sentAt?: string };

/** How long a saved wake may stay "queued" before this pass assumes it never started and sends again (BOS-2650). */
export const WAKE_GRACE_MS = 30 * 60_000;

export function milestoneRiskService(db: Db, deps: { planning: ReturnType<typeof planningService>; wake: (input: { agentId: string; reason: string; note: string; priority?: number }) => Promise<unknown>; now?: () => Date; log?: (message: string) => void; /** BOS-2650: a wake's current status (and when it was saved) by its row id; null when it can't be read. BOS-2653: `createdAt` is the real send time the grace is measured from, because `sentAt` holds the wake's id, not a time. */ wakeStatus?: (wakeId: string) => Promise<{ status: string; createdAt?: Date | string | null } | null> }) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  return {
    /** One pass (the sweep calls it every minute). Errors in one company don't stop the others. */
    async run(): Promise<{ woken: number }> {
      const kept = await db.select({ key: settings.key, value: settings.value }).from(settings).where(sql`${settings.key} like 'milestone_risk:%'`);
      const seen = new Map<string, Kept>(kept.map((r) => [r.key.slice("milestone_risk:".length), r.value as Kept]));
      // The row each milestone's last wake made, this pass, so a row that looks stale (a wake this very pass is still
      // waiting) is not woken a second time on the same pass.
      const justSent = new Map<string, { id: string; at: Date }>();
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
        let prev = seen.get(m.id) ?? null;
        const status = m.status;
        // BOS-2650: a row that says its wake started counts only once that wake really left the queue. A wake the
        // scheduler saved while the CEO could not start (quiet hours, a quota hold, or too many ticketless wakes that
        // hour) resolves as "queued" and starts nothing, so it must not go quiet for good. Reading that, from this pass's
        // own send or from the wake's row, and treating a stuck one as not woken is the same either way.
        let owedFrom: Date | null = null;
        // BOS-2653: `sentAt` holds the wake's row id, not a time, so `new Date(sentAt)` is Invalid Date and the grace
        // below never applied: a held wake was re-sent on every pass. The send time is now the wake row's own `createdAt`
        // (or this pass's send time), and a missing or unreadable one counts as "still waiting", so nothing is re-sent
        // more often than once per grace window.
        let sentTime: Date | null = null;
        if (prev?.woke === true && prev.sentAt) {
          const current = justSent.get(m.id);
          if (current) {
            owedFrom = current.at;
            sentTime = current.at;
          } else if (deps.wakeStatus) {
            try {
              const row = await deps.wakeStatus(prev.sentAt);
              if (row?.status === "queued") {
                const made = row.createdAt ? new Date(row.createdAt) : null;
                owedFrom = made && !Number.isNaN(made.getTime()) ? made : now();
              } else if (!row) {
                // BOS-2653: the wake row is gone (never saved, purged, or written by the broken version that recorded
                // "woken" on a save). Nothing proves the CEO was told, so treat it as not woken and send again now.
                owedFrom = new Date(0);
              }
            } catch (err) {
              log(`milestone at risk: reading the wake for ${m.id} failed: ${(err as Error).message}`);
            }
          }
          if (owedFrom) {
            // A missing/unreadable send time (impossible for a real row) means "just saved": stay quiet this pass.
            const age = sentTime ? now().getTime() - sentTime.getTime() : now().getTime() - owedFrom.getTime();
            const stillWaiting = !Number.isNaN(age) && age <= WAKE_GRACE_MS;
            // BOS-2650: still waiting this soon after it was sent is the scheduler's own hold: leave the row alone, so the
            // next pass finds the wake's row and reads what became of it. Otherwise the earlier "wake started" is undone.
            if (stillWaiting) continue;
            prev = { ...prev, woke: false };
            // Counted again below, so a sentAt from an earlier wake is replaced rather than kept by a no-op write.
            seen.set(m.id, { ...prev, sentAt: undefined });
          }
        }
        // BOS-2627 follow-up: only a row that says its wake really started counts as woken. A row written before 25dcf039
        // has no `woke` (the old code recorded the status whether or not the wake started, and swallowed the failure), and
        // one left by a dropped or failed send says status null; neither is a wake, so the CEO is woken on this pass.
        const lastWoken = prev?.woke === true ? (prev.status ?? null) : null;
        const shouldWake = ceoPlanWake({ managed: true, wasManaged: prev?.managed === true, status, lastWoken: lastWoken as never });
        // BOS-2650: this pass is sending again for a status the CEO was already woken about (that wake never started, or
        // this server's pass sent one and lost the row). The note says so, so the CEO plans again rather than staying quiet.
        const again = shouldWake && prev?.status === status;
        // What the next pass compares against: the status the milestone was last WOKEN about. It is cleared as soon as the
        // status leaves At risk/Late, so a return to that state is a new wake; otherwise the last woken status stays.
        // BOS-2633: the send goes through tellOnce, so the wake counts only when it resolved with a real wake row. A throw or a
        // dropped wake is logged by tellOnce and answers null, and the milestone is not marked woken, so the next pass tries
        // again (BOS-2627 did this locally; this is now the sweeps' one shared rule). A company with no CEO has nobody to
        // tell: there is nothing to retry until one is hired, so this pass records "not woken yet" and says nothing, rather
        // than logging an error (and, through BOS-2160, risking an owner card) on every pass for every managed milestone.
        const delivered = async (): Promise<string | null> => {
          const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, m.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
          if (!ceo) return null;
          const what = m.targetDate ? `Its date is ${m.targetDate}.` : "It has no date.";
          return tellOnce(
            `milestone at risk ${m.title} (${m.id})`,
            () =>
              deps.wake({
                agentId: ceo.id,
                reason: MILESTONE_RISK_REASON,
                priority: 3,
                note: `The milestone "${m.title}" under the objective "${m.objective}" at ${m.company} is now ${status === "late" ? "Late" : "At risk"}: ${reasonForWake(m.reason)}. ${what} The owner asked you to manage this one: work out a short remedy for it and record it with the roadmap tool, action set_plan (milestoneId, plan), so it shows under the milestone's reason on the owner's Roadmap.${again ? " This is another nudge about the same risk: the earlier wake never started, so please still plan it and record it." : ""}`,
              }) as Promise<Told>,
            log,
          );
        };
        // BOS-2627: this pass writes a row BEFORE anything is sent, so a pass cut short (a deploy swap, a restart, a throw)
        // is tried again next pass rather than the milestone going quiet for good. That row says status: null ("woken about
        // nothing yet") when a wake is due, unless the status has now left At risk/Late, which is cleared as before. Only a
        // wake that really started replaces it with the status it was about; a dropped or failed wake leaves it, so the next
        // pass tries again.
        const next: Kept = shouldWake || !needsCeoPlan(status) ? { status: null, managed: true, woke: false } : { status: lastWoken, managed: true, woke: prev?.woke === true };
        // Skipped when nothing changed, so a delivered row isn't rewritten every minute.
        const write = !prev || prev.status !== next.status || prev.managed !== next.managed || prev.woke !== next.woke || (prev.sentAt === undefined && next.sentAt === undefined ? false : prev.sentAt !== next.sentAt);
        if (write) {
          await db
            .insert(settings)
            .values({ key: MILESTONE_RISK_KEY(m.id), value: next })
            .onConflictDoUpdate({ target: settings.key, set: { value: next } })
            .catch((err) => log(`milestone at risk: recording the wake for ${m.id} failed: ${(err as Error).message}`));
        }
        // BOS-2650: the wake's own row id goes in `sentAt`, so the next pass can read whether it ever started (see `owedFrom`).
        const sentAt = now().toISOString();
        const wakeId = shouldWake ? await delivered() : null;
        if (shouldWake && wakeId) {
          woken++;
          const after: Kept = { status, managed: true, woke: true, sentAt: wakeId };
          await db
            .insert(settings)
            .values({ key: MILESTONE_RISK_KEY(m.id), value: after })
            .onConflictDoUpdate({ target: settings.key, set: { value: after } })
            .catch((err) => log(`milestone at risk: recording the wake for ${m.id} failed: ${(err as Error).message}`));
          // BOS-2650: the row above is only as good as the map is wrong: a pass that sent a wake for this status must not
          // send another for it, even when the row it just wrote can't be read back yet (or the write failed).
          seen.set(m.id, after);
          justSent.set(m.id, { id: wakeId, at: new Date(sentAt) });
        }
        // BOS-2627: a CEO plan belongs to a milestone the CEO manages while it is At risk or Late; once it leaves those
        // states the line has nothing to explain, so it goes (and asking to manage it again starts afresh).
        // BOS-2650: "leaving" is read from the milestone as it was, not from the unlocked read above, so two passes running
        // side by side in one process (this sweep is not re-entrant) can't wipe a plan the CEO saved a moment ago.
        if (!needsCeoPlan(status)) await db.update(milestones).set({ ceoPlan: null }).where(and(eq(milestones.id, m.id), sql`${milestones.ceoPlan} is not null`, sql`(${milestones.ceoManagesRisk} = false or ${milestones.targetDate} is null or exists (select 1 from ${tickets} where ${tickets.milestoneId} = ${milestones.id} and ${tickets.systemState} <> 'done' and ${tickets.outcome} is distinct from 'cancelled'))`)).catch((err) => log(`milestone at risk: clearing the plan for ${m.id} failed: ${(err as Error).message}`));
      }
      await forget(managed);
      return { woken };
    },
  };
}
