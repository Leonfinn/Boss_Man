// The merge line jam alert (BOS-766, spec BOS-590): when merges stop moving and the next move is Boss
// Man's own, the owner hears once, hears again loudly if it is still jammed an hour later, and hears
// that merges are moving again when it clears. The jam is read from the Merge queue screen's own view,
// so the alert can never disagree with what the owner sees there. A jam a card already covers is not
// this sweep's business: the card has its own notification.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, notifications, settings } from "../db/schema.js";
import type { MergeQueueView } from "./merge-queue.js";
import { PHASE_LABEL, waitedText } from "./merge-queue.js";

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

const KEY = (companyId: string) => `merge_jam:${companyId}`;

/** The rows that count as this sweep's jam: a long merge check, or stuck work Boss Man is meant to move. */
export function jammedRows(view: Pick<MergeQueueView, "running" | "waiting">): {
  running: Array<{ ref: string | null; title: string; minutes: number; phase: string }>;
  waiting: Array<{ ref: string | null; title: string; minutes: number; label: string; next: string | null }>;
} {
  // An agent's own check before review isn't part of the merge line, and a card row belongs to its card.
  const running = view.running
    .filter((r) => r.what === "merge_check" && r.overLimit)
    .map((r) => ({ ref: r.ref, title: r.title, minutes: r.minutes, phase: r.phase }));
  const waiting = view.waiting
    .filter((w) => w.stuck && w.actor === "system" && !w.decisionId)
    .map((w) => ({ ref: w.ref, title: w.title, minutes: w.minutes, label: w.label, next: w.next }));
  return { running, waiting };
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

  /** One line naming the worst jammed row, then how many others there are. */
  function stuckLine(jam: ReturnType<typeof jammedRows>): { title: string; body: string } {
    if (jam.running.length) {
      const r = jam.running[0]!;
      const others = jam.running.length + jam.waiting.length - 1;
      const ref = r.ref ?? `"${r.title}"`;
      const what = r.phase === "merging" ? "has been merging for" : "has been in its check for";
      return {
        title: `${ref} ${what} ${waitedText(r.minutes)}`,
        body: `${ref} has been in its merge check for ${waitedText(r.minutes)}, past the one-hour limit${r.phase === "queued" ? ", without the check starting" : ""}. Boss Man is still ${PHASE_LABEL[r.phase as keyof typeof PHASE_LABEL] ?? "working on it"}.${others > 0 ? ` ${others === 1 ? "One other piece of work is" : `${others} other pieces of work are`} stuck too.` : ""}`,
      };
    }
    const w = jam.waiting[0]!;
    const others = jam.waiting.length - 1;
    const ref = w.ref ?? `"${w.title}"`;
    return {
      title: `${ref} has waited ${waitedText(w.minutes)} to merge`,
      body: `${ref} is ${w.label} and has waited ${waitedText(w.minutes)}. ${w.next ?? "Boss Man keeps working on it by itself."}${others > 0 ? ` ${others === 1 ? "One other piece of work is" : `${others} other pieces of work are`} stuck too.` : ""}`,
    };
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
        const jam = jammedRows(view);
        const jammed = jam.running.length + jam.waiting.length;
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
          const line = stuckLine(jam);
          const alert = firstAlert(line);
          const sent = await deps.notify({ companyId, level: "flag", title: alert.title, body: alert.body, link });
          await writeEpisode(companyId, { firstAlertAt: t.toISOString(), reminded: false, notificationIds: sent ? [sent.id] : [], ownerTold: reachesOwner(sent) });
          if (sent) out.alerted++;
          continue;
        }
        const due = t.getTime() - new Date(episode.firstAlertAt).getTime() >= JAM_REMINDER_MS;
        if (episode.reminded || !due) continue;
        const line = stuckLine(jam);
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
