// Always-on runner watch (BOS-467). Every company's runner should be connected. When one stays
// offline, that company's CEO and the owner are told, with the fix; both notices clear by
// themselves when it reconnects. After a server start it also says whether every runner that
// was connected before the restart came back ("deploy healthy"). It iterates the runners table:
// no company names, paths or hosts are written here. Leader-only.
import { and, eq, like, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, decisions, runners, settings } from "../db/schema.js";
import type { AlertInput } from "./alert-ladder.js";
import type { NotifyInput } from "./notifications.js";

/** A runner offline this long is reported (counted from when this server saw it go, or from when an update hold lifted). */
export const OFFLINE_REPORT_MS = 3 * 60_000;
/** After a server start (or an update hold lifting), every runner that was connected before it should be back within this. */
export const DEPLOY_HEALTHY_MS = 5 * 60_000;

export const runnerOfflineKey = (runnerId: string) => `runner-offline:${runnerId}`;
/** Settings key: the owner was paged about this runner's outage; the value is the runner's lastSeenAt then (BOS-497). */
export const runnerPagedKey = (runnerId: string) => `runner-offline-paged:${runnerId}`;
/** Settings key: this company's runner was seen connected while the launcher didn't run it, so it is registered by hand (BOS-497). */
export const HAND_RUN_KEY = "runner-hand:";
export const handRunKey = (companyId: string) => `${HAND_RUN_KEY}${companyId}`;

export type RunnerWatchDeps = {
  isConnected: (runnerId: string) => boolean;
  /** A runner update's hold swaps runners itself and pages about them; the watch stays quiet then. */
  holdOn: () => Promise<boolean>;
  notify: (n: NotifyInput) => Promise<unknown>;
  alert: (input: AlertInput) => Promise<unknown>;
  /** Companies whose runner the launcher means to keep running (plus those it has never been given); null = unknown (no launcher, or it can't be reached), so all count. */
  wantedCompanies?: () => Promise<Set<string> | null>;
  now?: () => Date;
  log?: (msg: string) => void;
};

