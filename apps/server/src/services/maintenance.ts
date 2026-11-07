// Runner updates by "drain, then swap" (docs/09-self-deploy.md, phase 2). One server-wide hold,
// separate from a company's Pause: while it is on, the scheduler starts no new run anywhere.
// Runs already going finish. Each company's runner is recreated on the new image as soon as that
// company has no run, and when every runner is on it the hold lifts by itself.
// The hold is one `settings` row, so there is no migration and a restart keeps it.
import { rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, decisions, runs, settings } from "../db/schema.js";
import { CANCEL_UPDATE, KEEP_WAITING_MORE, STOP_AND_UPDATE } from "./decisions.js";
import type { NotifyInput } from "./notifications.js";

export const MAINTENANCE_KEY = "maintenance";
/** Said to every running agent when a runner update starts waiting, and after each ticket move while it waits. */
export const WRAP_UP = "A runner update is waiting for your run to end. Commit your work, update your ticket, then end your turn now. Don't start anything new: you'll be woken again once the update is done.";
/** How the last runner update ended, for Settings (BOS-465). `swapped` says which companies it swapped, so a later Settings visit knows which history belongs to which runner. */
export type LastUpdate = { at: string; startedAt: string | null; ok: boolean; title: string; body: string; swapped?: Record<string, string> };
export const MAINTENANCE_LAST_KEY = "maintenance:last";
/** The status_reason a held wake carries; it stays queued (like a paused company's) and launches once the hold lifts. */
export const HOLD_REASON = "update pending";

export type Hold = {
  reason: string;
  since: string;
  deadline: string;
  /** How long one wait is: the first deadline, and each "Keep waiting". */
  minutes: number;
  /** The owner chose "Stop the remaining runs and update now". */
  force?: boolean;
  /** slug -> when its runner was recreated; the hold waits for these to reconnect. */
  swapped?: Record<string, string>;
  /** slug -> why its runner could not be recreated. */
  failed?: Record<string, string>;
  /** slug -> failed recreate tries so far and when the last was; a recreate is tried up to RECREATE_TRIES times before it counts as failed. */
  tries?: Record<string, { n: number; at: string }>;
  /** The "update is stuck" page has been sent for this hold (once). */
  stalledPaged?: boolean;
};

export const RECREATE_TRIES = 3;
const RECREATE_RETRY_MS = 30_000;

export async function getHold(db: Db): Promise<Hold | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, MAINTENANCE_KEY));
  return (row?.value as Hold | null | undefined) ?? null;
}

export type FleetRunner = { slug: string; companyId: string | null; current: boolean | undefined };

export type MaintenanceDeps = {
  /** The launcher's runners, each with its company and whether it runs the current image. */
  fleet: () => Promise<FleetRunner[]>;
  recreate: (slug: string) => Promise<unknown>;
  connected: (companyId: string) => Promise<boolean>;
  /** Resolves when no scheduling pass is mid-flight, so a count of runs taken after it cannot be outdated by a launch. */
  settled: () => Promise<unknown>;
  tick: () => Promise<unknown>;
  notify: (n: NotifyInput) => Promise<unknown>;
  /** Sends a message into every run still going, so agents wrap up instead of looking for more work. */
  tellRunning?: (text: string) => Promise<unknown>;
  /** The hold has lifted: wake the agents who ended their runs for it, as WRAP_UP promised (BOS-574). */
  afterHold?: (since: Date) => Promise<unknown>;
  /** The deployer folder; update-runner.sh drops inbox/drain.json there to ask for a drain. */
  dir?: string;
  drainMinutes?: number;
  /** A recreated runner that has not reconnected after this long is reported, and the hold lifts anyway. */
  reconnectMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
};

