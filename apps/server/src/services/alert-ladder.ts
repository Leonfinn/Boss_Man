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
// is dropped; when the company is paused it goes straight to the owner. Nothing is ever dropped:
// the last rung is always the owner.
import { and, asc, eq, gt, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { readWatchdogSettings, untrusted } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agents, companies, decisions, runs, watchdogActions } from "../db/schema.js";
import { record } from "./activity.js";
import { CANCEL_RUN, checkAsk } from "./decisions.js";
import { ALERT_REASON, SCRUM_MASTER_DUTY, WATCHDOG_REWAKE_REASON, WatchdogError, type watchdogService } from "./watchdog.js";

/** The most a card waits with the CEO, counted from when it was raised, whether or not a CEO run has started (BOS-180). */
export const CEO_OUTER_CAP_MINUTES = 20;

export type Rung = "scrum_master" | "ceo" | "owner";
const RUNGS: Rung[] = ["scrum_master", "ceo", "owner"];
const LABEL: Record<Rung, string> = { scrum_master: "the Scrum Master", ceo: "the CEO", owner: "the owner" };
export const GOT_IT = "Got it";

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
  hops: Array<{ to: Rung; at: string; why: string }>;
};

export type AlertInput = {
  companyId: string;
  question: string;
  ticketId?: string | null;
  about?: Array<string | null | undefined>;
  /** The lowest rung allowed to settle it: "ceo" when the fix is beyond the Scrum Master (stopping work, a review outcome, host access). */
  from?: Rung;
  rewake?: Ladder["rewake"];
  /** A duty alert goes to the Scrum Master even while the watchdog is off. */
  duty?: boolean;
  raisedByAgentId?: string | null;
  /** Defaults to a "Got it" question; the review loop and the stall sweep bring their own options and context. */
  kind?: "question" | "approval" | "stalled_run";
  options?: string[];
  recommended?: string;
  context?: Record<string, unknown>;
  dedupeKey?: string;
};

type Notify = (agentId: string, input: { ticketId?: string | null; reason: string; note?: string | null; priority?: number }) => Promise<{ id: string; status: string; statusReason?: string | null }>;