export function runnerWatchService(db: Db, deps: RunnerWatchDeps) {
  const now = deps.now ?? (() => new Date());
  // shortcut: lives in this process; a restart starts the clock again, which only delays a notice by a few minutes.
  // The owner's page is also marked in settings (runnerPagedKey), so a restart never pages twice for one outage.
  const offlineSince = new Map<string, number>();
  const paged = new Set<string>(); // owner paged (or already paged before a restart) for this outage
  // CEO card raised for this outage; until then it is tried again every pass.
  // State lost on restart, harmless because the card is deduped by its key, so raising it again changes nothing.
  const carded = new Set<string>();
  // Connected runners whose old cards were already checked once.
  // State lost on restart, harmless because the first pass after a start checks every connected runner again.
  const swept = new Set<string>();
  // Connected runners already compared with the launcher's list this connection.
  // State lost on restart, harmless because it only costs one extra launcher call per runner after a start; the result is kept in settings.
  const handChecked = new Set<string>();
  let boot: { at: number; expected: Set<string>; done: boolean } | null = null;
  let lastHold = false;
  let liftedAt = 0; // when an update hold last lifted: runners it swapped get the usual grace from then

  const steps = (name: string) => `Open Settings > Server and runner, find ${name}'s runner and click "Reconnect runner" (or "Start runner" if it is stopped). Do not use "Update runners" for this. If it goes offline again, tell the CEO what the page says.`;

  async function clear(runnerId: string, name: string) {
    const cleared = await db
      .update(decisions)
      .set({ status: "withdrawn", dedupeKey: null })
      .where(and(eq(decisions.dedupeKey, runnerOfflineKey(runnerId)), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    const unmarked = await db.delete(settings).where(eq(settings.key, runnerPagedKey(runnerId))).returning({ key: settings.key });
    carded.delete(runnerId);
    if (paged.delete(runnerId) || cleared.length || unmarked.length) await deps.notify({ companyId: null, level: "note", title: `${name}'s runner is back`, body: "It reconnected by itself or after a restart. Nothing to do.", link: "#/settings" });
  }

  /** Pages the owner once per outage: the outage is named by the runner's lastSeenAt, which only a reconnect changes. */
  async function pageOnce(r: { id: string; name: string; lastSeenAt: Date }, minutes: number) {
    const mark = r.lastSeenAt.toISOString();
    const [prev] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, runnerPagedKey(r.id)));
    if (prev?.value !== mark) {
      await deps.notify({ companyId: null, level: "page", title: `${r.name}'s runner is offline`, body: `It has been offline for ${minutes}+ minutes, so ${r.name}'s work cannot start. ${steps(r.name)}`, link: "#/settings" });
      await db.insert(settings).values({ key: runnerPagedKey(r.id), value: mark }).onConflictDoUpdate({ target: settings.key, set: { value: mark } });
    }
    paged.add(r.id);
  }

  return {
    /** One pass, called about every 30 s. // leader-only */
    async step() {
      const t = now().getTime();
      const rows = await db
        .select({ id: runners.id, companyId: runners.companyId, lastSeenAt: runners.lastSeenAt, name: companies.name })
        .from(runners)
        .innerJoin(companies, eq(companies.id, runners.companyId));
      if (!boot) {
        // Every runner that has ever connected and was not stopped by the owner (Stop clears lastSeenAt) must come back.
        // No age limit: lastSeenAt is only written on connect, so a long-stable runner has an old one.
        boot = { at: t, expected: new Set(rows.filter((r) => r.lastSeenAt).map((r) => r.id)), done: false };
      }
      const hold = await deps.holdOn();
      if (lastHold && !hold) liftedAt = t;
      lastHold = hold;
      // A runner the launcher no longer wants (stopped, removed or set aside before this check existed) is not an outage.
      // If the launcher can't answer, every runner counts: the launcher being down is itself an outage.
      // Also asked once per connection for a runner that just connected, to notice one registered by hand.
      const ask = rows.some((r) => (deps.isConnected(r.id) ? !handChecked.has(r.id) : !!r.lastSeenAt));
      const wanted = ask ? ((await deps.wantedCompanies?.().catch(() => null)) ?? null) : null;
      const hand = new Set(
        wanted ? (await db.select({ key: settings.key }).from(settings).where(like(settings.key, `${HAND_RUN_KEY}%`))).map((s) => s.key.slice(HAND_RUN_KEY.length)) : [],
      );
      const isWanted = (r: { companyId: string }) => !wanted || wanted.has(r.companyId) || hand.has(r.companyId);
      for (const r of rows) {
        if (deps.isConnected(r.id)) {
          offlineSince.delete(r.id);
          if (wanted && !handChecked.has(r.id)) {
            // Connected, yet the launcher neither runs it nor holds its token: registered by hand, so it must page when it drops.
            if (!wanted.has(r.companyId) && !hand.has(r.companyId)) await db.insert(settings).values({ key: handRunKey(r.companyId), value: true }).onConflictDoNothing();
            handChecked.add(r.id);
          }
          if (paged.has(r.id) || !swept.has(r.id)) await clear(r.id, r.name);
          swept.add(r.id);
          continue;
        }
        handChecked.delete(r.id);
        // Stopped on purpose (the launcher stop clears lastSeenAt): not an outage, and any card raised for the
        // outage before the stop is withdrawn, or it keeps saying the company's work cannot start (BOS-735).
        if (!r.lastSeenAt) {
          offlineSince.delete(r.id);
          swept.delete(r.id);
          if (carded.has(r.id) || paged.has(r.id)) await clear(r.id, r.name);
          continue;
        }
        if (!isWanted(r)) {
          // The launcher answered and doesn't want it, and it was never seen running by hand: a stop from before the
          // launcher cleared lastSeenAt. Clear it now, so it stays quiet even when the launcher later can't answer.
          // Only if it hasn't reconnected since this pass read it.
          if (wanted) {
            await db.update(runners).set({ lastSeenAt: null }).where(and(eq(runners.id, r.id), lt(runners.lastSeenAt, new Date(r.lastSeenAt.getTime() + 1))));
            deps.log?.(`runner watch: ${r.name}'s runner is not wanted by the launcher; treated as stopped`);
          }
          offlineSince.delete(r.id);
          swept.delete(r.id);
          continue;
        }
        swept.delete(r.id);
        if (!offlineSince.has(r.id)) offlineSince.set(r.id, t);
        if (hold) continue;
        // Counted from when this server first saw it offline (so its own restart never makes an old gap count),
        // or from when an update hold lifted (the hold swapped runners; they get the usual time to come back).
        const from = Math.max(offlineSince.get(r.id)!, liftedAt);
        if (t - from < OFFLINE_REPORT_MS) continue;
        const minutes = Math.max(1, Math.round((t - from) / 60_000));
        if (!paged.has(r.id)) await pageOnce({ id: r.id, name: r.name, lastSeenAt: r.lastSeenAt }, minutes);
        if (carded.has(r.id)) continue;
        try {
          await deps.alert({
            companyId: r.companyId,
            question: `Your company's runner is offline (${minutes}+ minutes), so your agents cannot start work. Boss Man has told the owner. The owner's fix: ${steps(r.name)} This card clears by itself when the runner reconnects.`,
            from: "ceo",
            dedupeKey: runnerOfflineKey(r.id),
          });
          carded.add(r.id);
        } catch (err) {
          deps.log?.(`runner watch: alert for ${r.name} failed, will try again: ${(err as Error).message}`);
        }
      }
      // The deploy check: said once, 5 minutes after this server started, or after an update hold lifted if that is later.
      if (!boot.done && !hold && t - Math.max(boot.at, liftedAt) >= DEPLOY_HEALTHY_MS) {
        boot.done = true;
        const missing = rows.filter((r) => boot!.expected.has(r.id) && r.lastSeenAt && !deps.isConnected(r.id) && isWanted(r)).map((r) => r.name);
        if (boot.expected.size === 0) return;
        if (!missing.length) await deps.notify({ companyId: null, level: "note", title: "Deploy healthy: every runner is back", body: `All ${boot.expected.size} runner${boot.expected.size === 1 ? "" : "s"} reconnected after the server started.`, link: "#/settings" });
        else await deps.notify({ companyId: null, level: "page", title: "Deploy not healthy: runners still offline", body: `Not back after ${DEPLOY_HEALTHY_MS / 60_000} minutes: ${missing.join(", ")}. ${missing.map((n) => steps(n)).join(" ")}`, link: "#/settings" });
      }
    },
  };
}
export type RunnerWatch = ReturnType<typeof runnerWatchService>;
