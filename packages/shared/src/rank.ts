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
