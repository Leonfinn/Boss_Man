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
  /** BOS-1604: when it last prepared, and how many restacks in a row came sooner than TRAIN_QUICK_RESTACK_MS after a prepare. */
  preparedAt: number | null;
  quick: number;
};

/** Why a member has to prepare again: the member ahead left or changed, or main moved outside the train. */
export type RestackWhy = "ahead_left" | "ahead_changed" | "main_moved";
/** As recorded on the merge line: a restack, or the cap reached (the member gave up its seat for land()'s back-off). */
export type RestackRecord = RestackWhy | "cap";

/** What a member's failed check means right now (attribution, DR-059): wait for those ahead, restack without them, or it stands. */
export type FailureVerdict = "wait" | "restack" | "stands";

/** How many restacks one landing may have before it falls back to today's main_moved back-off (land() retries later). */
export const TRAIN_RESTACK_CAP = 10;
/**
 * BOS-1604: a restack this soon after its prepare is "quick": no check could have run (the quickest merge check takes minutes).
 * From the second quick restack in a row the member backs off before preparing again, doubling up to the max; at
 * TRAIN_THRASH_QUICK in a row the train reports thrash and the stall alarm tells the CEO once.
 */
export const TRAIN_QUICK_RESTACK_MS = 60_000;
export const TRAIN_RESTACK_BACKOFF_MS = 15_000;
export const TRAIN_RESTACK_BACKOFF_MAX_MS = 2 * 60_000;
export const TRAIN_THRASH_QUICK = 3;
/** After a server start, how long admissions wait for the tickets that had live merge jobs to re-join in their old order. */
export const TRAIN_SEED_WAIT_MS = 3 * 60_000;

/** BOS-1515: why a head-only ticket waits to land alone: the members it clashed with (ticket ids) and the files, and when. */
export type TrainClash = { with: string[]; files: string[]; at: number };

/** BOS-1515: a waiting head-only ticket, with its clash and how many tickets have taken a seat past it (it holds the line at `seats`). */
export type HeldAlone = { ticketId: string; clash: TrainClash | null; passed: number; holdsLine: boolean };

/** BOS-1515: the train's state for server_status and the stall alarm. Times are ms; null when not so. */
export type TrainFacts = {
  seats: number;
  seated: string[];
  waiting: string[];
  heldAlone: HeldAlone[];
  /** Since when a ticket that could take a seat has waited while one is free (outside the restart seed wait). */
  emptySeatSince: number | null;
  /** The last landing since this server built the train; null when none yet. */
  lastLandingAt: number | null;
  /** While tickets are in the train: since when nothing has landed (the later of the last landing and the line getting busy). */
  noLandingSince: number | null;
  /** True during the restart seed wait (BOS-1289): empty seats are expected then. */
  seeding: boolean;
  /** BOS-1604: since when members have restacked in a loop, faster than a check can run; null when not so. */
  thrashSince: number | null;
};

export class MergeTrain {
  /** Seated members, head first. */
  private members: TrainMember[] = [];
  /** Joined but not seated yet. */
  private waiting = new Map<string, { priority: number; place: number; seq: number; headOnly: boolean; passed: number; clash: TrainClash | null }>();
  /** BOS-1515 stall clocks, kept by track() after every change and on each read. */
  private emptySince: number | null = null;
  private busySince: number | null = null;
  private lastLanding: number | null = null;
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
  join(ticketId: string, at: { priority: number; place: number; headOnly?: boolean; clash?: TrainClash | null }) {
    if (this.index(ticketId) >= 0 || this.waiting.has(ticketId)) return;
    this.waiting.set(ticketId, { priority: at.priority, place: at.place, seq: this.seq++, headOnly: !!at.headOnly, passed: 0, clash: at.clash ?? null });
    this.track();
  }

  /** Seats waiting tickets while seats are free; true when this ticket has a seat. Members are never pushed out by a later arrival. */
  seated(ticketId: string): boolean {
    this.admit();
    this.track();
    return this.index(ticketId) >= 0;
  }

  private seeding() {
    return !!this.seed && this.now() < this.seed.until && this.seed.order.some((id) => this.wanted(id));
  }

