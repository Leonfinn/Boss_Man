// Server updates wait for a quiet machine (BOS-420, DR-008 Q3). On 3 Nov an approved update started on a host
// that was already full: it built an image and ran a second server beside the live one, the host ran out of
// memory and the update was switched back. Now an approved update is not sent to the host deployer at once.
// It waits until the machine is quiet: enough free memory (the host's own headroom report), no merge check in
// flight, and only a few runs going. While it waits, and through the update's standby window, a soft hold
// makes room: no new merge check starts and the scheduler starts fewer runs. Runs and checks already going
// finish normally; nothing is cut off. After the window it hands over to the runner update's drain (DR-006).
//
// The whole wait is one `settings` row, so a restart or a blue/green swap keeps it (no migration). Its deadline
// is an absolute time and its card is keyed on that deadline, so a restart neither resets the wait nor asks twice.
// Nothing ever sends by itself without room: after 30 minutes the owner gets one card (keep waiting, update now
// anyway, cancel), and a soft hold older than 3 hours lifts itself with a page so work can't stay capped for ever.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, decisions, settings } from "../db/schema.js";
import { CANCEL_UPDATE, KEEP_WAITING_MORE, UPDATE_NOW_ANYWAY, markDecisionNotificationRead } from "./decisions.js";
import type { NotifyInput } from "./notifications.js";
import type { Available, DeployStatus, Headroom } from "./self-deploy.js";
import { DEPLOY_WAIT_KEY, SOFT_HOLD_MAX_MS, quietRuns as envQuietRuns, softHold } from "./deploy-wait-hold.js";

export { DEPLOY_WAIT_KEY, SOFT_HOLD_MAX_MS } from "./deploy-wait-hold.js";
export const WAIT_MINUTES = 30;
/** A host report older than this means the deployer has stopped ticking (or the host is too loaded to tick). */
export const HEADROOM_STALE_MS = 3 * 60_000;
/** How long the hold waits after the window for the runner update to start its own drain. */
export const HANDOVER_MS = 30 * 60_000;
/**
 * A request recorded as sent that is neither in the inbox nor reported by the host after this long was never written
 * (the server stopped between recording "sent" and writing it). The host ticks every minute and reports a request the
 * moment it takes it, so three minutes is well past any real pick-up.
 */
export const LOST_SEND_MS = 3 * 60_000;

export type WaitPhase = "waiting" | "sent" | "window" | "handover";
/** What the machine looked like at the last pass: what the owner's card and Settings show. */
export type Quiet = {
  ready: boolean;
  runs: number;
  checks: number;
  freeMb: number | null;
  needMb: number | null;
  /** Why it is not quiet yet, in plain words; empty when ready. */
  why: string[];
  /** The host doesn't report memory (an older deployer): only runs and checks are tested. */
  memoryUnknown?: boolean;
  /**
   * Memory is short mainly because the running server itself uses far more than a freshly started one (a leak, as on
   * 7 Nov at 17.5 GB): with the live server at fresh size there would be room. The update is what fixes that, so the
   * card says so and recommends updating now. Set only when memory is the shortage.
   */
  serverIsShortage?: { liveMb: number; freshMb: number };
  at: string;
};
export type DeployWait = {
  /** The approved self-deploy decision; it is also the request id the host reports back in status.json. */
  decisionId: string;
  commit: string;
  fromCommit: string;
  approvedAt: string;
  phase: WaitPhase;
  /** When the owner is asked (waiting, or sent while the host holds the request). Moves on with "Keep waiting". */
  deadline: string;
  minutes: number;
  /** "approve": Boss Man sends the request when quiet. "hand": a hand-applied update; nothing is sent, the owner is told when it is quiet. */
  origin: "approve" | "hand";
  override?: boolean;
  /** The owner pressed the combined button (BOS-1086): the runner update follows this deploy. */
  thenRunners?: boolean;
  sentAt?: string;
  windowUntil?: string;
  handoverSince?: string;
  quiet?: Quiet;
};

