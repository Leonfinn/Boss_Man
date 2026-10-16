// Loop guards (R49, R50). Review rounds are counted, and the same finding coming back three
// times, or too many rounds, goes to the owner instead of round four. Failures (run errors,
// failed checks) are reduced to signatures; the same one three times in two hours means the
// agent is going round in circles and needs a different approach.
import { and, count, eq, gt } from "drizzle-orm";
import { failureSignature, findingFingerprint, type ReviewComment } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { decisions, failureSignatures, ticketDependencies, ticketReviews, tickets } from "../db/schema.js";

export type LoopLimits = { repeatedFinding: number; maxRounds: number; circularFailures: number; circularWindowMs: number };
export const DEFAULT_LOOP_LIMITS: LoopLimits = { repeatedFinding: 3, maxRounds: 5, circularFailures: 3, circularWindowMs: 2 * 3_600_000 };

export const SEND_BACK = "Send it back anyway";
export const STOP_WORK = "Stop work on it";

export function loopGuards(db: Db, opts: { limits?: Partial<LoopLimits>; now?: () => Date } = {}) {
  const limits = { ...DEFAULT_LOOP_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => new Date());

  return {
    limits,

    /**
     * Records a "changes requested" round. If it would be the round that loops, it holds the
     * message back, blocks the ticket on an owner decision and returns that decision's id.
     */
    async reviewRound(input: { ticketId: string; reviewer: string; comments: ReviewComment[]; message: string }): Promise<{ round: number; escalated: string | null }> {
      const fingerprints = input.comments.map((c) => findingFingerprint(c));
      await db.insert(ticketReviews).values({ ticketId: input.ticketId, reviewer: input.reviewer, verdict: "changes_requested", comments: input.comments, fingerprints, createdAt: now() });
      const rounds = await db.select({ fingerprints: ticketReviews.fingerprints }).from(ticketReviews).where(and(eq(ticketReviews.ticketId, input.ticketId), eq(ticketReviews.verdict, "changes_requested")));
      const seen = new Map<string, number>();
      for (const r of rounds) for (const f of new Set(r.fingerprints as string[])) seen.set(f, (seen.get(f) ?? 0) + 1);
      const repeatedIdx = fingerprints.findIndex((f) => (seen.get(f) ?? 0) >= limits.repeatedFinding);
      const tooMany = rounds.length > limits.maxRounds;
      if (repeatedIdx === -1 && !tooMany) return { round: rounds.length, escalated: null };

      const [t] = await db.select().from(tickets).where(eq(tickets.id, input.ticketId));
      const why =
        repeatedIdx !== -1
          ? `the same comment has now come back ${seen.get(fingerprints[repeatedIdx]!)} times: "${input.comments[repeatedIdx]!.path}: ${input.comments[repeatedIdx]!.body.slice(0, 200)}"`
          : `it has been sent back ${rounds.length} times`;
      const [d] = await db
        .insert(decisions)
        .values({
          companyId: t!.companyId,
          kind: "approval",
          question: `Review of "${t!.title}" looks stuck: ${why}. Send the review back again, or stop work on the ticket?`,
          options: [SEND_BACK, STOP_WORK],
          recommendedOption: STOP_WORK,
          context: { type: "review_loop", ticketId: input.ticketId, message: input.message, reviewer: input.reviewer },
        })
        .returning({ id: decisions.id });
      await db.insert(ticketDependencies).values({ blockedTicketId: input.ticketId, blockerDecisionId: d!.id });
      await db.update(tickets).set({ systemState: "blocked", lastActivityAt: now() }).where(eq(tickets.id, input.ticketId));
      return { round: rounds.length, escalated: d!.id };
    },

    async approved(ticketId: string, reviewer: string) {
      await db.insert(ticketReviews).values({ ticketId, reviewer, verdict: "approved", createdAt: now() });
    },

    /**
     * Records a failure. The third time the same signature turns up for a ticket (or, without a
     * ticket, for an agent) within the window, the owner is told once and the caller is told to
     * ask for a different approach.
     */
    async failure(input: { companyId: string; ticketId: string | null; agentId: string | null; text: string; what: string }): Promise<{ count: number; circular: boolean }> {
      const signature = failureSignature(input.text);
      await db.insert(failureSignatures).values({ companyId: input.companyId, ticketId: input.ticketId, agentId: input.agentId, signature, sample: input.text.slice(-1000), createdAt: now() });
      const since = new Date(now().getTime() - limits.circularWindowMs);
      const scope = input.ticketId ? eq(failureSignatures.ticketId, input.ticketId) : eq(failureSignatures.agentId, input.agentId ?? "00000000-0000-0000-0000-000000000000");
      const [row] = await db.select({ n: count() }).from(failureSignatures).where(and(scope, eq(failureSignatures.signature, signature), gt(failureSignatures.createdAt, since)));
      const n = Number(row?.n ?? 0);
      if (n < limits.circularFailures) return { count: n, circular: false };
      const [t] = input.ticketId ? await db.select({ title: tickets.title }).from(tickets).where(eq(tickets.id, input.ticketId)) : [];
      await db
        .insert(decisions)
        .values({
          companyId: input.companyId,
          kind: "question",
          question: `${input.what} has hit the same failure ${n} times in ${Math.round(limits.circularWindowMs / 3_600_000)} hours${t ? ` on "${t.title}"` : ""}. It has been told to try a different approach. Last output: ${input.text.slice(-300)}`,
          options: ["Got it"],
          recommendedOption: "Got it",
          dedupeKey: `circular:${input.ticketId ?? input.agentId}:${signature}`,
          context: { type: "question" },
        })
        .onConflictDoNothing();
      return { count: n, circular: true };
    },
  };
}

/** What a looping agent is told on top of the failure itself. */
export const DIFFERENT_APPROACH = (n: number) =>
  `\n\nThis is the ${n}${n === 3 ? "rd" : "th"} time the same failure has come back. Don't repeat what you tried before: step back, find the root cause, and take a different approach. If you're stuck, raise a decision.`;
