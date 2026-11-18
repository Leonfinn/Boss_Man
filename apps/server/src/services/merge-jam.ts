// The merge line jam alert (BOS-766, spec BOS-590): when merges stop moving and the next move is Boss
// Man's own, the owner hears once, hears again loudly if it is still jammed an hour later, and hears
// that merges are moving again when it clears. The jam is read from the Merge queue screen's own view,
// so the alert can never disagree with what the owner sees there. A jam a card already covers is not
// this sweep's business: the card has its own notification.
import { figureText } from "@boss-man/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, notifications, settings } from "../db/schema.js";
import type { MergeQueueView } from "./merge-queue.js";
import { mergeLineHealth, slowText, startBrakeText, type MergeLineHealth, type StuckLine } from "./merge-line-health.js";

/** The loud reminder comes this long after the first alert, never sooner. */
export const JAM_REMINDER_MS = 60 * 60_000;

/** One jam, kept across restarts: from the first jammed row until none is left. */
export type JamEpisode = {
  /** When the first alert for this jam went out. */
  firstAlertAt: string;
  /** True once the loud reminder has gone. */
  reminded: boolean;
  /** The jam alerts sent for this episode, marked read at the all-clear. */
  notificationIds: string[];
  /**
   * False while the first alert was held back as a plain feed note (quiet hours), so the owner was never
   * told above the feed: there is no all-clear to send for a jam they never heard about (BOS-819). Absent on
   * an episode written before this field existed; such an episode already sent its alert, so it counts as told.
   */
  ownerTold?: boolean;
};

/** The level a jam alert reached the owner at: a flag or a page tells them; a held-back note does not. */
export function reachesOwner(n: { level: string } | null | undefined): boolean {
  return n?.level === "flag" || n?.level === "page" || n?.level === "ask";
}

/** The CEO's wake when the start brake is off and the line has grown (R47); a waiting-class reason in wake-classes.ts. */
export const BRAKE_OFF_REASON = "merge start brake off";

const KEY =(companyId: string) => `merge_jam:${companyId}`;

/** At most one "merging, but slowly" feed note per company in this long (BOS-1594). */
export const SLOW_NOTE_EVERY_MS = 24 * 60 * 60_000;

/**
 * The line's verdict (BOS-1594): the one the Merge queue read carries, so the banner and this alert agree. A view that
 * has none (an older caller) is classified here by the same function.
 */
export function lineOf(view: MergeQueueView, at: Date): MergeLineHealth {
  return view.line ?? mergeLineHealth(view, { now: at });
}

/** The first alert's words: which piece of work, how long, and what Boss Man does next. */
export function firstAlert(line: { title: string; body: string }): { title: string; body: string } {
  return { title: `Merges are stuck: ${line.title}`, body: line.body };
}