export function alertLadder(
  db: Db,
  deps: {
    notify: Notify;
    answer: (decisionId: string, answer: string, extra?: { settledBy?: { agentId: string }; note?: string }) => Promise<unknown>;
    watchdog: ReturnType<typeof watchdogService>;
    /** Passes the Scrum Master's nudge to a colleague; used on stalled-run alerts. */
    nudge?: (input: { runId: string; fromAgentId: string; to: string; ticketId?: string | null; why: string }) => Promise<{ ok: true; delivered: string } | { ok: false; error: string }>;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());

  async function log(companyId: string, row: { kind: "alert_hop" | "alert_resolved"; ticketId: string | null; actorAgentId?: string | null; targetAgentId?: string | null; decisionId: string; reason: string; summary: string }) {
    await db.insert(watchdogActions).values({ companyId, kind: row.kind, ticketId: row.ticketId, actorAgentId: row.actorAgentId ?? null, targetAgentId: row.targetAgentId ?? null, reason: row.reason.slice(0, 500), after: { decisionId: row.decisionId }, createdAt: now() });
    await record(db, { companyId, agentId: row.actorAgentId ?? null, ticketId: row.ticketId, kind: "watchdog", summary: row.summary, at: now() });
  }

  /**
   * When a card on its rung is due to move up. The Scrum Master's rung counts from the hop. The CEO's
   * minutes count from when a CEO run that can see the card starts (one that began after it was
   * raised), not from the raise: the CEO may be queued behind other runs. Outer cap: CEO_OUTER_CAP_MINUTES
   * from the raise, so a card nobody picks up still reaches the owner (BOS-180).
   */
  async function dueAt(companyId: string, ladder: Ladder, minutes: number): Promise<number> {
    const raised = new Date(ladder.since).getTime();
    if (ladder.rung !== "ceo") return raised + minutes * 60_000;
    const cap = raised + Math.max(minutes, CEO_OUTER_CAP_MINUTES) * 60_000;
    const [ceo] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) return raised + minutes * 60_000;
    const [run] = await db
      .select({ startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.agentId, ceo.id), gte(runs.startedAt, new Date(raised)), or(isNull(runs.purpose), ne(runs.purpose, "chat"))))
      .orderBy(asc(runs.startedAt))
      .limit(1);
    return run ? Math.min(cap, run.startedAt.getTime() + minutes * 60_000) : cap;
  }

  /** Who holds this rung now, or why nobody can. */
  async function holder(companyId: string, rung: Exclude<Rung, "owner">, about: string[], duty = false): Promise<{ agent: typeof agents.$inferSelect } | { skip: string }> {
    const [c] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!c || c.paused) return { skip: "the company is paused" };
    if (rung === "scrum_master") {
      const s = readWatchdogSettings(c.watchdog);
      // A stalled run is the Scrum Master's duty whether or not the watchdog is switched on (BOS-119).
      if ((!s.enabled || c.watchdogTrippedAt) && !duty) return { skip: "the watchdog is off" };
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
    const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), isNull(agents.retiredAt)));
    if (!ceo) return { skip: "there is no CEO" };
    if (ceo.paused) return { skip: "the CEO is paused" };
    if (about.includes(ceo.id)) return { skip: "the alert is about the CEO" };
    // Each hop starts a CEO run, so a loop raising alerts on many tickets could feed itself; past the cap they go to the owner as before.
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
      const hop = (to: Rung, w: string): Ladder => ({ ...ladder, rung: to, since: now().toISOString(), hops: [...ladder.hops, { to, at: now().toISOString(), why: w }] });
      if (rung === "owner") {
        const next = hop("owner", reason);
        const tried = (extra.triedFirst as string | undefined) ?? (ladder.hops.length ? `Boss Man tried the team first: ${ladder.hops.map((h) => `${LABEL[h.to]} (${h.why})`).join(", then ")}. Neither could settle it.` : undefined);
        const moved = await db
          .update(decisions)
          .set({ tier: "owner", forAgentId: null, context: { ...(d.context as object), ...extra, ...(tried ? { triedFirst: tried } : {}), ladder: next } })
          .where(and(eq(decisions.id, d.id), eq(decisions.status, "open")))
          .returning({ id: decisions.id });
        if (!moved.length) return null;
        await log(d.companyId, { kind: "alert_hop", ticketId: ladder.ticketId, decisionId: d.id, reason, summary: `Alert sent to the owner: ${reason}` });
        return "owner";
      }
      const h = await holder(d.companyId, rung, ladder.about, ladder.duty);
      if ("skip" in h) {
        reason = `${LABEL[rung]} was skipped: ${h.skip}`;
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
      const w = await deps.notify(h.agent.id, rung === "ceo" ? { ticketId: null, reason: "decision", priority: 3, note: note(rung, d, next, minutes) } : { ticketId: ladder.ticketId, reason: ALERT_REASON, priority: 3, note: note(rung, d, next, minutes) });
      if (w.status === "dropped") {
        reason = `${LABEL[rung]} was skipped: its wake was dropped (${w.statusReason ?? "no reason given"})`;
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

  return {
    /** Raises one of Boss Man's own alerts on the ladder. Null when the dedupe key says it's already open. */
    async raise(input: AlertInput): Promise<{ id: string; rung: Rung } | null> {
      const ladder: Ladder = {
        rung: input.from ?? "scrum_master",
        since: now().toISOString(),
        ticketId: input.ticketId ?? null,
        about: [...new Set(input.about?.filter((x): x is string => !!x) ?? [])],
        duty: input.duty ?? false,
        rewake: input.rewake ?? null,
        hops: [],
      };
      const [d] = await db
        .insert(decisions)
        .values({
          companyId: input.companyId,
          kind: input.kind ?? "question",
          question: input.question,
          options: input.options ?? [GOT_IT],
          recommendedOption: input.recommended ?? GOT_IT,
          raisedByAgentId: input.raisedByAgentId ?? null,
          // Not on any rung's queue until place() puts it there; the owner is not notified before.
          tier: "ceo",
          dedupeKey: input.dedupeKey,
          context: { type: "question", ...input.context, ladder },
          createdAt: now(),
        })
        .onConflictDoNothing()
        .returning();
      if (!d) return null;
      const rung = await place(d, ladder, ladder.rung, input.from === "ceo" ? "only the CEO or the owner can act on it" : input.from === "owner" ? "only the owner can act on it" : "raised by Boss Man");
      return rung ? { id: d.id, rung } : null;
    },

    /** Moves alerts that sat on a rung past the time limit up one rung. Run on the leader's timer. */
    async sweep() {
      const open = await db
        .select({ d: decisions, watchdog: companies.watchdog })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->'ladder'->>'rung' in ('scrum_master', 'ceo')`));
      let moved = 0;
      for (const { d, watchdog } of open) {
        const ladder = (d.context as { ladder: Ladder }).ladder;
        const minutes = ladder.minutes ?? readWatchdogSettings(watchdog).alertMinutes;
        if ((await dueAt(d.companyId, ladder, minutes)) > now().getTime()) continue;
        if (await place(d, ladder, RUNGS[RUNGS.indexOf(ladder.rung) + 1]!, `${LABEL[ladder.rung]} didn't settle it within ${minutes} minutes`)) moved++;
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
    async escalate(companyId: string, ceoId: string, input: { alertId: string; triedFirst: string; steps?: string[]; ownerMustDo?: boolean }) {
      const [ceo] = await db.select().from(agents).where(and(eq(agents.id, ceoId), eq(agents.companyId, companyId), eq(agents.role, "ceo")));
      if (!ceo) throw new WatchdogError(403, "Only the CEO passes alerts to the owner.");
      const { d, ladder } = await openAlert(companyId, input.alertId);
      if (ladder.rung === "owner") throw new WatchdogError(409, "It's already with the owner.");
      const bad = checkAsk(input);
      if (bad) throw new WatchdogError(422, bad);
      if (!(await place(d, ladder, "owner", `${ceo.name} couldn't settle it`, { triedFirst: input.triedFirst.trim(), ...(input.steps?.length ? { steps: input.steps } : {}) }))) throw new WatchdogError(409, "That alert was answered meanwhile.");
      return { id: d.id };
    },
  };
}
