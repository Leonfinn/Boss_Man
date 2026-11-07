// The alert ladder (BOS-64). Boss Man's own alerts (a wake chain that looks like a loop, a review
// that keeps bouncing, two agents nudging each other) go to the Scrum Master first, then the CEO,
// and reach the owner only when neither can settle them.
//
// An alert is one decision row that climbs, so the owner's queue, the CEO's decisions tool and
// every answer hook keep working unchanged: tier "ceo" with forAgentId = the Scrum Master on the
// first rung, tier "ceo" on the second, tier "owner" on the last. context.ladder says where it is
// and keeps every hop. The owner is only notified once it reaches them (notifications.ts).
//
// A rung is skipped, and the alert falls through, when its agent is missing or paused, is one of
// the agents the alert is about (it may be the one looping), is over its hourly cap, or its wake
// is dropped; when the company is paused it goes straight to the owner. A card whose kind stops at
// the CEO does not fall through, though (DR-017 A, BOS-469): when the CEO can't take it, for any
// reason, it parks on the CEO's rung with its clock stopped and is offered again when the reason
// is gone. Only a kind allowed to reach the owner goes past the CEO.
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { readWatchdogSettings, untrusted } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, runs, watchdogActions } from "../db/schema.js";
import { record } from "./activity.js";
import type { ClearWhen } from "./alert-clearing.js";
import { CANCEL_RUN, checkAsk } from "./decisions.js";
import type { HostFacts } from "./steps.js";
import type { Addon, AddonFacts } from "./addons.js";
import { type AlertCause, type AlertKind, type AlertRung, isAlertKind, kindCeiling, kindRow, kindStart } from "./alert-kinds.js";
import { ALERT_REASON, SCRUM_MASTER_DUTY, WATCHDOG_REWAKE_REASON, WatchdogError, watchdogPausedUntil, type watchdogService } from "./watchdog.js";

/** The most a card waits with the CEO, counted from when it was raised, whether or not a CEO run has started (BOS-180). */
export const CEO_OUTER_CAP_MINUTES = 20;

export type Rung = AlertRung;
const RUNGS: Rung[] = ["scrum_master", "ceo", "owner"];
const RANK: Record<Rung, number> = { scrum_master: 0, ceo: 1, owner: 2 };
const LABEL: Record<Rung, string> = { scrum_master: "the Scrum Master", ceo: "the CEO", owner: "the owner" };
export const GOT_IT = "Got it";
/** A skip that only happens because the watchdog is rehearsing (BOS-166). */
const RECORD_SKIP = /record-only/i;
/** A run end that says the account couldn't run it (DR-015 A): a usage limit, an auth error, identity verification. */
const USAGE_OR_AUTH_OUTCOME = /error:.*(usage limit|rate limit|weekly limit|5-hour limit|five-hour limit|quota|limit reached|authentication|unauthori[sz]ed|forbidden|identity verification|invalid api key|credit balance)/i;

export type Ladder = {
  rung: Rung;
  /** When it reached this rung; the timeout counts from here. */
  since: string;
  /** Overrides the company's alert time, e.g. a permission or plan request, which must reach the owner before the runner gives up (BOS-111, BOS-119). */
  minutes?: number;
  ticketId: string | null;
  /** Agents the alert is about: a rung they hold is skipped. */
  about: string[];
  /** A duty alert (a stalled run): the Scrum Master takes it even when the watchdog is switched off (BOS-119). */
  duty?: boolean;
  /** The wake that was dropped, which the Scrum Master may start again with a fresh chain. */
  rewake?: { agentId: string; ticketId: string | null; reason: string } | null;
  /** The alert's kind (DR-017 A): the table row that sets its top rung, its cause key and its closer. */
  kind?: AlertKind;
  /** The highest rung the card may reach; it never moves above this. */
  topRung?: Rung;
  /** The cause key: raises with the same key fold into one card (DR-017 B). */
  groupBy?: string | null;
  /** Why the CEO isn't holding it right now (DR-017 A, BOS-469 point 7); the clock is stopped while set. */
  parked?: string | null;
  hops: Array<{ to: Rung; at: string; why: string }>;
};

export type AlertInput = {
  companyId: string;
  question: string;
  ticketId?: string | null;
  about?: Array<string | null | undefined>;
  /** The lowest rung allowed to settle it: "ceo" when the fix is beyond the Scrum Master (stopping work, a review outcome, host access). */
  from?: Rung;
  /** Why it starts on that rung, said on the card's ladder (e.g. "the CEO is the target"). */
  why?: string;
  /** The kind of alert (DR-017 A). Every raise names one; a raise without one is checked by alert-kinds.test.ts. */
  kind?: AlertKind;
  /** The account, run or agents the alert is about, for its cause key and closer (DR-017 B, DR-016). */
  cause?: AlertCause;
  /** The decisions-table kind ("question", "approval", "stalled_run"); defaults to a plain question. */
  cardKind?: "question" | "approval" | "stalled_run";
  rewake?: Ladder["rewake"];
  /** A duty alert goes to the Scrum Master even while the watchdog is off. */
  duty?: boolean;
  raisedByAgentId?: string | null;
  /** Defaults to a plain "Got it" question; the review loop and the stall sweep bring their own context. */
  options?: string[];
  recommended?: string;
  context?: Record<string, unknown>;
  dedupeKey?: string;
  /**
   * When the card's cause is gone, in a form the server can check (DR-016, BOS-470). The closer
   * (alert-clearing.ts) closes the card on any tier, the owner's included, with the reason. A raise
   * without one is filled in from the dedupe key where that names the cause exactly (stalled run,
   * start failure, runner-offline, self/chain/ticketless loop, usage limit); anything else stays as
   * it was rather than guessing.
   */
  clearWhen?: ClearWhen[];
};