export function mergeJamService(
  db: Db,
  deps: {
    /** The same read the Merge queue screen makes, for one company. */
    view: (companyId: string) => Promise<MergeQueueView>;
    /** Returns the owner's notification as delivered (its `level` after quiet hours), or null when none was written. */
    notify: (input: { companyId: string; level: "note" | "flag" | "page"; title: string; body: string; link: string }) => Promise<{ id: string; level: string } | null>;
    /** Wakes the company's CEO on a ticket with a note (BOS-1078: a card holding a merge looks stale); without it nothing is sent. */
    tellCeo?: (input: { companyId: string; ticketId: string; note: string; /** The wake's reason; the stale-card reason when absent. */ reason?: string }) => Promise<unknown>;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());

  async function readEpisode(companyId: string): Promise<JamEpisode | null> {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY(companyId)));
    return (row?.value as JamEpisode | null | undefined) ?? null;
  }

  async function writeEpisode(companyId: string, episode: JamEpisode | null) {
    if (!episode) {
      await db.delete(settings).where(eq(settings.key, KEY(companyId)));
      return;
    }
    await db
      .insert(settings)
      .values({ key: KEY(companyId), value: episode })
      .onConflictDoUpdate({ target: settings.key, set: { value: episode } });
  }

  /** The stuck verdict in the alert's words: what is stuck, why, and the one step that fixes it, then how many wait behind it. */
  function stuckLine(s: StuckLine): { title: string; body: string } {
    const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
    return {
      title: s.title,
      // R43: the banner's own words for this figure (mergeQueue.behindIt).
      body: `${end(s.reason)} Fix: ${end(s.fix)}${s.others > 0 ? ` ${figureText("mergeQueue.behindIt", s.others)}.` : ""}`,
    };
  }

  /**
   * Merging, but slowly (BOS-1594): a calm feed note, never a flag or page, at most one a day. Claimed before sending,
   * so two passes can't both send it.
   */
  async function slowNote(companyId: string, line: Extract<MergeLineHealth, { state: "over_capacity" }>, t: Date): Promise<boolean> {
    const key = `merge_slow_note:${companyId}`;
    const [seen] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    const lastAt = (seen?.value as { at?: string } | undefined)?.at;
    if (lastAt && t.getTime() - new Date(lastAt).getTime() < SLOW_NOTE_EVERY_MS) return false;
    await db.insert(settings).values({ key, value: { at: t.toISOString() } }).onConflictDoUpdate({ target: settings.key, set: { value: { at: t.toISOString() } } });
    const clock = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
    await deps.notify({ companyId, level: "note", title: "Merging, but slowly", body: slowText(line, clock), link: `#/merge-queue/${companyId}` });
    return true;
  }

  /**
   * A card holding an approved merge that looks stale (BOS-1078: it names a ticket that is done now) is put to the
   * CEO once per card, to check and withdraw or answer. Only a hint: nothing is closed by itself.
   */
  async function flagStaleHolds(companyId: string, view: MergeQueueView) {
    if (!deps.tellCeo) return;
    for (const w of view.waiting) {
      const card = w.card;
      if (!card?.staleHint || card.kind !== "hold") continue;
      const key = `merge_hold_stale:${card.id}`;
      const [seen] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, key));
      if (seen) continue;
      // Claimed before telling, so two passes can't both send it.
      const claimed = await db.insert(settings).values({ key, value: { at: now().toISOString(), ticketId: w.ticketId } }).onConflictDoNothing().returning({ key: settings.key });
      if (!claimed.length) continue;
      const ref = w.ref ?? `"${w.title}"`;
      await deps
        .tellCeo({
          companyId,
          ticketId: w.ticketId,
          note: `${ref} is approved${w.signedOffAt ? " and signed off" : ""}, but its merge is held by ${card.raisedBy ?? "Boss Man"}'s card ${card.id}: "${card.question}". ${card.staleHint} Check it: if it's no longer needed, ask ${card.raisedBy ?? "its raiser"} to withdraw it (or withdraw it yourself if its ticket is finished) so the merge goes on; if it is still needed, leave it.`,
        })
        .catch(() => undefined);
    }
  }

  /**
   * R47: the start brake has no limit and the line has grown for an hour: the CEO is woken once per episode, with the limit
   * to set. The episode ends (and a later one may wake again) once the warning is gone: a limit was set or the line shrank.
   */
  async function brakeOffEpisode(companyId: string, view: MergeQueueView) {
    const key = `merge_brake_off:${companyId}`;
    const warn = view.startBrakeOff;
    if (!warn) {
      await db.delete(settings).where(eq(settings.key, key));
      return;
    }
    const first = view.waiting[0];
    if (!deps.tellCeo || !first) return;
    // Claimed before telling, so two passes can't both send it.
    const claimed = await db.insert(settings).values({ key, value: { at: now().toISOString() } }).onConflictDoNothing().returning({ key: settings.key });
    if (!claimed.length) return;
    await deps
      .tellCeo({
        companyId,
        ticketId: first.ticketId,
        reason: BRAKE_OFF_REASON,
        note: `${startBrakeText(warn)}. The merge line has grown for an hour and new starts are not held. The owner sets the limit in Settings → "Hold new starts while this many merges are waiting"; ask them to, with the suggested number. This is the one wake for this stretch.`,
      })
      .catch(() => undefined);
  }

  return {
    /** One pass for every company with a jam going, or unpaused: the first alert, the reminder, or the all-clear. Safe to call often. */
    async run(): Promise<{ alerted: number; reminded: number; cleared: number }> {
      const t = now();
      const out = { alerted: 0, reminded: 0, cleared: 0 };
      const all = await db.select({ id: companies.id, paused: companies.paused }).from(companies);
      for (const { id: companyId, paused } of all) {
        // A paused company's episode is still read, so a jam that clears while paused gets its all-clear
        // and is not alerted on again after a restart; nothing starts while paused, so it raises nothing.
        const episode = await readEpisode(companyId);
        if (paused && !episode) continue;
        // A failing read leaves the episode as it is: the next pass tries again.
        const view = await deps.view(companyId).catch(() => null);
        if (!view) continue;
        await flagStaleHolds(companyId, view);
        await brakeOffEpisode(companyId, paused ? { ...view, startBrakeOff: null } : view).catch(() => undefined);
        const health = lineOf(view, t);
        const jam = health.state === "stuck" ? health : null;
        const jammed = jam !== null;
        // Landing but slow is not a jam: no flag, no page, one feed note a day (BOS-1594).
        if (health.state === "over_capacity" && !paused) await slowNote(companyId, health, t).catch(() => undefined);
        // Merges moving again, and the owner was told about the jam: one quiet note, and the jam alerts
        // are read. A jam whose first alert was held back (quiet hours made it a feed note) gets no
        // all-clear: an all-clear for a jam they never heard about is worse than silence (BOS-819). A failed
        // read above left the episode alone rather than calling this a clear.
        if (!jammed) {
          if (!episode) continue;
          if (episode.ownerTold !== false) {
            const link = `#/merge-queue/${companyId}`;
            await deps.notify({ companyId, level: "note", title: "Merges are moving again", body: "The merge line is clear: nothing is stuck any more.", link });
            if (episode.notificationIds.length) {
              await db
                .update(notifications)
                .set({ readAt: t })
                .where(and(inArray(notifications.id, episode.notificationIds), isNull(notifications.readAt)));
            }
          }
          await writeEpisode(companyId, null);
          out.cleared++;
          continue;
        }
        if (paused) continue;
        const link = `#/merge-queue/${companyId}`;
        if (!episode) {
          const line = stuckLine(jam!);
          const alert = firstAlert(line);
          const sent = await deps.notify({ companyId, level: "flag", title: alert.title, body: alert.body, link });
          await writeEpisode(companyId, { firstAlertAt: t.toISOString(), reminded: false, notificationIds: sent ? [sent.id] : [], ownerTold: reachesOwner(sent) });
          if (sent) out.alerted++;
          continue;
        }
        const due = t.getTime() - new Date(episode.firstAlertAt).getTime() >= JAM_REMINDER_MS;
        if (episode.reminded || !due) continue;
        const line = stuckLine(jam!);
        const sent = await deps.notify({
          companyId,
          level: "page",
          title: "Merges are still stuck",
          body: `An hour on, merges are still not moving. ${line.title}: ${line.body}`,
          link,
        });
        await writeEpisode(companyId, { ...episode, reminded: true, notificationIds: sent ? [...episode.notificationIds, sent.id] : episode.notificationIds, ownerTold: episode.ownerTold !== false || reachesOwner(sent) });
        if (sent) out.reminded++;
      }
      return out;
    },
  };
}
