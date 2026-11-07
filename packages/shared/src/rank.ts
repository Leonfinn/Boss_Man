// Decision-queue ranking (R20). The score is a sum of named parts so the queue can say
// why a row sits where it does, rather than show a bare number.

/** One ticket a decision holds up, directly (depth 1) or further down the chain. */
export type BlockedTicket = {
  depth: number;
  /** The most important linked objective's priority, P1 (highest) to P5; null if unlinked. */
  objectivePriority: number | null;
  /** Effective due date, YYYY-MM-DD. */
  dueDate: string | null;
};

export type RankInput = {
  createdAt: Date;
  blocked: BlockedTicket[];
  /** A running agent is paused until this is answered (a permission request). */
  holdsLiveRun?: boolean;
};

export type RankParts = { blocking: number; urgency: number; age: number; liveRun: number };
export type Rank = { score: number; parts: RankParts; reasons: string[]; dueDate: string | null };

/** P1 work counts four times as much as unlinked work. */
export function objectiveWeight(priority: number | null): number {
  switch (priority) {
    case 1:
      return 4;
    case 2:
      return 3;
    case 3:
      return 2;
    case 4:
      return 1.5;
    default:
      return 1;
  }
}

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

function daysUntil(date: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / DAY);
}

/** Points for the nearest due date: overdue work scores highest, anything over two weeks away scores nothing. */
export function urgencyPoints(days: number): number {
  if (days < 0) return 10;
  if (days === 0) return 8;
  if (days <= 2) return 6;
  if (days <= 7) return 3;
  if (days <= 14) return 1;
  return 0;
}

export function rankDecision(input: RankInput, now: Date): Rank {
  const reasons: string[] = [];

  // Blocking: each ticket's objective weight, halved for every step down the chain, doubled overall.
  const blocking = round1(2 * input.blocked.reduce((sum, t) => sum + objectiveWeight(t.objectivePriority) * 0.5 ** (t.depth - 1), 0));
  if (input.blocked.length) {
    const direct = input.blocked.filter((t) => t.depth === 1).length;
    const further = input.blocked.length - direct;
    const plural = (n: number) => `${n} ticket${n === 1 ? "" : "s"}`;
    reasons.push(further ? `Blocks ${plural(direct)} directly and ${further} more down the chain` : `Blocks ${plural(direct)}`);
    const top = Math.min(...input.blocked.map((t) => t.objectivePriority ?? Infinity));
    if (Number.isFinite(top)) reasons.push(`Holds up P${top} objective work`);
  }

  const dueDate = input.blocked.reduce<string | null>((m, t) => (t.dueDate && (!m || t.dueDate < m) ? t.dueDate : m), null);
  let urgency = 0;
  if (dueDate) {
    const days = daysUntil(dueDate, now);
    urgency = urgencyPoints(days);
    reasons.push(days < 0 ? `Overdue by ${-days} day${days === -1 ? "" : "s"}` : days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`);
  }

  const hours = Math.max(0, (now.getTime() - input.createdAt.getTime()) / 3_600_000);
  // One point a day, up to a week, so old rows rise without swamping real blockers.
  const age = round1(Math.min(7, hours / 24));
  reasons.push(hours < 1 ? "Raised just now" : hours < 48 ? `Waiting ${Math.floor(hours)} h` : `Waiting ${Math.floor(hours / 24)} days`);

  const liveRun = input.holdsLiveRun ? 5 : 0;
  if (liveRun) reasons.unshift("An agent is paused until you answer");

  return { score: round1(blocking + urgency + age + liveRun), parts: { blocking, urgency, age, liveRun }, reasons, dueDate };
}

/** A card that orders it relative to another: the card it depends on, and a short label for it. */
export type OrderLink = { decisionId: string; label: string };

/**
 * The queue's do-this-next order (BOS-551). Cards that need the owner's hands are put in an order
 * that respects their "do after" / "do before" links between one another; a card with no ordering
 * information keeps today's rank. `cards` arrive in the base order (newest first by when raised),
 * which is the tie-break for anything the links don't separate, so an unordered queue is unchanged.
 *
 * A "do after" on B means B comes after A. A "do before" on A means A comes before B. Links to a card
 * that isn't in `cards` (already answered, hidden, or another company) are ignored. A cycle is broken
 * rather than looping: the card the base order ranks earlier comes first, and the rest follow.
 *
 * Returns the ids in do-this-next order, plus each one's 1-based step. Only cards listed in `cards`
 * appear; anything else stays where the caller has it.
 */
export function orderOwnerCards(
  cards: Array<{ id: string; doAfter?: OrderLink[]; doBefore?: OrderLink[] }>,
): { order: string[]; steps: Record<string, number> } {
  const ids = cards.map((c) => c.id);
  const live = new Set(ids);
  const base = new Map(ids.map((id, i) => [id, i]));
  // Edges a -> b meaning "a must be done before b".
  const after = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const add = (before: string, afterId: string) => {
    if (before === afterId || !live.has(before) || !live.has(afterId)) return;
    after.get(before)!.add(afterId);
  };
  for (const c of cards) {
    for (const l of c.doAfter ?? []) add(l.decisionId, c.id);
    for (const l of c.doBefore ?? []) add(c.id, l.decisionId);
  }

  // Kahn's algorithm; among the cards that are free to go next, the base order picks (newest first).
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const [from, tos] of after) for (const to of tos) indeg.set(to, (indeg.get(to) ?? 0) + 1);
  const ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0).sort((a, b) => base.get(a)! - base.get(b)!);
  const order: string[] = [];
  while (order.length < ids.length) {
    if (!ready.length) {
      // A cycle: take the card the base order ranks first among what's left, so we always finish.
      const left = ids.filter((id) => !order.includes(id)).sort((a, b) => base.get(a)! - base.get(b)!);
      const pick = left[0]!;
      indeg.set(pick, 0);
      ready.push(pick);
    }
    const id = ready.shift()!;
    if (order.includes(id)) continue;
    order.push(id);
    for (const to of after.get(id) ?? []) {
      const n = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, n);
      if (n === 0 && !order.includes(to) && !ready.includes(to)) {
        ready.push(to);
        ready.sort((a, b) => base.get(a)! - base.get(b)!);
      }
    }
  }
  const steps: Record<string, number> = {};
  order.forEach((id, i) => (steps[id] = i + 1));
  return { order, steps };
}
