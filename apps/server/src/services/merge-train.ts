/**
 * The merge train (BOS-1366, DR-059 option C): approved tickets land in order, each checked on main plus the tickets ahead of it.
 *
 * This file is the coordinator only: in-memory, per project, pure (an injectable clock, no database, no runner), so its rules are
 * unit-tested on their own. serverMerge (review.ts) drives it: it joins, waits for a seat, asks for its base, reports what it
 * prepared and how its check went, and asks whether it is stale.
 *
 * Main's safety never depends on this state. The runner's finish pushes only when main's tip is exactly the base the checked tree
 * was prepared on (expectBase) and the merge still gives the checked tree. A wrong train (a bad rebuild after a restart, a race)
 * costs a round of checks, never a wrong push. That is why the train is rebuilt after a restart rather than stored (no migration).
 *
 * Words used here:
 * - seat: a place in the train. Up to `seats()` members (the check_slots setting, read at each landing): one check slot each.
 * - base: the commit a member was prepared on: main's tip for the head, the member ahead's prepared commit for the others.
 * - stale: a member whose base is no longer right: the member ahead re-prepared or left, or (the head) its base was a member's
 *   commit that never landed. A stale member prepares again on its new base (a same tree reuses its passed check for free).
 */

export type TrainStatus = "preparing" | "checking" | "passed" | "failed";

export type TrainMember = {
  ticketId: string;
  /** checkPriority: 0 (urgent, a fix for the merge check) before 1. */
  priority: number;
  /** Place in line (ms): the earliest queue time of the ticket's merge jobs (BOS-1328), else when it was approved. */
  place: number;
  /** Commit this member was prepared on (main's tip for the head), and what it prepared; null until prepared. */
  base: string | null;
  commit: string | null;
  tree: string | null;
  status: TrainStatus;
  /** Restacks this landing has had (the cap stops a loop), and whether its failed check got its one flaky re-run. */
  restacks: number;
  rerun: boolean;
};

/** Why a member has to prepare again: the member ahead left or changed, or main moved outside the train. */
export type RestackWhy = "ahead_left" | "ahead_changed" | "main_moved";
/** As recorded on the merge line: a restack, or the cap reached (the member gave up its seat for land()'s back-off). */
export type RestackRecord = RestackWhy | "cap";

/** What a member's failed check means right now (attribution, DR-059): wait for those ahead, restack without them, or it stands. */
export type FailureVerdict = "wait" | "restack" | "stands";

/** How many restacks one landing may have before it falls back to today's main_moved back-off (land() retries later). */
export const TRAIN_RESTACK_CAP = 10;
/** After a server start, how long admissions wait for the tickets that had live merge jobs to re-join in their old order. */
export const TRAIN_SEED_WAIT_MS = 3 * 60_000;

export class MergeTrain {
  /** Seated members, head first. */
  private members: TrainMember[] = [];
  /** Joined but not seated yet. */
  private waiting = new Map<string, { priority: number; place: number; seq: number; headOnly: boolean; passed: number }>();
  private seq = 0;
  /** Prepared commits of members that left without landing (or re-prepared): a head based on one is stale. */
  private lost = new Set<string>();
  /** After a restart: tickets to seat first, in their old order, until they've re-joined or the deadline passes. */
  private seed: { order: string[]; until: number } | null = null;

  constructor(private readonly opts: { seats: () => number; now?: () => number }) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** The members, head first (a copy, for the landing view and the tests). */
  list(): TrainMember[] {
    return this.members.map((m) => ({ ...m }));
  }

  /** Tickets waiting for a seat, in the order they'd be seated. */
  queue(): string[] {
    return [...this.waiting.entries()].sort(([, a], [, b]) => a.priority - b.priority || a.place - b.place || a.seq - b.seq).map(([id]) => id);
  }

  /** Restart (BOS-1289): seat these first, in this order (their old merge jobs' queue order), until all re-joined or `waitMs`. */
  seedOrder(order: string[], waitMs = TRAIN_SEED_WAIT_MS) {
    this.seed = order.length ? { order: [...order], until: this.now() + waitMs } : null;
    this.seenSince = new Set();
  }