export type DeployWaitDeps = {
  headroom: () => Promise<Headroom | null>;
  /** Merge checks running now, on both paths: the in-memory merge gate and the server-owned check queue. */
  checksRunning: () => Promise<number>;
  /** Runs going now, across every company. */
  openRuns: () => Promise<number>;
  send: (ctx: { target: "server"; commit: string }, decisionId: string, opts: { override?: boolean; thenRunners?: boolean }) => Promise<unknown>;
  takeBack: (decisionId: string) => Promise<boolean>;
  /** Our own request (by id) is still in the host's inbox. */
  requestWaiting: (decisionId: string) => Promise<boolean>;
  status: () => Promise<DeployStatus | null>;
  available: () => Promise<Available | null>;
  /** When the update's standby window ends, if one is running (self-deploy's runner-due row). */
  trialUntil: () => Promise<string | null>;
  runnerCardOpen: () => Promise<boolean>;
  /** The runner update's full hold (maintenance.ts) is on: it takes over from here. */
  drainOn: () => Promise<boolean>;
  notify: (n: NotifyInput) => Promise<unknown>;
  /** The hold lifted: start parked checks and held runs now rather than at their next poll. */
  released?: () => Promise<unknown> | unknown;
  quietRuns?: number;
  now?: () => Date;
  log?: (msg: string) => void;
};

