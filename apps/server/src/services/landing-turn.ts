// Landing turn (BOS-1762). A merge whose check and GitHub run both passed is rebuilt when main moves under it and the move
// touches its files (the runner's carry, merge-carry.ts, lands the rest). With ~50 tickets in review a ticket on hot files can
// chase main for hours. Once a ticket has been rebuilt REBUILDS_FOR_TURN times, it takes its project's landing turn: other
// tickets' finished merges wait to push (their checks and GitHub runs carry on) until it lands, fails, leaves review, or the
// turn's cap runs out. One turn per project; a ticket takes it at most once until its merge ends; a ticket that earns it
// while another holds it is next in line.
//
// In memory, per server process. A restart loses it and loses nothing with it: the merges start again (DR-026) and the
// counts start from zero. The clock is injected so tests never wait on the wall clock.

export const REBUILDS_FOR_TURN = 2;

export type Turn = { ticketId: string; since: number; capMs: number };

export type TurnCheck = { holder: Turn | null; expired: Turn | null };

export class LandingTurns {
  private readonly rebuilds = new Map<string, number>();
  private readonly used = new Set<string>();
  private readonly turns = new Map<string, Turn>();
  private readonly next = new Map<string, Array<{ ticketId: string; capMs: number }>>();

  private readonly epochs = new Map<string, number>();

  /**
   * BOS-2361: told when a turn is promoted from the line ("taken") or released by snapshot() ("expired"). The server sets
   * it once to write the merge-line row; the turn-taking paths that already write their own row don't call it.
   */
  onEvent?: (e: { action: "taken" | "expired"; projectId: string; ticketId: string; capMs: number }) => void;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * BOS-1821: the gate pushed to the project's main. Merges waiting for another ticket's turn ask again whether their pass
   * can still be carried when this changes, rather than only when the turn ends.
   */
  landed(projectId: string): void {
    this.epochs.set(projectId, this.mainEpoch(projectId) + 1);
  }

  /** How many times the gate has pushed to the project's main since this process started (BOS-1821). */
  mainEpoch(projectId: string): number {
    return this.epochs.get(projectId) ?? 0;
  }

  /**
   * One rebuild after a pass. Returns the ticket's count and what happened to the turn: "taken" (it holds it now), "queued"
   * (another ticket holds it; this one is next) or null (not yet earned, already used, or turns are off: capMs 0).
   */
  rebuilt(projectId: string, ticketId: string, capMs: number): { count: number; turn: "taken" | "queued" | null } {
    const count = (this.rebuilds.get(ticketId) ?? 0) + 1;
    this.rebuilds.set(ticketId, count);
    if (capMs <= 0 || count < REBUILDS_FOR_TURN || this.used.has(ticketId)) return { count, turn: null };
    const held = this.check(projectId).holder;
    if (held?.ticketId === ticketId) return { count, turn: null };
    this.used.add(ticketId);
    if (held) {
      const line = this.next.get(projectId) ?? [];
      line.push({ ticketId, capMs });
      this.next.set(projectId, line);
      return { count, turn: "queued" };
    }
    this.turns.set(projectId, { ticketId, since: this.now(), capMs });
    return { count, turn: "taken" };
  }

  /** The project's turn now. A turn past its cap ends here (named in `expired`) and the next in line takes it. */
  check(projectId: string): TurnCheck {
    const t = this.turns.get(projectId) ?? null;
    if (t && this.now() - t.since >= t.capMs) {
      this.turns.delete(projectId);
      this.promote(projectId);
      return { holder: this.turns.get(projectId) ?? null, expired: t };
    }
    return { holder: t, expired: null };
  }

  /** Whether `ticketId` must wait before it pushes: another ticket holds the project's turn. */
  blocks(projectId: string, ticketId: string): boolean {
    const h = this.check(projectId).holder;
    return !!h && h.ticketId !== ticketId;
  }

  holds(projectId: string, ticketId: string): boolean {
    return this.turns.get(projectId)?.ticketId === ticketId;
  }

  /** BOS-2119: whether `ticketId` is in the project's line for the turn (earned it while another ticket held it). */
  queued(projectId: string, ticketId: string): boolean {
    return (this.next.get(projectId) ?? []).some((x) => x.ticketId === ticketId);
  }

  /** BOS-2119: the project's line for the turn, first in line first. Read only: a turn past its cap is ended by check(). */
  line(projectId: string): string[] {
    return (this.next.get(projectId) ?? []).map((x) => x.ticketId);
  }

  /**
   * BOS-2119: every project with a turn held or a line, for server_status. BOS-2361: a turn past its cap is released here
   * (and recorded through onEvent), not shown as held; when no merge polls the turn, nothing else would end it.
   */
  snapshot(): Array<{ projectId: string; holder: Turn | null; line: string[] }> {
    for (const projectId of [...this.turns.keys()]) {
      const c = this.check(projectId);
      if (c.expired) this.onEvent?.({ action: "expired", projectId, ticketId: c.expired.ticketId, capMs: c.expired.capMs });
    }
    const ids = new Set([...this.turns.keys(), ...[...this.next].filter(([, l]) => l.length).map(([id]) => id)]);
    return [...ids].map((projectId) => ({ projectId, holder: this.turns.get(projectId) ?? null, line: this.line(projectId) }));
  }

  /**
   * The ticket's merge ended (landed, failed, left review): its count and its claim on a turn go, and a turn it held passes
   * to the next in line. Returns whether it held the turn.
   */
  done(projectId: string, ticketId: string): boolean {
    this.rebuilds.delete(ticketId);
    this.used.delete(ticketId);
    const line = this.next.get(projectId);
    if (line) this.next.set(projectId, line.filter((x) => x.ticketId !== ticketId));
    if (this.turns.get(projectId)?.ticketId !== ticketId) return false;
    this.turns.delete(projectId);
    this.promote(projectId);
    return true;
  }

  private promote(projectId: string) {
    const line = this.next.get(projectId);
    const n = line?.shift();
    if (!n) return;
    this.turns.set(projectId, { ticketId: n.ticketId, since: this.now(), capMs: n.capMs });
    // BOS-2361: a promotion from the line is a take like a direct one, so it gets its own record.
    this.onEvent?.({ action: "taken", projectId, ticketId: n.ticketId, capMs: n.capMs });
  }
}

/** The server's one set of turns. */
export const landingTurns = new LandingTurns();