  /**
   * A landing that reached the merge (past every hold) asks for a place. Joining twice keeps the first place. `headOnly`: a
   * ticket whose merge on the tickets ahead wasn't clean (a conflict with one that may never land) is seated only as the head,
   * on main alone, where its result is the real one. It keeps its place; later tickets may take free seats past it a few
   * times (see admit), then it holds the line until the train ahead has drained.
   */
  join(ticketId: string, at: { priority: number; place: number; headOnly?: boolean }) {
    if (this.index(ticketId) >= 0 || this.waiting.has(ticketId)) return;
    this.waiting.set(ticketId, { priority: at.priority, place: at.place, seq: this.seq++, headOnly: !!at.headOnly, passed: 0 });
  }

  /** Seats waiting tickets while seats are free; true when this ticket has a seat. Members are never pushed out by a later arrival. */
  seated(ticketId: string): boolean {
    this.admit();
    return this.index(ticketId) >= 0;
  }

  private admit() {
    const seats = Math.max(1, this.opts.seats());
    while (this.members.length < seats && this.waiting.size) {
      if (this.seed && (this.now() >= this.seed.until || this.seed.order.every((id) => !this.wanted(id)))) this.seed = null;
      let next: string | undefined;
      const order = this.queue();
      // A merge-line fix (priority 0) never waits for the restart hold (Brains' build point 5).
      const fix = order.find((id) => this.waiting.get(id)!.priority === 0 && !this.waiting.get(id)!.headOnly);
      if (this.seed && !fix) {
        // Old order first: the first seeded ticket not seated yet. If it hasn't re-joined, nobody is seated until it does (or time's up).
        next = this.seed.order.find((id) => this.index(id) < 0 && this.wanted(id));
        if (!next || !this.waiting.has(next)) return;
      } else {
        // A head-only ticket is seated when the train is empty. Others may pass it meanwhile (it keeps its place), but each only
        // `seats` times: then it holds the line until the train drains, so it can't be starved (Brains' build point 2).
        for (const id of order) {
          const w = this.waiting.get(id)!;
          if (!w.headOnly || !this.members.length) {
            next = id;
            break;
          }
          if (w.passed >= seats) break;
        }
        if (!next) return;
        for (const id of order) {
          if (id === next) break;
          this.waiting.get(id)!.passed++;
        }
      }
      const w = this.waiting.get(next)!;
      this.waiting.delete(next);
      this.members.push({ ticketId: next, priority: w.priority, place: w.place, base: null, commit: null, tree: null, status: "preparing", restacks: 0, rerun: false });
      this.seenSince.add(next);
    }
  }

  /** Tickets seated (or gone) since the seed: a seeded ticket is waited for only until it has been seated once or left. */
  private seenSince = new Set<string>();
  private wanted(id: string) {
    return !this.seenSince.has(id);
  }

  private index(ticketId: string) {
    return this.members.findIndex((m) => m.ticketId === ticketId);
  }

  private member(ticketId: string) {
    const m = this.members[this.index(ticketId)];
    if (!m) throw new Error(`Ticket ${ticketId} is not in the merge train.`);
    return m;
  }

  isHead(ticketId: string) {
    return this.index(ticketId) === 0;
  }

  /** Position (0 = head) and how many are ahead, for the merge-line record; null when not seated. */
  place(ticketId: string): { place: number; ahead: string[] } | null {
    const i = this.index(ticketId);
    return i < 0 ? null : { place: i + 1, ahead: this.members.slice(0, i).map((m) => m.ticketId) };
  }

  /**
   * Where to prepare: null = on main (the head), otherwise the prepared commit of the member ahead. `wait` while the member
   * ahead hasn't prepared yet.
   */
  baseFor(ticketId: string): { wait: true } | { wait: false; base: string | null } {
    const i = this.index(ticketId);
    if (i < 0) throw new Error(`Ticket ${ticketId} is not in the merge train.`);
    if (i === 0) return { wait: false, base: null };
    const ahead = this.members[i - 1]!;
    return ahead.commit ? { wait: false, base: ahead.commit } : { wait: true };
  }

  /** Prepare came back: `base` is the commit it was really built on (the runner's targetSha). */
  prepared(ticketId: string, p: { base: string; commit: string; tree: string }) {
    const m = this.member(ticketId);
    if (m.commit && m.commit !== p.commit) this.lost.add(m.commit);
    Object.assign(m, { base: p.base, commit: p.commit, tree: p.tree, status: "checking" as const });
  }