const short = (sha: string) => sha.slice(0, 8);
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export function deployWaitService(db: Db, deps: DeployWaitDeps) {
  const now = deps.now ?? (() => new Date());
  const quietRuns = deps.quietRuns ?? envQuietRuns();

  async function get(): Promise<DeployWait | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, DEPLOY_WAIT_KEY));
    return (row?.value as DeployWait | undefined) ?? null;
  }
  const save = (w: DeployWait) => db.insert(settings).values({ key: DEPLOY_WAIT_KEY, value: w }).onConflictDoUpdate({ target: settings.key, set: { value: w } });

  async function withdrawCards() {
    const open = await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'deploy_wait'`));
    for (const d of open) {
      await db.update(decisions).set({ status: "withdrawn", answeredAt: now(), dedupeKey: null }).where(eq(decisions.id, d.id));
      await markDecisionNotificationRead(db, d.id);
    }
  }

  /** Ends the wait: the row goes, any open card goes, and what was parked starts again. `note` is only for ends self-deploy doesn't report itself. */
  async function end(why: string, note?: Omit<NotifyInput, "companyId" | "link">) {
    await db.delete(settings).where(eq(settings.key, DEPLOY_WAIT_KEY));
    await withdrawCards();
    deps.log?.(`deploy wait ended: ${why}`);
    if (note) await deps.notify({ companyId: null, link: "#/settings", ...note });
    await Promise.resolve(deps.released?.()).catch((err) => deps.log?.(`deploy wait: restarting parked work failed: ${(err as Error).message}`));
  }

  /** Is the machine quiet enough for an update? Stale or missing reports are handled as the plan says. */
  async function measure(): Promise<Quiet> {
    const [h, checks, runs] = await Promise.all([deps.headroom(), deps.checksRunning(), deps.openRuns()]);
    const t = now();
    const why: string[] = [];
    let freeMb: number | null = null;
    let needMb: number | null = null;
    let memoryUnknown = false;
    let serverIsShortage: Quiet["serverIsShortage"];
    if (!h) memoryUnknown = true; // an older deployer: memory isn't tested, runs and checks still are
    else {
      const age = t.getTime() - Date.parse(h.writtenAt);
      if (!Number.isFinite(age) || age > HEADROOM_STALE_MS) why.push(`the machine hasn't reported for ${Number.isFinite(age) ? Math.round(age / 60_000) : "?"} min (is the host deployer's cron job running?)`);
      else if (h.availableMb === undefined || h.needMb === undefined) memoryUnknown = true;
      else {
        freeMb = h.availableMb;
        needMb = h.needMb;
        if (freeMb < needMb) {
          const live = h.liveServerMb;
          const fresh = h.newServerMb;
          // The running server's extra over a fresh one would cover the shortage: the server itself is what is short.
          if (live !== undefined && fresh !== undefined && fresh > 0 && live > fresh && freeMb + (live - fresh) >= needMb) {
            serverIsShortage = { liveMb: live, freshMb: fresh };
            why.push(`${gb(freeMb)} of memory is free and the update needs ${gb(needMb)}, mostly because the running server itself uses ${gb(live)} where a freshly started one needs about ${gb(fresh)}`);
          } else why.push(`${gb(freeMb)} of memory is free and the update needs ${gb(needMb)}`);
        }
      }
    }
    if (checks > 0) why.push(`${checks} merge check${checks === 1 ? " is" : "s are"} running`);
    if (runs > quietRuns) why.push(`${runs} runs are going (the update waits for ${quietRuns} or fewer)`);
    return { ready: why.length === 0, runs, checks, freeMb, needMb, why, ...(memoryUnknown ? { memoryUnknown } : {}), ...(serverIsShortage ? { serverIsShortage } : {}), at: t.toISOString() };
  }

  /** A hand-applied update: the owner's to-do shows how quiet the machine is, so they know when to apply it. */
  async function markTodo(w: DeployWait, q: Quiet) {
    if (w.origin !== "hand") return;
    const [todo] = await db.select({ id: decisions.id, context: decisions.context }).from(decisions).where(and(eq(decisions.dedupeKey, `owner-todo:self-deploy:${w.commit}`), eq(decisions.status, "open")));
    if (!todo) return;
    const { memoryUnknown: _m, ...quiet } = q;
    await db.update(decisions).set({ context: { ...(todo.context as object), quiet } }).where(eq(decisions.id, todo.id));
  }

  async function homeCompany() {
    const [c] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    return c?.id ?? null;
  }

  /** One card per deadline. Its key names the deadline, so "Keep waiting" earns a new card at the next one, and a restart none. */
  async function ask(w: DeployWait, q: Quiet, hostHolding: boolean) {
    const companyId = await homeCompany();
    if (!companyId) return;
    const busy = q.why.length ? q.why.join("; ") : "it isn't quiet yet";
    const mem = q.memoryUnknown ? " Memory isn't reported by this machine's host deployer, so only runs and checks are counted." : "";
    const hand = w.origin === "hand";
    const where = hostHolding
      ? `The update to ${short(w.commit)} was handed to the machine, but the machine is holding it because memory is short: ${busy}.`
      : `The update to ${short(w.commit)} has waited ${w.minutes} minutes for the machine to be quiet: ${busy}.`;
    // A hand-applied update is never sent by Boss Man, so there is nothing to "update now": the owner can apply it anyway from the to-do.
    const options = hand ? [KEEP_WAITING_MORE(w.minutes), CANCEL_UPDATE] : [KEEP_WAITING_MORE(w.minutes), UPDATE_NOW_ANYWAY, CANCEL_UPDATE];
    // The running server itself is what uses the memory (a leak): waiting won't free it, the update will. Say so, and recommend it.
    const leak = q.serverIsShortage;
    const choice = leak
      ? hand
        ? `The running server uses ${gb(leak.liveMb)}, where a freshly started one needs about ${gb(leak.freshMb)}, so waiting won't free the memory; applying the update replaces it. Keep waiting, or stop waiting and apply the update by hand (recommended)?`
        : `The running server uses ${gb(leak.liveMb)}, where a freshly started one needs about ${gb(leak.freshMb)}, so waiting won't free the memory; the update replaces it (the old copy stops when the standby window ends). Keep waiting, update now (recommended), or cancel the update?`
      : hand
        ? `Keep waiting, or stop waiting (this lifts the hold; you can still apply the update by hand, at the risk of running short of memory as on 3 Nov)?`
        : `Keep waiting, update now anyway (it may run short of memory and be switched back, as on 3 Nov), or cancel the update?`;
    // For a hand-applied update, "stop waiting" is the cancel option: it lifts the hold so the owner can apply it.
    const recommended = leak ? (hand ? CANCEL_UPDATE : UPDATE_NOW_ANYWAY) : options[0]!;
    await db
      .insert(decisions)
      .values({
        companyId,
        kind: "approval",
        // The owner's own choice (keep waiting, update now, cancel), so it goes to them.
        tier: "owner",
        question: `${where}${mem} ${choice} Until you answer, new merge checks wait and at most ${quietRuns} runs go at once.`,
        options,
        recommendedOption: recommended,
        dedupeKey: `deploy-wait:${w.approvedAt}:${w.deadline}`,
        context: { type: "deploy_wait", approvedAt: w.approvedAt },
      })
      .onConflictDoNothing();
  }

  async function sendNow(w: DeployWait, override: boolean): Promise<DeployWait> {
    const t = now();
    // The host may hold it for memory: the owner is asked again a full wait after it was sent, not at once.
    const next: DeployWait = { ...w, phase: "sent", sentAt: t.toISOString(), deadline: new Date(t.getTime() + w.minutes * 60_000).toISOString(), ...(override ? { override } : {}) };
    // "sent" is recorded before the request is written (Freddy): a stop after the write must not leave "waiting"
    // behind, or the next pass would send the same id again, and the host's "already handled" refusal would overwrite
    // the real result. A stop before the write is found by the sent phase (LOST_SEND_MS) and goes back to waiting.
    await save(next);
    try {
      await deps.send({ target: "server", commit: w.commit }, w.decisionId, { override, thenRunners: w.thenRunners });
    } catch (err) {
      await save(w);
      throw err;
    }
    return next;
  }

  /** After the host reports this request deployed: the standby window, or (a single server, no window) done. */
  async function afterDeployed(w: DeployWait) {
    const until = await deps.trialUntil();
    if (until && Date.parse(until) > now().getTime()) await save({ ...w, phase: "window", windowUntil: until });
    else await end("deployed; no standby window");
  }

  const self = {
    get,

    /** The soft hold: on while a wait exists. The scheduler caps runs and the merge gates park new checks. */
    softHold: () => softHold(db, now(), quietRuns),

    /**
     * The owner approved a server update. If the machine is quiet now it is sent at once (a quiet machine never
     * waits); otherwise the wait starts and the owner is told what it waits for. A send failure throws, with no
     * wait left behind, so the decision reopens as before. // leader-only
     */
    async begin(input: { decisionId: string; commit: string; fromCommit: string; origin?: "approve" | "hand"; thenRunners?: boolean }): Promise<DeployWait> {
      const have = await get();
      if (have) return have;
      const t = now();
      const w: DeployWait = { decisionId: input.decisionId, commit: input.commit, fromCommit: input.fromCommit, approvedAt: t.toISOString(), phase: "waiting", deadline: new Date(t.getTime() + WAIT_MINUTES * 60_000).toISOString(), minutes: WAIT_MINUTES, origin: input.origin ?? "approve", ...(input.thenRunners ? { thenRunners: true } : {}) };
      const q = await measure();
      if (q.ready && w.origin === "approve") {
        await save({ ...w, quiet: q });
        try {
          return await sendNow({ ...w, quiet: q }, false);
        } catch (err) {
          await db.delete(settings).where(eq(settings.key, DEPLOY_WAIT_KEY));
          throw err;
        }
      }
      await save({ ...w, quiet: q });
      await markTodo(w, q);
      if (w.origin === "approve")
        await deps.notify({
          companyId: null,
          level: "note",
          title: `Update to ${short(w.commit)} is waiting for a quiet machine`,
          body: `Right now ${q.why.join("; ")}. It starts by itself once the machine is quiet. Meanwhile new merge checks wait and at most ${quietRuns} runs go at once. If it is still waiting after ${WAIT_MINUTES} minutes you will be asked.`,
          link: "#/settings",
        });
      return { ...w, quiet: q };
    },

    /** One pass, every few seconds. // leader-only */
    async step(): Promise<DeployWait | null> {
      let w = await get();
      if (!w) return null;
      const t = now();
      if (t.getTime() - Date.parse(w.approvedAt) > SOFT_HOLD_MAX_MS) {
        // A request the host is still holding for memory is taken back too (Freddy): left in the inbox it would start
        // later on a busy machine, with no hold and no warning. One the host has already taken goes ahead as reported.
        const unsent = w.origin === "approve" && (w.phase === "waiting" || (w.phase === "sent" && (await deps.takeBack(w.decisionId))));
        await end("3-hour cap", {
          level: "page",
          title: "Update wait stopped after 3 hours",
          body: unsent
            ? `The update to ${short(w.commit)} never found a quiet machine, so it was not sent. Merge checks and runs are back to normal. Approve it again from Settings → Server and runner → Updates when the machine is quieter, or look at what keeps it busy.`
            : `The update to ${short(w.commit)} kept merge checks and runs held back for 3 hours, which is too long, so the hold was lifted. Check Settings → Server and runner → Updates for how the update went.`,
        });
        return null;
      }

      if (w.phase === "waiting") {
        const a = await deps.available();
        if (w.origin === "approve" && a?.tip && a.tip !== w.commit) {
          // The host only deploys the tip, and the approved commit is pinned (BOS-124): this approval can't be used.
          await end("main moved on", { level: "note", title: `Update to ${short(w.commit)} not sent: main moved on`, body: `While it waited for a quiet machine, main moved on to ${short(a.tip)}. Approve the new update when it is offered.` });
          return null;
        }
        if (w.origin === "hand" && a?.deployed && a.deployed !== w.fromCommit) {
          // The owner applied it by hand: the hold stays through the standby window, as for a sent update.
          await afterDeployed(w);
          return get();
        }
        const q = await measure();
        const wasReady = !!w.quiet?.ready;
        w = { ...w, quiet: q };
        if (q.ready && w.origin === "approve") return sendNow(w, false);
        if (q.ready && !wasReady && w.origin === "hand")
          await deps.notify({ companyId: null, level: "note", title: "Ready: the machine is quiet", body: `You can apply the update to ${short(w.commit)} by hand now. The steps are on the to-do in Decisions.`, link: "#/settings" });
        if (!q.ready && t >= new Date(w.deadline)) await ask(w, q, false);
        await save(w);
        await markTodo(w, q);
        return w;
      }

      const s = await deps.status();
      const ours = s?.id === w.decisionId;
      if (w.phase === "sent") {
        if (ours && s.result === "deployed") {
          await afterDeployed(w);
          return get();
        }
        if (ours && s.result !== "running") {
          await end(`the host reported ${s.result}`); // self-deploy tells the owner how it ended
          return null;
        }
        if (!ours && w.origin === "approve" && t.getTime() - Date.parse(w.sentAt ?? w.approvedAt) > LOST_SEND_MS && !(await deps.requestWaiting(w.decisionId))) {
          // Recorded as sent, yet not in the inbox and never reported by the host: the request was never written.
          // Back to waiting, so it goes out under the usual quiet test (or at once, if the owner chose Update now).
          deps.log?.(`deploy wait: the request for ${short(w.commit)} never reached the host; sending it again`);
          if (w.override) return sendNow(w, true);
          const back: DeployWait = { ...w, phase: "waiting" };
          delete back.sentAt;
          await save(back);
          return back;
        }
        if (!ours) {
          const h = await deps.headroom();
          if (h?.holding && t >= new Date(w.deadline)) {
            const q = await measure();
            await ask(w, q, true);
            await save({ ...w, quiet: q });
          }
        }
        return w;
      }

      if (w.phase === "window") {
        if (ours && (s.result === "rolled_back" || s.result === "failed")) {
          await end(`switched back in the window (${s.result})`);
          return null;
        }
        if (w.windowUntil && t < new Date(w.windowUntil)) return w;
        if (await deps.runnerCardOpen()) {
          const next: DeployWait = { ...w, phase: "handover", handoverSince: t.toISOString() };
          await save(next);
          return next;
        }
        await end("standby window over");
        return null;
      }

      // handover: the runner update's drain takes over with its full hold, or the owner put it off, or it never starts.
      if (await deps.drainOn()) await end("the runner update's drain took over");
      else if (!(await deps.runnerCardOpen())) await end("no runner update to hand over to");
      else if (t.getTime() - Date.parse(w.handoverSince ?? w.approvedAt) > HANDOVER_MS) await end("the runner update didn't start within 30 minutes; it waits on its own card");
      else return w;
      return null;
    },

    /** The owner's answer to the deadline card. // leader-only */
    async answered(answer: string) {
      const w = await get();
      if (!w) return;
      if (answer === CANCEL_UPDATE) await self.cancel();
      else if (answer === UPDATE_NOW_ANYWAY) {
        if (w.phase === "waiting" && w.origin === "approve") await sendNow(w, true);
        // Already with the host but held for memory: swap it for one with the override, under the same id. Only if
        // ours could be taken back first: one the host has already picked up must not arrive twice (it would be
        // refused as "already handled" and that refusal would overwrite the real status).
        else if (w.phase === "sent" && (await deps.takeBack(w.decisionId))) await sendNow(w, true);
      } else await save({ ...w, deadline: new Date(now().getTime() + w.minutes * 60_000).toISOString() });
    },

    /** Cancels a waiting update: our own request is taken back if the host hasn't picked it up. // leader-only */
    async cancel(): Promise<{ cancelled: boolean; tooLate?: boolean }> {
      const w = await get();
      if (!w) return { cancelled: false };
      if (w.phase === "window" || w.phase === "handover") {
        // The update is already live: cancelling only lifts the hold early.
        await end("cancelled by the owner after it went live", { level: "note", title: "Update hold lifted", body: `The update to ${short(w.commit)} is already live. Merge checks and runs are back to normal; the standby window carries on as usual.` });
        return { cancelled: true };
      }
      // Sent and not in the inbox any more: the host has it, so it goes ahead and the hold stays until it ends.
      if (w.phase === "sent" && !(await deps.takeBack(w.decisionId))) return { cancelled: false, tooLate: true };
      if (w.origin === "hand") {
        await end("hand wait stopped by the owner", { level: "note", title: "Stopped making room for the update", body: `Merge checks and runs are back to normal. The to-do to apply the update to ${short(w.commit)} by hand is still on your queue.` });
        return { cancelled: true };
      }
      await end("cancelled by the owner", { level: "note", title: `Update to ${short(w.commit)} cancelled`, body: "Nothing was sent to the machine. Merge checks and runs are back to normal. The update is offered again in Settings → Server and runner → Updates." });
      return { cancelled: true };
    },

    /** For Settings and the merge-queue screen. */
    async status() {
      const w = await get();
      return w ? { on: true as const, ...w } : { on: false as const };
    },
  };
  // One change at a time (Freddy): a pass reads the wait, measures, then writes it back, so a Cancel or "Keep waiting"
  // landing in between would be undone, and a cancelled update could still be sent. Everything that changes the wait
  // runs leader-only in this one process, so queueing them here is enough. Inside, answered calls the unqueued cancel.
  let chain: Promise<unknown> = Promise.resolve();
  const serial =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      const r = chain.then(() => fn(...a));
      chain = r.catch(() => undefined);
      return r;
    };
  return { ...self, begin: serial(self.begin), step: serial(self.step), answered: serial(self.answered), cancel: serial(self.cancel) };
}
export type DeployWaitService = ReturnType<typeof deployWaitService>;