  /**
   * BOS-1515: keeps the stall clocks. An empty seat counts only while a ticket that could take it waits: a head-only ticket
   * alone, waiting for the members ahead to land, is the design (B2 sends it back if its clash reaches main), not a stall. It
   * does count when the head-only ticket has been passed `seats` times and holds the line for others (14 Nov).
   */
  private track() {
    const t = this.now();
    const seats = Math.max(1, this.opts.seats());
    const blocked = [...this.waiting.values()].some((w) => !w.headOnly);
    const empty = this.members.length < seats && blocked && !this.seeding();
    if (!empty) this.emptySince = null;
    else this.emptySince ??= t;
    if (!this.size) this.busySince = this.thrashSince = null;
    else this.busySince ??= t;
  }

  /** BOS-1515: waiting head-only tickets, in line order, with their clash and whether they hold the line now. */
  heldAlone(): HeldAlone[] {
    const seats = Math.max(1, this.opts.seats());
    return this.queue()
      .map((id) => [id, this.waiting.get(id)!] as const)
      .filter(([, w]) => w.headOnly)
      .map(([id, w]) => ({ ticketId: id, clash: w.clash ? { ...w.clash, with: [...w.clash.with], files: [...w.clash.files] } : null, passed: w.passed, holdsLine: w.passed >= seats && this.members.length > 0 }));
  }

  /** BOS-1515: the clash a waiting ticket was held alone for, if any. */
  clashOf(ticketId: string): TrainClash | null {
    return this.waiting.get(ticketId)?.clash ?? null;
  }

  /** BOS-1515: the facts the stall alarm and server_status read. Reading also brings the clocks up to date (seats can change). */
  facts(): TrainFacts {
    this.track();
    const noLandingSince = this.busySince === null ? null : Math.max(this.busySince, this.lastLanding ?? 0);
    return {
      seats: Math.max(1, this.opts.seats()),
      seated: this.seatedIds(),
      waiting: this.queue(),
      heldAlone: this.heldAlone(),
      emptySeatSince: this.emptySince,
      lastLandingAt: this.lastLanding,
      noLandingSince,
      seeding: this.seeding(),
      thrashSince: this.thrashSince,
    };
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
      this.members.push({ ticketId: next, priority: w.priority, place: w.place, base: null, commit: null, tree: null, status: "preparing", restacks: 0, rerun: false, preparedAt: null, quick: 0 });
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

  /**
   * Prepare came back: `base` is the commit it was really built on (the runner's targetSha). `onMain`: it was prepared on main
   * (no base asked for), so `base` is main's tip as the runner just fetched it.
   */
  prepared(ticketId: string, p: { base: string; commit: string; tree: string; onMain?: boolean }) {
    if (p.onMain) this.onMain(p.base);
    const m = this.member(ticketId);
    if (m.commit && m.commit !== p.commit) this.lose(m.commit);
    Object.assign(m, { base: p.base, commit: p.commit, tree: p.tree, status: "checking" as const, preparedAt: this.now() });
  }

  /** The check job was moved to a new tree while queued (BOS-1344 retarget): same as a prepare. */
  retargeted(ticketId: string, p: { base: string; commit: string; tree: string; onMain?: boolean }) {
    this.prepared(ticketId, p);
  }

  /**
   * BOS-1604: `sha` is main's tip, so it landed, whatever the train thought. On 15 Nov BOS-1549's push reached main while the
   * runner update cut off the answer: its landing ended as a failure, leave() put its commit in `lost`, and that commit was
   * main's tip. Every head then prepared on main, was "stale" (ahead_left) at the first poll and restacked, for over an hour.
   * A commit seen on main is never lost.
   */
  onMain(sha: string) {
    if (!sha) return;
    this.tip = sha;
    this.lost.delete(sha);
  }

  /** Main's tip as last seen by a prepare on main; a commit equal to it is never marked lost. */
  private tip: string | null = null;

  private lose(commit: string) {
    if (commit !== this.tip) this.lost.add(commit);
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
    if (m.commit) this.lose(m.commit);
    // BOS-1604: a restack sooner than a check could have run counts as quick; a run of them is a loop, not a busy train.
    m.quick = m.preparedAt !== null && this.now() - m.preparedAt < TRAIN_QUICK_RESTACK_MS ? m.quick + 1 : 0;
    if (m.quick >= TRAIN_THRASH_QUICK) this.thrashSince ??= this.now();
    Object.assign(m, { base: null, commit: null, tree: null, status: "preparing" as const, rerun: false, preparedAt: null });
    m.restacks++;
    return m.restacks <= TRAIN_RESTACK_CAP;
  }

  /**
   * BOS-1604: how long this member waits before it prepares again. The first quick restack is free (the member ahead really
   * did change); from the second in a row it doubles from TRAIN_RESTACK_BACKOFF_MS up to the max, so a train whose base keeps
   * going stale costs a prepare every few minutes, not every 3 s, and the check queue isn't flooded meanwhile.
   */
  backoffMs(ticketId: string): number {
    const m = this.members[this.index(ticketId)];
    if (!m || m.quick < 2) return 0;
    return Math.min(TRAIN_RESTACK_BACKOFF_MS * 2 ** (m.quick - 2), TRAIN_RESTACK_BACKOFF_MAX_MS);
  }

  /** BOS-1604: since when members have restacked in a loop (TRAIN_THRASH_QUICK quick restacks in a row); cleared by a landing. */
  private thrashSince: number | null = null;

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
    const [m] = this.members.splice(i, 1);
    if (m?.commit) this.onMain(m.commit);
    this.lastLanding = this.now();
    this.thrashSince = null;
    this.track();
  }

