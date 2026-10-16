// Periodic sweeps that put forgotten work in front of the owner:
// - stale blockers (R21): a dependency whose blocker has had no activity for too long;
// - stalled runs (R32): a running agent that has gone quiet. Advisory only: nothing is cancelled.
// Rows that no longer apply are withdrawn, so the queue only shows live problems.
import { and, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, decisions, engagementMessages, engagements, runners, runs, ticketDependencies, tickets } from "../db/schema.js";
import { CANCEL_RUN, CHASE, DROP, KEEP_WAITING, REASSIGN, type DecisionContext } from "./decisions.js";

export type SweepLimits = { staleAfterMs: number; stallAfterMs: number };
export const DEFAULT_SWEEP_LIMITS: SweepLimits = { staleAfterMs: 24 * 3_600_000, stallAfterMs: 5 * 60_000 };

const ago = (ms: number) => (ms >= 2 * 86_400_000 ? `${Math.floor(ms / 86_400_000)} days` : ms >= 2 * 3_600_000 ? `${Math.floor(ms / 3_600_000)} hours` : `${Math.max(1, Math.floor(ms / 60_000))} minutes`);
const later = (a: Date | null | undefined, b: Date | null | undefined) => (!a ? (b ?? null) : !b || a > b ? a : b);

export function sweepService(db: Db, opts: { limits?: Partial<SweepLimits>; now?: () => Date } = {}) {
  const limits = { ...DEFAULT_SWEEP_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());

  async function withdraw(ids: string[]) {
    if (ids.length) await db.update(decisions).set({ status: "withdrawn", dedupeKey: null }).where(inArray(decisions.id, ids));
  }

  async function openOfKind(kind: "stale_blocker" | "stalled_run") {
    return db.select().from(decisions).where(and(eq(decisions.kind, kind), eq(decisions.status, "open")));
  }

  async function staleBlockers(t: Date) {
    const deps = await db
      .select({ dep: ticketDependencies, blocked: tickets })
      .from(ticketDependencies)
      .innerJoin(tickets, eq(tickets.id, ticketDependencies.blockedTicketId));
    const stale = new Map<string, { question: string; options: string[]; recommended: string; companyId: string; ctx: DecisionContext }>();

    // A ticket counts as active if it moved recently or an agent is reporting on it.
    const runActivity = new Map(
      (await db.select({ ticketId: runs.ticketId, at: max(runs.lastEventAt) }).from(runs).groupBy(runs.ticketId)).flatMap((r) => (r.ticketId && r.at ? [[r.ticketId, r.at] as const] : [])),
    );
    const msgActivity = new Map(
      (await db.select({ id: engagementMessages.engagementId, at: max(engagementMessages.createdAt) }).from(engagementMessages).groupBy(engagementMessages.engagementId)).map((r) => [r.id, r.at]),
    );

    for (const { dep, blocked } of deps) {
      if (blocked.systemState === "done" || dep.blockerDecisionId) continue; // decisions are already in the queue
      const ctx: DecisionContext = { type: "stale_blocker", dependencyId: dep.id, blockedTicketId: blocked.id, blockerTicketId: dep.blockerTicketId, blockerEngagementId: dep.blockerEngagementId };
      if (dep.blockerTicketId) {
        const [b] = await db.select({ t: tickets, assignee: agents.name }).from(tickets).leftJoin(agents, eq(agents.id, tickets.assigneeAgentId)).where(eq(tickets.id, dep.blockerTicketId));
        if (!b || b.t.systemState === "done") continue;
        const idle = t.getTime() - later(b.t.lastActivityAt, runActivity.get(b.t.id))!.getTime();
        if (idle < limits.staleAfterMs) continue;
        const who = b.assignee ? `assigned to ${b.assignee}` : b.t.assignedToOwner ? "assigned to you" : "unassigned";
        stale.set(dep.id, {
          question: `"${b.t.title}" (${who}) has blocked "${blocked.title}" with no activity for ${ago(idle)}.`,
          options: [CHASE, REASSIGN, DROP],
          // Nobody to chase means it needs an owner.
          recommended: b.t.assigneeAgentId || b.t.assignedToOwner ? CHASE : REASSIGN,
          companyId: blocked.companyId,
          ctx,
        });
      } else if (dep.blockerEngagementId) {
        const [e] = await db.select().from(engagements).where(eq(engagements.id, dep.blockerEngagementId));
        if (!e || e.status === "signed_off") continue;
        const idle = t.getTime() - later(e.createdAt, msgActivity.get(e.id))!.getTime();
        if (idle < limits.staleAfterMs) continue;
        stale.set(dep.id, {
          question: `The engagement "${e.title}" (${e.status.replace("_", " ")}) has blocked "${blocked.title}" with no activity for ${ago(idle)}.`,
          options: [CHASE, DROP],
          recommended: e.status === "rejected" ? DROP : CHASE,
          companyId: blocked.companyId,
          ctx,
        });
      }
    }

    // Withdraw rows that no longer apply, then raise new ones (one open row per dependency).
    const open = await openOfKind("stale_blocker");
    await withdraw(open.filter((d) => !stale.has((d.context as { dependencyId: string }).dependencyId)).map((d) => d.id));
    const have = new Set(open.map((d) => (d.context as { dependencyId: string }).dependencyId));
    let raised = 0;
    for (const [depId, s] of stale) {
      if (have.has(depId)) continue;
      const rows = await db
        .insert(decisions)
        .values({ companyId: s.companyId, kind: "stale_blocker", question: s.question, options: s.options, recommendedOption: s.recommended, dedupeKey: `stale:${depId}`, context: s.ctx })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      raised += rows.length;
    }
    return { open: stale.size, raised };
  }

  async function stalledRuns(t: Date) {
    const live = await db
      .select({ run: runs, agentName: agents.name, ticketTitle: tickets.title, runnerId: runners.id })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .leftJoin(tickets, eq(tickets.id, runs.ticketId))
      .leftJoin(runners, eq(runners.companyId, runs.companyId))
      .where(isNull(runs.endedAt));
    // A run waiting on a permission decision is waiting on the owner, not stalled.
    const waiting = new Set(
      (await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.kind, "permission"), eq(decisions.status, "open")))).map(
        (d) => (d.context as { runId: string }).runId,
      ),
    );
    const stalled = new Map<string, (typeof live)[number] & { idle: number }>();
    for (const r of live) {
      if (waiting.has(r.run.id) || !r.runnerId) continue;
      const idle = t.getTime() - (r.run.lastEventAt ?? r.run.startedAt).getTime();
      if (idle >= limits.stallAfterMs) stalled.set(r.run.id, { ...r, idle });
    }

    const open = await openOfKind("stalled_run");
    await withdraw(open.filter((d) => !stalled.has((d.context as { runId: string }).runId)).map((d) => d.id));
    let raised = 0;
    for (const [runId, r] of stalled) {
      const ctx: DecisionContext = { type: "stalled_run", runnerId: r.runnerId!, runId };
      // The key stays after an answer, so "Keep waiting" silences this run until it stirs again.
      const rows = await db
        .insert(decisions)
        .values({
          companyId: r.run.companyId,
          kind: "stalled_run",
          question: `${r.agentName ?? "An agent"} has sent nothing for ${ago(r.idle)}${r.ticketTitle ? ` while working on "${r.ticketTitle}"` : ""}. It may be stuck, or busy with a long command.`,
          options: [KEEP_WAITING, CANCEL_RUN],
          recommendedOption: KEEP_WAITING,
          raisedByAgentId: r.run.agentId,
          dedupeKey: `stalled:${runId}`,
          context: ctx,
        })
        .onConflictDoNothing()
        .returning({ id: decisions.id });
      raised += rows.length;
    }
    // A run that stirred frees its key, so a later stall is reported again.
    const answered = await db
      .select({ id: decisions.id, context: decisions.context })
      .from(decisions)
      .where(and(eq(decisions.kind, "stalled_run"), eq(decisions.status, "answered"), isNotNull(decisions.dedupeKey)));
    const stirred = answered.filter((d) => !stalled.has((d.context as { runId: string }).runId)).map((d) => d.id);
    if (stirred.length) await db.update(decisions).set({ dedupeKey: null }).where(inArray(decisions.id, stirred));
    return { open: stalled.size, raised };
  }

  return {
    limits,
    /** One pass of both sweeps. Safe to call often. */
    async run() {
      const t = now();
      return { staleBlockers: await staleBlockers(t), stalledRuns: await stalledRuns(t) };
    },
  };
}