/** The first part of a raise's cause key, e.g. "start-fail" from "start-fail:<agent>:<wake>". */
const keyPrefix = (key: string | undefined) => (key ?? "").split(":")[0] ?? "";

type Notify = (agentId: string, input: { ticketId?: string | null; reason: string; note?: string | null; priority?: number; replyLane?: boolean }) => Promise<{ id: string; status: string; statusReason?: string | null }>;

/**
 * The condition for a raise that didn't give one, where its cause key says exactly what would
 * clear it (DR-017's alert kinds table). Anything else gets none: a condition that is true too
 * early would hide a live problem, so nothing is guessed from the question's words or a timeout.
 */
async function inferClearWhen(input: AlertInput): Promise<ClearWhen[]> {
  const key = input.dedupeKey;
  if (!key) return [];
  const parts = key.split(":");
  switch (keyPrefix(key)) {
    case "stalled":
      return parts[1] ? [{ kind: "runActive", runId: parts[1] }] : [];
    case "start-fail": {
      if (!parts[1] || !parts[2]) return [];
      // The card names the runner-offline case in its question (flagFailedStart only raises it for "runner offline").
      // The key is "start-fail:<agentId>:<wakeId>"; a wake id has no colons, so the rest is the wake.
      if (!/runner offline/i.test(input.question)) return [];
      return [{ kind: "runnerConnected", companyId: input.companyId, wakeId: parts.slice(2).join(":") }];
    }
    case "alert": {
      // The agent is in both the key and `about`; the key is the one this card was built from.
      const agentId = parts[2];
      const what = parts[1];
      return agentId && (what === "self" || what === "chain" || what === "ticketless") ? [{ kind: "agentRanOk", agentId }] : [];
    }
    case "limit":
      return parts[1] ? [{ kind: "limitReset", fundingSourceId: parts[1] }] : [];
    default:
      return [];
  }
}