  /**
   * Leaves without landing (sent back, an error, the ticket left review, the switch was turned off for it). Its commit is lost, so
   * the member behind is stale. Safe to call twice, and for a ticket that is only waiting.
   */
  leave(ticketId: string) {
    this.waiting.delete(ticketId);
    this.seenSince.add(ticketId);
    const i = this.index(ticketId);
    if (i >= 0) {
      const [m] = this.members.splice(i, 1);
      if (m?.commit) this.lose(m.commit);
    }
    this.track();
  }

  get size() {
    return this.members.length + this.waiting.size;
  }

  /** Seated tickets, head first (BOS-1504: the check queue serves their merge jobs in this order). */
  seatedIds(): string[] {
    return this.members.map((m) => m.ticketId);
  }

  /**
   * BOS-1504: a merge job of this ticket must not take a check slot now. True while it waits for a seat, and after a restart
   * while the seed still names it and it hasn't been seated or left (its landing may not have re-joined yet). A slot spent on
   * it would check a tree no landing uses: when it is seated, it prepares again on the train's base.
   */
  withheld(ticketId: string): boolean {
    if (this.index(ticketId) >= 0) return false;
    if (this.waiting.has(ticketId)) return true;
    return !!this.seed && this.now() < this.seed.until && this.seed.order.includes(ticketId) && this.wanted(ticketId);
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

/**
 * BOS-1504: what the check queue needs from a project's train: the seated tickets (head first) and which tickets' merge jobs to
 * hold back. Null when this server has no train for the project (a standby copy, or no landing since it started): then the
 * queue serves as it did before. Runners connect only to the server in charge, so the queue's pump runs beside the trains.
 */
export function trainView(projectId: string): { seated: string[]; withheld: (ticketId: string) => boolean } | null {
  const train = trains.get(projectId);
  return train ? { seated: train.seatedIds(), withheld: (id) => train.withheld(id) } : null;
}

/** BOS-1515: the train's facts (seats, who waits, held-alone clashes, stall clocks); null when this server has no train for it. */
export function trainFacts(projectId: string): TrainFacts | null {
  return trains.get(projectId)?.facts() ?? null;
}

/** BOS-1515: the projects this server has a train for (the stall sweep walks these). */
export function trainProjects(): string[] {
  return [...trains.keys()];
}

// lost on restart, harmless: a waiting ticket's first trial runs whatever the count is (its last-seen value starts unset).
const mainGens = new Map<string, number>();

/**
 * BOS-1515 (B2): main moved for this project (a ticket landed through Boss Man). Waiting tickets try a merge on main again when
 * this changes. A merge made outside Boss Man doesn't count here; the waiting loop's fallback trial catches it.
 */
export function mainMoved(projectId: string) {
  mainGens.set(projectId, (mainGens.get(projectId) ?? 0) + 1);
}

export function mainGen(projectId: string): number {
  return mainGens.get(projectId) ?? 0;
}

/** Tests only: forget every train, as a restart does. */
export function resetTrains() {
  trains.clear();
  seatCounts.clear();
  mainGens.clear();
}