  /** The check job was moved to a new tree while queued (BOS-1344 retarget): same as a prepare. */
  retargeted(ticketId: string, p: { base: string; commit: string; tree: string }) {
    this.prepared(ticketId, p);
  }

  /** Why this member must prepare again, or null when its base still holds. */
  stale(ticketId: string): RestackWhy | null {
    const i = this.index(ticketId);
    if (i < 0) return null;
    const m = this.members[i]!;
    if (!m.base) return null;
    if (i === 0) return this.lost.has(m.base) ? "ahead_left" : null;
    const ahead = this.members[i - 1]!;
    if (!ahead.commit) return "ahead_changed";
    if (ahead.commit === m.base) return null;
    return this.lost.has(m.base) && !this.members.some((x) => x.commit === m.base) ? "ahead_left" : "ahead_changed";
  }

  /** The member starts again on a new base: it drops what it prepared. False once the cap is reached (fall back to land()'s back-off). */
  restack(ticketId: string): boolean {
    const m = this.member(ticketId);
    if (m.commit) this.lost.add(m.commit);
    Object.assign(m, { base: null, commit: null, tree: null, status: "preparing" as const, rerun: false });
    m.restacks++;
    return m.restacks <= TRAIN_RESTACK_CAP;
  }

  passed(ticketId: string) {
    this.member(ticketId).status = "passed";
  }

  failed(ticketId: string) {
    this.member(ticketId).status = "failed";
  }

  /** The one flaky re-run (DR-059 answer 3b) is running: those behind keep waiting on this member. Returns false if it already had it. */
  rerun(ticketId: string): boolean {
    const m = this.member(ticketId);
    if (m.rerun) return false;
    m.rerun = true;
    m.status = "checking";
    return true;
  }

  /**
   * Attribution: a failed check is this member's only once every member ahead has passed on its current tree. If this member is
   * stale (one ahead failed and left, or changed), it restacks without it: no bounce charged. Otherwise it waits.
   */
  failure(ticketId: string): FailureVerdict {
    if (this.stale(ticketId)) return "restack";
    const i = this.index(ticketId);
    if (i < 0) return "stands";
    return this.members.slice(0, i).every((m) => m.status === "passed") ? "stands" : "wait";
  }

  /** The head pushed `commit` (its prepared commit): it leaves, and the member behind's base is now main. */
  landed(ticketId: string) {
    const i = this.index(ticketId);
    if (i < 0) return;
    this.members.splice(i, 1);
  }

  /**
   * Leaves without landing (sent back, an error, the ticket left review, the switch was turned off for it). Its commit is lost, so
   * the member behind is stale. Safe to call twice, and for a ticket that is only waiting.
   */
  leave(ticketId: string) {
    this.waiting.delete(ticketId);
    this.seenSince.add(ticketId);
    const i = this.index(ticketId);
    if (i < 0) return;
    const [m] = this.members.splice(i, 1);
    if (m?.commit) this.lost.add(m.commit);
  }

  get size() {
    return this.members.length + this.waiting.size;
  }
}

/** One train per project, on the server in charge. Cleared only by a restart (the train is rebuilt, never stored). */
// lost on restart, harmless because the train is rebuilt from the live merge jobs in their old order (BOS-1289), and the runner's expectBase + tree check refuse any push a wrong rebuild would make.
const trains = new Map<string, MergeTrain>();

// lost on restart, harmless because every trainFor() call sets it again from the check_slots setting.
const seatCounts = new Map<string, number>();

/** The project's train; `seats` (check_slots, read by the caller) applies from now on. `created`: first use since the server started. */
export function trainFor(projectId: string, seats: number): { train: MergeTrain; created: boolean } {
  seatCounts.set(projectId, seats);
  const had = trains.get(projectId);
  if (had) return { train: had, created: false };
  const train = new MergeTrain({ seats: () => seatCounts.get(projectId) ?? 1 });
  trains.set(projectId, train);
  return { train, created: true };
}

/** Tests only: forget every train, as a restart does. */
export function resetTrains() {
  trains.clear();
  seatCounts.clear();
}
