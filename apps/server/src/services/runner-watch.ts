// Always-on runner watch (BOS-467). Every company's runner should be connected. When one stays
// offline, that company's CEO and the owner are told, with the fix; both notices clear by
// themselves when it reconnects. After a server start it also says whether every runner that
// was connected before the restart came back ("deploy healthy"). It iterates the runners table:
// no company names, paths or hosts are written here. Leader-only.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, decisions, runners } from "../db/schema.js";
import type { AlertInput } from "./alert-ladder.js";
import type { NotifyInput } from "./notifications.js";

/** A runner offline this long is reported. */
export const OFFLINE_REPORT_MS = 3 * 60_000;
/** After a server start, every runner that was connected before it should be back within this. */
export const DEPLOY_HEALTHY_MS = 5 * 60_000;

export const runnerOfflineKey = (runnerId: string) => `runner-offline:${runnerId}`;

export type RunnerWatchDeps = {
  isConnected: (runnerId: string) => boolean;
  /** A runner update's hold swaps runners itself and pages about them; the watch stays quiet then. */
  holdOn: () => Promise<boolean>;
  notify: (n: NotifyInput) => Promise<unknown>;
  alert: (input: AlertInput) => Promise<unknown>;
  now?: () => Date;
  log?: (msg: string) => void;
};

export function runnerWatchService(db: Db, deps: RunnerWatchDeps) {
  const now = deps.now ?? (() => new Date());
  // shortcut: lives in this process; a restart starts the clock again, which only delays a notice by a few minutes.
  const offlineSince = new Map<string, number>();
  const told = new Set<string>();
  const swept = new Set<string>(); // connected runners whose old cards were already checked once
  let boot: { at: number; expected: Set<string>; done: boolean } | null = null;

  const steps = (name: string) => `Open Settings > Server and runner, find ${name}'s runner and click "Reconnect runner" (or "Start runner" if it is stopped). Do not use "Update runners" for this. If it goes offline again, tell the CEO what the page says.`;

  async function clear(runnerId: string, name: string) {
    const cleared = await db
      .update(decisions)
      .set({ status: "withdrawn", dedupeKey: null })
      .where(and(eq(decisions.dedupeKey, runnerOfflineKey(runnerId)), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (told.delete(runnerId) || cleared.length) await deps.notify({ companyId: null, level: "note", title: `${name}'s runner is back`, body: "It reconnected by itself or after a restart. Nothing to do.", link: "#/settings" });
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
      for (const r of rows) {
        if (deps.isConnected(r.id)) {
          offlineSince.delete(r.id);
          if (told.has(r.id) || !swept.has(r.id)) await clear(r.id, r.name);
          swept.add(r.id);
          continue;
        }
        // Stopped on purpose (the launcher stop clears lastSeenAt): not an outage.
        if (!r.lastSeenAt) {
          offlineSince.delete(r.id);
          swept.delete(r.id);
          continue;
        }
        swept.delete(r.id);
        if (!offlineSince.has(r.id)) offlineSince.set(r.id, t);
        if (hold || told.has(r.id)) continue;
        const since = offlineSince.get(r.id)!;
        // Counted from when this server first saw it offline, so its own restart never makes an old gap count.
        const from = since;
        if (t - from < OFFLINE_REPORT_MS) continue;
        told.add(r.id);
        const minutes = Math.max(1, Math.round((t - from) / 60_000));
        await deps.notify({ companyId: null, level: "page", title: `${r.name}'s runner is offline`, body: `It has been offline for ${minutes}+ minutes, so ${r.name}'s work cannot start. ${steps(r.name)}`, link: "#/settings" });
        await deps
          .alert({
            companyId: r.companyId,
            question: `Your company's runner is offline (${minutes}+ minutes), so your agents cannot start work. Boss Man has told the owner. The owner's fix: ${steps(r.name)} This card clears by itself when the runner reconnects.`,
            from: "ceo",
            dedupeKey: runnerOfflineKey(r.id),
          })
          .catch((err) => deps.log?.(`runner watch: alert for ${r.name} failed: ${(err as Error).message}`));
      }
      // The deploy check: said once, 5 minutes after this server started.
      if (!boot.done && !hold && t - boot.at >= DEPLOY_HEALTHY_MS) {
        boot.done = true;
        const missing = rows.filter((r) => boot!.expected.has(r.id) && r.lastSeenAt && !deps.isConnected(r.id)).map((r) => r.name);
        if (boot.expected.size === 0) return;
        if (!missing.length) await deps.notify({ companyId: null, level: "note", title: "Deploy healthy: every runner is back", body: `All ${boot.expected.size} runner${boot.expected.size === 1 ? "" : "s"} reconnected after the server started.`, link: "#/settings" });
        else await deps.notify({ companyId: null, level: "page", title: "Deploy not healthy: runners still offline", body: `Not back after ${DEPLOY_HEALTHY_MS / 60_000} minutes: ${missing.join(", ")}. ${missing.map((n) => steps(n)).join(" ")}`, link: "#/settings" });
      }
    },
  };
}
export type RunnerWatch = ReturnType<typeof runnerWatchService>;