export function maintenanceService(db: Db, deps: MaintenanceDeps) {
  const now = deps.now ?? (() => new Date());
  const reconnectMs = deps.reconnectMs ?? 5 * 60_000;
  const trigger = deps.dir && path.join(deps.dir, "inbox", "drain.json");

  const save = (h: Hold) => db.insert(settings).values({ key: MAINTENANCE_KEY, value: h }).onConflictDoUpdate({ target: settings.key, set: { value: h } });

  async function activeByCompany() {
    const rows = await db.select({ companyId: runs.companyId, n: sql<number>`count(*)::int` }).from(runs).where(isNull(runs.endedAt)).groupBy(runs.companyId);
    return new Map(rows.map((r) => [r.companyId, r.n]));
  }

  async function withdrawQuestion() {
    await db
      .update(decisions)
      .set({ status: "withdrawn", dedupeKey: null })
      .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'maintenance'`));
  }

  async function end(title: string, level: NotifyInput["level"], body: string) {
    const h = await getHold(db);
    const last: LastUpdate = { at: now().toISOString(), startedAt: h?.since ?? null, ok: level !== "page", title, body, ...(h?.swapped ? { swapped: h.swapped } : {}) };
    await db.insert(settings).values({ key: MAINTENANCE_LAST_KEY, value: last }).onConflictDoUpdate({ target: settings.key, set: { value: last } });
    await db.delete(settings).where(eq(settings.key, MAINTENANCE_KEY));
    await withdrawQuestion();
    await deps.notify({ companyId: null, level, title, body, link: "#/settings" });
    // The agents that wrapped up for the update are woken again, as they were told they would be (BOS-574).
    if (h && deps.afterHold) await deps.afterHold(new Date(h.since)).catch((err) => deps.log?.(`waking agents after the update failed: ${(err as Error).message}`));
    // Held wakes were only waiting; one pass starts them.
    await deps.tick();
  }

  /** The one question at a deadline. The key names the deadline, so "Keep waiting" earns a new one at the next. */
  async function askAtDeadline(h: Hold, n: number, inCompanies: number) {
    const [home] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    if (!home) return;
    const options = [STOP_AND_UPDATE, KEEP_WAITING_MORE(h.minutes), CANCEL_UPDATE];
    await db
      .insert(decisions)
      .values({
        companyId: home.id,
        kind: "approval",
        question: `The runner update has waited ${h.minutes} minutes and ${n} run${n === 1 ? " is" : "s are"} still going in ${inCompanies} compan${inCompanies === 1 ? "y" : "ies"}. Stop them and update now (crash recovery restarts them on the new runner, which can repeat work), keep waiting, or cancel the update? Nothing new starts anywhere until you answer.`,
        options,
        recommendedOption: options[1]!,
        dedupeKey: `maintenance:${h.since}:${h.deadline}`,
        context: { type: "maintenance", since: h.since },
      })
      .onConflictDoNothing();
  }

  const self = {
    /** Turns the hold on. Idempotent: a second call returns the hold that is already on. // leader-only */
    async start(opts: { reason?: string; minutes?: number } = {}): Promise<Hold> {
      const have = await getHold(db);
      if (have) return have;
      const minutes = opts.minutes ?? deps.drainMinutes ?? 30;
      const t = now();
      const h: Hold = { reason: opts.reason ?? "runner update", since: t.toISOString(), deadline: new Date(t.getTime() + minutes * 60_000).toISOString(), minutes };
      await save(h);
      await deps.tellRunning?.(WRAP_UP).catch((err) => deps.log?.(`telling running agents to wrap up failed: ${(err as Error).message}`));
      await deps.notify({ companyId: null, level: "note", title: "Update pending: waiting for runs to finish", body: `Nothing new starts in any company. Each runner is swapped as its company goes idle. If runs are still going after ${minutes} minutes, you will be asked.`, link: "#/settings" });
      return h;
    },

    /** What the banner shows. */
    async status() {
      const h = await getHold(db);
      const [l] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, MAINTENANCE_LAST_KEY));
      const last = (l?.value ?? null) as LastUpdate | null;
      // A past failure is history once every runner is connected on the new image: say so, not the old problem.
      let healthy = false;
      if (!h && last && !last.ok) {
        try {
          const fleet = await deps.fleet();
          healthy = fleet.length > 0 && (await Promise.all(fleet.map(async (r) => r.current === true && !!r.companyId && (await deps.connected(r.companyId))))).every(Boolean);
        } catch {
          healthy = false;
        }
      }
      if (!h) return last && !last.ok ? { on: false as const, last, healthy } : { on: false as const, last };
      const active = await activeByCompany();
      return { on: true as const, reason: h.reason, since: h.since, deadline: h.deadline, runs: [...active.values()].reduce((a, b) => a + b, 0), companies: active.size, last };
    },

    /** Lifts the hold without finishing the swap; runners already swapped stay on the new image. // leader-only */
    async cancel() {
      const h = await getHold(db);
      if (!h) return false;
      await end("Runner update cancelled", "note", "New runs start again. Runners not swapped yet still run the old image; start the update again when you like.");
      return true;
    },

    /** The owner's answer to the deadline question. */
    async answered(answer: string) {
      const h = await getHold(db);
      if (!h) return;
      if (answer === STOP_AND_UPDATE) await save({ ...h, force: true });
      else if (answer === CANCEL_UPDATE) await self.cancel();
      else await save({ ...h, deadline: new Date(now().getTime() + h.minutes * 60_000).toISOString() });
    },

    /**
     * One pass of the drain, called every few seconds. // leader-only: phase 3 runs this on the leader alone.
     * It starts a drain when update-runner.sh asked for one, swaps each idle company's runner,
     * asks at the deadline, and lifts the hold once every runner is on the new image.
     */
    async step() {
      let asked = false;
      if (trigger && (await stat(trigger).then(() => true, () => false))) {
        await readFile(trigger, "utf8").catch(() => ""); // contents are not used: the file's existence is the request
        await rm(trigger, { force: true });
        asked = true;
      }
      let h = await getHold(db);
      if (!h && asked) h = await self.start({ reason: "runner update" });
      if (!h) return;

      let fleet: FleetRunner[];
      try {
        fleet = await deps.fleet();
      } catch (err) {
        deps.log?.(`drain: the launcher did not answer: ${(err as Error).message}`);
        return;
      }
      if (fleet.some((r) => r.current === undefined)) {
        await end("Runner update stopped", "page", "The launcher is older than the server and cannot say which runners are on the new image. Update the launcher (scripts/deploy.sh --runner), then start the update again.");
        return;
      }
      const t = now();
      let active = await activeByCompany();
      const total = [...active.values()].reduce((a, b) => a + b, 0);
      if (!h.force && total > 0 && t >= new Date(h.deadline)) await askAtDeadline(h, total, active.size);

      const failed = { ...h.failed };
      const swapped = { ...h.swapped };
      const tries = { ...h.tries };
      for (const r of fleet) {
        if (r.current || failed[r.slug]) continue;
        if (swapped[r.slug] && t.getTime() - new Date(swapped[r.slug]!).getTime() < 60_000) continue;
        if (tries[r.slug] && t.getTime() - new Date(tries[r.slug]!.at).getTime() < RECREATE_RETRY_MS) continue;
        if (!h.force && r.companyId && (active.get(r.companyId) ?? 0) > 0) continue;
        // A pass that began before the hold may still be launching; wait for it, then look again.
        await deps.settled();
        active = await activeByCompany();
        if (!h.force && r.companyId && (active.get(r.companyId) ?? 0) > 0) continue;
        try {
          await deps.recreate(r.slug); // leader-only
          swapped[r.slug] = now().toISOString();
          delete tries[r.slug];
        } catch (err) {
          const n = (tries[r.slug]?.n ?? 0) + 1;
          tries[r.slug] = { n, at: now().toISOString() };
          deps.log?.(`drain: could not recreate ${r.slug} (try ${n} of ${RECREATE_TRIES}): ${(err as Error).message}`);
          if (n >= RECREATE_TRIES) failed[r.slug] = (err as Error).message;
        }
      }
      h = { ...h, swapped, failed, tries };
      // No swap for twice the reconnect time while runners still wait: say so once, so a hold is never silently stuck.
      const waiting = fleet.filter((r) => !r.current && !failed[r.slug] && !swapped[r.slug]);
      if (waiting.length && !h.stalledPaged) {
        const lastProgress = Math.max(new Date(h.since).getTime(), ...Object.values(swapped).map((s) => new Date(s).getTime()));
        if (t.getTime() - lastProgress >= 2 * reconnectMs) {
          h = { ...h, stalledPaged: true };
          await deps.notify({ companyId: null, level: "page", title: "Runner update is stuck", body: `No runner has been swapped for ${Math.round((t.getTime() - lastProgress) / 60_000)} minutes. Still waiting on: ${waiting.map((r) => r.slug).join(", ")}. New runs are held everywhere. Open Settings > Server and runner: wait for that company to finish, or cancel the update.`, link: "#/settings" });
        }
      }
      await save(h);

      if (fleet.some((r) => !r.current && !failed[r.slug] && !swapped[r.slug])) return; // still waiting for an idle company
      // Everything is swapped or failed. Re-read what runs the new image before judging.
      const after = await deps.fleet().catch(() => fleet);
      if (after.some((r) => !r.current && !failed[r.slug])) return;
      const slow: string[] = [];
      for (const r of after) {
        const at = swapped[r.slug];
        if (!at || !r.companyId || (await deps.connected(r.companyId))) continue;
        if (now().getTime() - new Date(at).getTime() < reconnectMs) return; // give it time to dial in
        slow.push(r.slug);
      }
      // A runner that failed to swap but came back by itself on the new image needs nothing from the owner.
      for (const r of after) if (failed[r.slug] && r.current && r.companyId && (await deps.connected(r.companyId))) delete failed[r.slug];
      const bad = [...Object.entries(failed).map(([s, m]) => `${s}: ${m}`), ...slow.map((s) => `${s}: has not reconnected`)];
      // The hold lifts either way: keeping every company stopped for one runner would cost more than it protects.
      if (bad.length) await end("Runner update finished with problems", "page", `${bad.join("; ")}. New runs have started again. Check Settings > Runner for those companies.`);
      else await end("Runners updated", "note", `${after.length ? `All ${after.length} runner${after.length === 1 ? " is" : "s are"}` : "No runners were"} on the new image. New runs have started again.`);
    },
  };
  return self;
}
export type Maintenance = ReturnType<typeof maintenanceService>;