export function alertLadder(
  db: Db,
  deps: {
    notify: Notify;
    answer: (decisionId: string, answer: string, extra?: { settledBy?: { agentId: string }; note?: string }) => Promise<unknown>;
    watchdog: ReturnType<typeof watchdogService>;
    /** Passes the Scrum Master's nudge to a colleague; used on stalled-run alerts. */
    nudge?: (input: { runId: string; fromAgentId: string; to: string; ticketId?: string | null; why: string }) => Promise<{ ok: true; delivered: string } | { ok: false; error: string }>;
    /**
     * Whether the CEO could run right now (DR-015 A, BOS-469 point 1): an account with room and no
     * usage/auth error standing in the way. A card that stops at the CEO waits while this says no.
     * Left out, the CEO is taken to be able to run.
     */
    ceoCanRun?: (companyId: string) => Promise<boolean>;
    /** The one closer for Boss Man's own cards (DR-016, BOS-469 point 2): closes a card whose cause is gone, on any tier. */
    clearExpired?: () => Promise<number>;
    /** The host facts Boss Man recorded (BOS-427), for R6 on a CEO escalation with owner steps. Absent: only the host/account check runs. */
    hosts?: () => Promise<HostFacts[]>;
    /** Add-on facts for the card lint's R9 (DR-023). Absent: R9 is not checked. */
    addons?: () => Promise<AddonFacts>;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());

  async function log(companyId: string, row: { kind: "alert_hop" | "alert_resolved"; ticketId: string | null; actorAgentId?: string | null; targetAgentId?: string | null; decisionId: string; reason: string; summary: string }) {
    await db.insert(watchdogActions).values({ companyId, kind: row.kind, ticketId: row.ticketId, actorAgentId: row.actorAgentId ?? null, targetAgentId: row.targetAgentId ?? null, reason: row.reason.slice(0, 500), after: { decisionId: row.decisionId }, createdAt: now() });
    await record(db, { companyId, agentId: row.actorAgentId ?? null, ticketId: row.ticketId, kind: "watchdog", summary: row.summary, at: now() });
  }

  /** A rehearsal entry (BOS-166): what the ladder would have done. It reached nobody, so the caps never count it. */
  async function recordRehearsal(companyId: string, row: { kind: "record_alert_skip"; ticketId: string | null; decisionId: string; reason: string; summary: string }) {
    await db.insert(watchdogActions).values({ companyId, kind: row.kind, ticketId: row.ticketId, reason: row.reason.slice(0, 500), after: { decisionId: row.decisionId, recorded: true }, createdAt: now() });
    await record(db, { companyId, agentId: null, ticketId: row.ticketId, kind: "watchdog", summary: row.summary, at: now() });
  }

  /**
   * When a card on its rung is due to move up. The Scrum Master's rung counts from the hop. The CEO's
   * minutes count from when a CEO run that can see the card starts (one that began after it was
   * raised), not from the raise: the CEO may be queued behind other runs. Outer cap: CEO_OUTER_CAP_MINUTES
   * from the raise, so a card nobody picks up still reaches the owner (BOS-180).
   */
  async function dueAt(companyId: string, ladder: Ladder, minutes: number): Promise<number> {
    const raised = new Date(ladder.since).getTime();
    // A CEO-ceiling card that is parked, or whose time is up but cannot go higher, never falls through
    // to the owner (DR-017 A, DR-015): its clock stops where it is.
    if (ladder.rung === "ceo" && (ladder.parked || !canClimb(ladder))) return Infinity;
    if (ladder.rung !== "ceo") return raised + minutes * 60_000;
    const cap = raised + Math.max(minutes, CEO_OUTER_CAP_MINUTES) * 60_000;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) return raised + minutes * 60_000;
    // A CEO run that failed to start, or ended on a usage/auth error, doesn't start the clock (DR-015 A).
    // Only a run that began, and didn't end that way, can have the card steered into it.
    const [run] = await db
      .select({ startedAt: runs.startedAt, endedAt: runs.endedAt, outcome: runs.outcome })
      .from(runs)
      .where(and(eq(runs.agentId, ceo.id), gte(runs.startedAt, new Date(raised)), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
      .orderBy(asc(runs.startedAt))
      .limit(1);
    // A ticketless CEO run already live at the raise gets the card steered in, so the clock starts at the raise.
    const [live] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.agentId, ceo.id), isNull(runs.ticketId), lt(runs.startedAt, new Date(raised)), or(isNull(runs.endedAt), gte(runs.endedAt, new Date(raised))), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
      .limit(1);
    const start = live ? raised : run && !USAGE_OR_AUTH_OUTCOME.test(run.outcome ?? "") ? run.startedAt.getTime() : undefined;
    return start === undefined ? cap : Math.min(cap, start + minutes * 60_000);
  }

  /** Whether a card may move above the rung it is on now: never above its kind's highest rung. */
  function canClimb(ladder: Ladder): boolean {
    const top = ladder.topRung ?? "owner";
    return RANK[top] > RANK[ladder.rung];
  }

  /** Why the CEO can't take a card right now, or null when the CEO rung can. */
  async function ceoBlocked(companyId: string): Promise<string | null> {
    if (!deps.ceoCanRun) return null;
    return (await deps.ceoCanRun(companyId)) ? null : "the CEO can't run right now (usage or auth)";
  }

  /** Who holds this rung now, or why nobody can. */
  async function holder(companyId: string, rung: Exclude<Rung, "owner">, about: string[], duty = false): Promise<{ agent: typeof agents.$inferSelect } | { skip: string }> {
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!c || c.paused) return { skip: "the company is paused" };
    if (rung === "scrum_master") {
      const s = readWatchdogSettings(c.watchdog);
      // Record only (BOS-166): the Scrum Master can't act in this mode, so an alert waiting here would
      // sit forever. Treat it like "watchdog off" and let the alert climb to the CEO and then the owner.
      if (s.recordOnly) return { skip: "the watchdog is in record-only mode" };
      // A stalled run is the Scrum Master's duty whether or not the watchdog is switched on (BOS-119).
      if ((!s.enabled || watchdogPausedUntil(c, now())) && !duty) return { skip: "the watchdog is off" };
      const [sm] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.duty, SCRUM_MASTER_DUTY), isNull(agents.retiredAt)));
      if (!sm) return { skip: "there is no Scrum Master" };
      if (sm.paused) return { skip: "the Scrum Master is paused" };
      if (about.includes(sm.id)) return { skip: "the alert is about the Scrum Master" };
      // Alert wakes share the sweep's hourly run cap; past it the CEO takes them rather than the watchdog tripping.
      const [n] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(watchdogActions)
        .where(and(eq(watchdogActions.companyId, companyId), inArray(watchdogActions.kind, ["sweep_wake", "alert_hop"]), eq(watchdogActions.targetAgentId, sm.id), gt(watchdogActions.createdAt, new Date(now().getTime() - 3_600_000))));
      if ((n?.n ?? 0) >= s.maxSmRunsPerHour) return { skip: "the Scrum Master is at its hourly limit" };
      return { agent: sm };
    }
    // The CEO's account test (DR-015 A): while the CEO can't run, a card waiting on it would only time out.
    const cannotRun = await ceoBlocked(companyId);
    if (cannotRun) return { skip: cannotRun };
    const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) return { skip: "there is no CEO" };
    if (ceo.paused) return { skip: "the CEO is paused" };
    if (about.includes(ceo.id)) return { skip: "the alert is about the CEO" };
    // Each hop starts a CEO run, so a loop raising alerts on many tickets could feed itself; past the cap the
    // CEO is skipped, and place() then holds a CEO-ceiling card with it (or passes an owner kind on).
    const [n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(watchdogActions)
      .where(and(eq(watchdogActions.companyId, companyId), eq(watchdogActions.kind, "alert_hop"), eq(watchdogActions.targetAgentId, ceo.id), gt(watchdogActions.createdAt, new Date(now().getTime() - 3_600_000))));
    if ((n?.n ?? 0) >= readWatchdogSettings(c.watchdog).maxCeoAlertsPerHour) return { skip: "the CEO has had its hourly limit of alerts" };
    return { agent: ceo };
  }

  function note(rung: Exclude<Rung, "owner">, d: { id: string; question: string }, ladder: Ladder, minutes: number) {
    const last = ladder.hops.at(-1);
    const head = rung === "scrum_master" ? `Boss Man raised an alert and it's yours to settle first (alert ${d.id}).` : `An alert Boss Man raised is with you (decision ${d.id})${last?.why ? `: ${last.why}` : ""}.`;
    const how =
      rung === "scrum_master"
        ? [
            "If you can fix it with your watchdog actions, do, then call the watchdog tool with action resolve_alert (alertId, reason)" +
              (ladder.rewake ? `; add rewake: true to wake the agent again with a fresh chain once you've checked it isn't really looping` : "") +
              ".",
            "If it needs more than your actions allow (stopping work, changing a review outcome, a secret or host access), call pass_alert (alertId, reason) and it goes to the CEO.",
          ]
        : [
            "Settle it if you can, then answer it with the decisions tool (action answer).",
            "If only the owner can settle it (a secret, host access, sign-off, an owner-only choice), use the decisions tool's action escalate (id, triedFirst: what you and the team tried, steps: what the owner must do).",
          ];
    return [head, untrusted("Boss Man alert", d.question), ...how, `If nothing happens within ${minutes} minutes it moves up to ${rung === "scrum_master" ? "the CEO" : "the owner"}.`].join("\n");
  }

  /**
   * Puts the alert on the first rung from `start` that can take it, waking that agent, and logs
   * each hop (and each rung skipped) on the ticket. Returns the rung it landed on, or null when
   * the alert was answered meanwhile (each update only touches an open row, so nobody is woken for it).
   */
  async function place(d: typeof decisions.$inferSelect, ladder: Ladder, start: Rung, why: string, extra: Record<string, unknown> = {}): Promise<Rung | null> {
    const [c] = await db.select({ watchdog: companies.watchdog }).from(companies).where(eq(companies.id, d.companyId));
    const minutes = readWatchdogSettings(c?.watchdog).alertMinutes;
    let reason = why;
    for (const rung of RUNGS.slice(RUNGS.indexOf(start))) {
      const hop = (to: Rung, w: string): Ladder => ({ ...ladder, rung: to, since: now().toISOString(), parked: null, hops: [...ladder.hops, { to, at: now().toISOString(), why: w }] });
      // A card whose kind stops at the CEO never passes it (DR-017 A, BOS-469 point 7): when the CEO can't
      // take it, for any reason, it parks on the CEO rung with its clock stopped rather than going to the
      // owner. It is offered to the CEO again each sweep once the reason has gone.
      if (rung === "owner" && ladder.topRung !== "owner" && ladder.topRung !== undefined) {
        const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
        const next: Ladder = { ...ladder, rung: "ceo", parked: reason, topRung: ladder.topRung, hops: [...ladder.hops, { to: "ceo", at: now().toISOString(), why: reason }] };
        const held = await db
          .update(decisions)
          .set({ tier: "ceo", forAgentId: null, context: { ...(d.context as object), ...extra, ladder: next } })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
          .returning({ id: decisions.id });
        if (!held.length) return null;
        await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, targetAgentId: ceo?.id ?? null, decisionId: d.id, reason, summary: `Held with the CEO: ${reason}` });
        return "ceo";
      }
      if (rung === "owner") {
        const next = hop("owner", reason);
        const tried = (extra.triedFirst as string | undefined) ?? (ladder.hops.length ? `Boss Man tried the team first: ${ladder.hops.map((h) => `${LABEL[h.to]} (${h.why})`).join(", then ")}. Neither could settle it.` : undefined);
        // The card carries the CEO's advice down to the owner (BOS-233): what it's needed for and what a
        // Deny stops. When the handover ran out the card says so, so the owner knows why the advice may lag.
        const handoverRanOut = !!extra.handoverRanOut;
        const moved = await db
          .update(decisions)
          .set({ tier: "owner", forAgentId: null, context: { ...(d.context as object), ...extra, ...(tried ? { triedFirst: tried } : {}), ...(handoverRanOut ? { handoverRanOut: { at: now().toISOString() } } : {}), ladder: next } })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
          .returning({ id: decisions.id });
        if (!moved.length) return null;
        await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, decisionId: d.id, reason, summary: `Alert sent to the owner: ${reason}` });
        return "owner";
      }
      const h = await holder(d.companyId, rung, ladder.about, ladder.duty);
      if ("skip" in h) {
        reason = `${LABEL[rung]} was skipped: ${h.skip}`;
        // Record only (BOS-166): the rehearsal would have passed it up, so write that down, but nothing is sent.
        if (RECORD_SKIP.test(h.skip)) await recordRehearsal(d.companyId, { kind: "record_alert_skip", ticketId: ladder.ticketId, decisionId: d.id, reason, summary: `Record only: would have passed Boss Man's alert past ${LABEL[rung]} and up the ladder (${h.skip}). Nothing was sent.` });
        continue;
      }
      const next = hop(rung, reason);
      const moved = await db
        .update(decisions)
        .set({ tier: "ceo", forAgentId: rung === "scrum_master" ? h.agent.id : null, context: { ...(d.context as object), ladder: next } })
        .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
        .returning({ id: decisions.id });
      if (!moved.length) return null;
      // High priority: the owner would otherwise have been told now, quiet hours or not.
      // Every card waiting on the CEO shares one ticketless "decision" wake (or the CEO's live run), so a busy CEO is woken once for all of them (BOS-180).
      const w = await deps.notify(h.agent.id, rung === "ceo" ? { ticketId: null, reason: "decision", priority: 3, replyLane: true, note: note(rung, d, next, minutes) } : { ticketId: ladder.ticketId, reason: ALERT_REASON, priority: 3, note: note(rung, d, next, minutes) });
      if (w.status === "dropped") {
        reason = `${LABEL[rung]} was skipped: its wake was dropped (${w.statusReason ?? "no reason given"})`;
        if (rung === "ceo" && ladder.topRung !== undefined && ladder.topRung !== "owner") {
          // The CEO couldn't be woken: a CEO-ceiling card is held there, not passed on (DR-017 A, BOS-469 point 7).
          const held: Ladder = { ...ladder, rung: "ceo", parked: reason, topRung: ladder.topRung, hops: [...ladder.hops, { to: "ceo", at: now().toISOString(), why: reason }] };
          const kept = await db
            .update(decisions)
            .set({ tier: "ceo", forAgentId: null, context: { ...(d.context as object), ladder: held } })
            .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
            .returning({ id: decisions.id });
          if (!kept.length) return null;
          await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, targetAgentId: h.agent.id, decisionId: d.id, reason, summary: `Held with the CEO: ${reason}` });
          return "ceo";
        }
        continue;
      }
      await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, targetAgentId: h.agent.id, decisionId: d.id, reason, summary: `Alert handed to ${h.agent.name}: ${reason}` });
      return rung;
    }
    return "owner";
  }

  /**
   * The Scrum Master may act on an alert while the watchdog is off (BOS-119): a stalled run is
   * their duty either way. Still refuse anyone who isn't the company's active Scrum Master.
   */
  async function dutyActor(companyId: string, agentId: string) {
    if (await deps.watchdog.recordOnly(companyId)) throw new WatchdogError(409, "The watchdog is in record-only mode: it writes down what it would do and reaches nobody. The owner switches it to full action in Settings.");
    const [sm] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.duty, SCRUM_MASTER_DUTY), isNull(agents.retiredAt)));
    if (!sm || sm.id !== agentId) throw new WatchdogError(403, "Only the company's Scrum Master can settle these alerts.");
    return { sm };
  }

  async function openAlert(companyId: string, decisionId: string) {
    const [d] = await db.select().from(decisions).where(and(eq(decisions.id, decisionId), eq(decisions.companyId, companyId), eq(decisions.status, "open")));
    const ladder = (d?.context as { ladder?: Ladder } | undefined)?.ladder;
    if (!d || !ladder) throw new WatchdogError(404, "No open alert with that ID.");
    return { d, ladder };
  }

  /** True when the reason a card is parked with the CEO has gone: the CEO can run, and the cap has room for one more. */
  async function ceoTakesAgain(companyId: string): Promise<boolean> {
    const h = await holder(companyId, "ceo", []);
    return !("skip" in h);
  }

  /**
   * Offers a card parked with the CEO to it again, once the reason it was held has gone (BOS-469 point 7).
   * It keeps the CEO's rung with a fresh clock and wakes the CEO once for all such cards, as place() does.
   */
  async function offerAgain(d: typeof decisions.$inferSelect, ladder: Ladder): Promise<boolean> {
    const [c] = await db.select({ watchdog: companies.watchdog }).from(companies).where(eq(companies.id, d.companyId));
    const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) return false;
    const back = await ceoTakesAgain(d.companyId);
    const why = ladder.parked ?? "it waited for the CEO";
    if (!back) {
      // Still blocked. The reason can change (the cap frees and the account becomes the next one), so name
      // the current one on the card without waking anyone. The clock is stopped either way.
      const h = await holder(d.companyId, "ceo", []);
      const blocked = "skip" in h ? `${LABEL.ceo} was skipped: ${h.skip}` : why;
      if (blocked !== why) {
        const kept: Ladder = { ...ladder, parked: blocked, hops: [...ladder.hops, { to: "ceo", at: now().toISOString(), why: blocked }] };
        const [row] = await db.update(decisions).set({ context: { ...(d.context as object), ladder: kept } }).where(and(eq(decisions.id, d.id), eq(decisions.status, "open"))).returning({ id: decisions.id });
        if (!row) return false;
        await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, targetAgentId: ceo.id, decisionId: d.id, reason: blocked, summary: `Held with the CEO: ${blocked}` });
      }
      return false;
    }
    const minutes = readWatchdogSettings(c?.watchdog).alertMinutes;
    const next: Ladder = { ...ladder, rung: "ceo", since: now().toISOString(), parked: null, hops: [...ladder.hops, { to: "ceo", at: now().toISOString(), why: "the CEO can take it again" }] };
    const [moved] = await db
      .update(decisions)
      .set({ tier: "ceo", forAgentId: null, context: { ...(d.context as object), ladder: next } })
      .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
      .returning({ id: decisions.id });
    if (!moved) return false;
    // High priority, as a hand-over: it waited for the CEO, so quiet hours must not delay it further.
    const w = await deps.notify(ceo.id, { ticketId: null, reason: "decision", priority: 3, replyLane: true, note: note("ceo", d, next, minutes) });
    await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, targetAgentId: ceo.id, decisionId: d.id, reason: "the CEO can take it again", summary: `Alert handed to ${ceo.name}: the CEO can take it again` });
    return w.status !== "dropped";
  }

  return {
    /**
     * Adds a raise to the open card with the same cause (DR-017 B, BOS-469 point 6): its text and count are
     * rewritten, no second card and no new wake. The kinds table supplies a heading for the folded card;
     * without one the original question stays and only the list of items is added.
     */
    async append(open: typeof decisions.$inferSelect, input: AlertInput, heading?: (cause: AlertCause, count: number) => string): Promise<void> {
      const ctx = open.context as { items?: Array<{ question: string; at: string; agents?: string[] }>; pageUrl?: string } & Record<string, unknown>;
      const items = [...(ctx.items ?? []), { question: input.question, at: now().toISOString(), ...(input.cause?.agents?.length ? { agents: input.cause.agents.filter((x): x is string => !!x) } : {}) }];
      // The cause carries every agent named so far, so the heading says how many, not just the last one.
      const agents = [...new Set(items.flatMap((i) => i.agents ?? []))];
      const question = heading ? heading({ ...input.cause, agents }, items.length) : open.question;
      await db
        .update(decisions)
        .set({ question, context: { ...(open.context as object), items, lastAppendedAt: now().toISOString() } })
        .where(and(eq(decisions.id, open.id), eq(decisions.status, "open")));
    },

    /** Raises one of Boss Man's own alerts on the ladder. Null when the dedupe key says it's already open. */
    async raise(input: AlertInput): Promise<{ id: string; rung: Rung } | null> {
      const kindId: AlertKind | undefined = isAlertKind(input.kind) ? input.kind : undefined;
      const cause: AlertCause = { ...input.cause, companyId: input.companyId, agents: input.cause?.agents?.length ? input.cause.agents : input.about };
      const row = kindRow(kindId, input.from);
      const start = kindStart(input.from);
      const ceiling = kindCeiling(kindId, input.from);
      // `foldKey` is the cause key (only kinds with a groupBy fold, DR-017 B); `groupKey` is that or the
      // caller's own dedupe key, so a repeat of one alert never raises a second card.
      const foldKey = row.groupBy?.(cause) ?? null;
      const groupKey = foldKey ?? input.dedupeKey ?? null;
      /** The card's own kind, kept in its context as `decisionsKind` so a fold finds only its own kind. */
      const decisionsKind = foldKey ? `alert:${kindId ?? "alert"}` : (input.context?.decisionsKind as string | undefined);
      const ladder: Ladder = {
        rung: start,
        since: now().toISOString(),
        ticketId: input.ticketId ?? null,
        about: [...new Set(input.about?.filter((x): x is string => !!x) ?? [])],
        duty: input.duty ?? false,
        rewake: input.rewake ?? null,
        ...(kindId ? { kind: kindId } : {}),
        topRung: ceiling,
        groupBy: groupKey,
        parked: null,
        hops: [],
      };
      const clearWhen = input.clearWhen ?? (row.clearWhen && kindId ? row.clearWhen(cause) : await inferClearWhen(input));
      // One cause, one card (DR-017 B, BOS-469 points 3 and 6): a raise whose cause key matches an open card
      // adds its item to that card and no wake is sent. Only cards of the same kind fold together.
      if (foldKey) {
        const [open] = await db
          .select()
          .from(decisions)
          .where(and(eq(decisions.companyId, input.companyId), eq(decisions.status, "open"), sql`${decisions.context}->>'decisionsKind' = ${decisionsKind}`, sql`${decisions.context}->'ladder'->>'groupBy' = ${foldKey}`))
          .limit(1);
        if (open) {
          await this.append(open, input, row.title);
          return { id: open.id, rung: ((open.context as { ladder: Ladder }).ladder.rung) };
        }
      }
      const [d] = await db
        .insert(decisions)
        .values({
          companyId: input.companyId,
          kind: input.cardKind ?? "question",
          question: input.question,
          options: input.options ?? [GOT_IT],
          recommendedOption: input.recommended ?? GOT_IT,
          raisedByAgentId: input.raisedByAgentId ?? null,
          // Not on any rung's queue until place() puts it there; the owner is not notified before.
          tier: "ceo",
          dedupeKey: groupKey,
          context: {
            type: "question",
            ...(decisionsKind ? { decisionsKind } : {}),
            ...(groupKey ? { items: [{ question: input.question, at: now().toISOString(), ...(cause.agents?.length ? { agents: cause.agents.filter((x): x is string => !!x) } : {}) }] } : {}),
            ...input.context,
            ladder,
            ...(clearWhen.length ? { clearWhen } : {}),
          },
          createdAt: now(),
        })
        .onConflictDoNothing()
        .returning();
      if (!d) return null;
      const rung = await place(d, ladder, ladder.rung, input.why ?? (start === "ceo" ? "only the CEO or the owner can act on it" : start === "owner" ? "only the owner can act on it" : "raised by Boss Man"));
      return rung ? { id: d.id, rung } : null;
    },

    /** Moves alerts that sat on a rung past the time limit up one rung. Run on the leader's timer. */
    async sweep() {
      // Cards whose cause has gone close themselves first, on any tier, with a logged reason (DR-016, BOS-469 point 2).
      if (deps.clearExpired) await deps.clearExpired();
      const open = await db
        .select({ d: decisions, watchdog: companies.watchdog })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->'ladder'->>'rung' in ('scrum_master', 'ceo')`));
      let moved = 0;
      for (const { d, watchdog } of open) {
        const ladder = (d.context as { ladder: Ladder }).ladder;
        const minutes = ladder.minutes ?? readWatchdogSettings(watchdog).alertMinutes;
        // A card parked with the CEO is offered to it again as soon as the reason has gone (BOS-469 point 7).
        // Its clock is stopped, so this is checked before the timeout rather than after it.
        if (ladder.parked) {
          if (await offerAgain(d, ladder)) moved++;
          continue;
        }
        if ((await dueAt(d.companyId, ladder, minutes)) > now().getTime()) continue;
        // A permission card whose CEO handover ran out still reaches the owner, but it says so, and the
        // CEO is woken again to add the advice (BOS-233 item 2). The card marks the event itself.
        const ranOut = ladder.rung === "ceo" && d.kind === "permission" && !(d.context as { advice?: { state?: string } }).advice?.state;
        const to = await place(d, ladder, RUNGS[RUNGS.indexOf(ladder.rung) + 1]!, `${LABEL[ladder.rung]} didn't settle it within ${minutes} minutes`, ranOut ? { handoverRanOut: true } : {});
        if (!to) continue;
        moved++;
        if (ranOut && to === "owner") {
          const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, d.companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
          if (ceo) {
            await deps.notify(ceo.id, {
              ticketId: null,
              reason: "decision",
              priority: 2,
              note: [
                `A permission request reached the owner without your advice because the handover ran out (decision ${d.id}).`,
                untrusted("Boss Man alert", d.question),
                "Add the advice now with the decisions tool (action advise, outcome advice): what it's needed for (which ticket, what step) and what wouldn't get done if the owner denies it. The owner can still answer it either way.",
              ].join("\n").slice(0, 4000),
            });
          }
        }
      }
      return { moved };
    },

    /** The Scrum Master's open alerts. */
    async mine(companyId: string, agentId: string) {
      await dutyActor(companyId, agentId);
      const rows = await db
        .select()
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), eq(decisions.forAgentId, agentId), sql`${decisions.context}->'ladder'->>'rung' = 'scrum_master'`))
        .orderBy(decisions.createdAt);
      return rows.map((d) => {
        const l = (d.context as { ladder: Ladder }).ladder;
        return { alertId: d.id, question: d.question, ticketId: l.ticketId, since: l.since, canRewake: !!l.rewake };
      });
    },

    /** The Scrum Master settled it (and may wake the dropped agent again, with a fresh chain). */
    async resolve(companyId: string, agentId: string, input: { alertId: string; reason: string; rewake?: boolean; answer?: string; nudge?: boolean; runId?: string }) {
      const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 240);
      if (reason.length < 3) throw new WatchdogError(422, "Give a one-line reason.");
      const { sm } = await dutyActor(companyId, agentId);
      const { d, ladder } = await openAlert(companyId, input.alertId);
      if (ladder.rung !== "scrum_master" || d.forAgentId !== sm.id) throw new WatchdogError(409, `That alert is with ${LABEL[ladder.rung]} now.`);
      // A plain alert is settled by acknowledging it. A stalled run also offers a choice the
      // Scrum Master may make (BOS-119): keep waiting, or cancel the run. Anything else goes to the CEO.
      const options = d.options as string[];
      const ctx = d.context as { type?: string; runId?: string };
      const plain = options.length === 1 && options[0] === GOT_IT;
      const canChoose = ctx.type === "stalled_run" && input.answer !== undefined && options.includes(input.answer);
      if (!plain && !canChoose) throw new WatchdogError(409, "This alert needs a choice the Scrum Master can't make: pass it to the CEO.");
      if (input.rewake) {
        if (!ladder.rewake) throw new WatchdogError(409, "This alert has no dropped wake to start again.");
        const [c] = await db.select({ watchdog: companies.watchdog }).from(companies).where(eq(companies.id, companyId));
        await deps.watchdog.capOrFail(companyId, readWatchdogSettings(c?.watchdog));
        // No causedByRunId: the point is a fresh chain, which the owner used to start by hand.
        const w = await deps.notify(ladder.rewake.agentId, {
          ticketId: ladder.rewake.ticketId,
          reason: WATCHDOG_REWAKE_REASON,
          note: `Boss Man dropped your last wake ("${ladder.rewake.reason}") because the chain of wake-ups looked like a loop. The Scrum Master checked it and is waking you again.\n${untrusted(`agent ${sm.name}`, `${sm.name} says: ${reason}`)}\nCarry on, and avoid waking colleagues back and forth: put what they need on the ticket.`,
        });
        if (w.status === "dropped") throw new WatchdogError(409, w.statusReason ?? "The wake was dropped.");
        await deps.watchdog.log({ companyId, kind: "rewake", ticketId: ladder.rewake.ticketId, actorAgentId: sm.id, targetAgentId: ladder.rewake.agentId, reason, after: { wakeIds: [w.id], decisionId: d.id }, undoable: true, summary: `${sm.name} woke the agent again after checking the wake chain: ${reason}` });
      }
      const answer = input.answer ?? d.recommendedOption;
      // Asking the agent to say why it is quiet is a nudge; it only makes sense if the run carries on.
      if (input.nudge && ctx.type === "stalled_run" && answer !== CANCEL_RUN) {
        const [run] = ctx.runId ? await db.select({ agentId: runs.agentId, ticketId: runs.ticketId }).from(runs).where(eq(runs.id, ctx.runId)) : [];
        if (!run?.agentId || !deps.nudge) throw new WatchdogError(409, "That stalled run has no agent to nudge.");
        const n = await deps.nudge({ runId: input.runId ?? ctx.runId!, fromAgentId: sm.id, to: run.agentId, ticketId: run.ticketId, why: reason });
        if (!n.ok) throw new WatchdogError(409, n.error);
      }
      // Recorded as the Scrum Master's, so the owner sees who settled it and why (BOS-111, BOS-119).
      await deps.answer(d.id, answer, { settledBy: { agentId: sm.id }, note: reason });
      await log(companyId, { kind: "alert_resolved", ticketId: ladder.ticketId, actorAgentId: sm.id, decisionId: d.id, reason, summary: `${sm.name} settled the alert (${answer}): ${reason}` });
      return { id: d.id };
    },

    /** The Scrum Master hands it to the CEO: beyond its actions, or it couldn't fix it. */
    async pass(companyId: string, agentId: string, input: { alertId: string; reason: string }) {
      const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 240);
      if (reason.length < 3) throw new WatchdogError(422, "Give a one-line reason.");
      const { sm } = await dutyActor(companyId, agentId);
      const { d, ladder } = await openAlert(companyId, input.alertId);
      if (ladder.rung !== "scrum_master" || d.forAgentId !== sm.id) throw new WatchdogError(409, `That alert is with ${LABEL[ladder.rung]} now.`);
      const to = await place(d, ladder, "ceo", `${sm.name} passed it on: ${reason}`);
      if (!to) throw new WatchdogError(409, "That alert was answered meanwhile.");
      return { id: d.id, to };
    },

    /** The CEO can't settle it: it goes to the owner with what was tried and the steps (the raise_decision rules). */
    async escalate(companyId: string, ceoId: string, input: { alertId: string; triedFirst: string; steps?: string[]; ownerMustDo?: boolean; lintOverride?: string; setsUp?: Addon; adviceNeeded?: string; adviceDeny?: string }) {
      const [ceo] = await db.select().from(agents).where(and(eq(agents.id, ceoId), eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      if (!ceo) throw new WatchdogError(403, "Only the CEO passes alerts to the owner.");
      const { d, ladder } = await openAlert(companyId, input.alertId);
      if (ladder.rung === "owner") throw new WatchdogError(409, "It's already with the owner.");
      const ask = checkAsk({ ...input, byCeo: true, hosts: deps.hosts ? await deps.hosts() : undefined, addons: input.steps?.length ? await deps.addons?.() : undefined });
      if (ask.error) throw new WatchdogError(422, ask.error);
      // Every permission card that reaches the owner carries the CEO's advice (BOS-233 item 2): what it's
      // needed for and what wouldn't get done if the owner denies it.
      let advice: Record<string, unknown> | null = null;
      if (d.kind === "permission") {
        const neededFor = (input.adviceNeeded ?? "").trim();
        const denyStops = (input.adviceDeny ?? "").trim();
        if (neededFor.length < 10 || denyStops.length < 10) throw new WatchdogError(422, "A permission card needs the CEO's advice before it goes to the owner: adviceNeeded (what it's needed for: which ticket, what step) and adviceDeny (what wouldn't get done if the owner denies it).");
        advice = { state: "advised", at: now().toISOString(), what: neededFor, denyStops };
      }
      // The CEO has looked at it and decided only the owner can settle it: that is the one way a CEO-ceiling
      // card may reach the owner (DR-017 A), so the ceiling doesn't apply to a deliberate escalation.
      if (!(await place(d, { ...ladder, topRung: "owner" }, "owner", `${ceo.name} couldn't settle it`, { triedFirst: input.triedFirst.trim(), ...(input.steps?.length ? { steps: input.steps } : {}), ...(ask.lint ? { lint: ask.lint } : {}), ...(advice ? { advice } : {}) }))) throw new WatchdogError(409, "That alert was answered meanwhile.");
      return { id: d.id };
    },
  };
}
