/** BOS-2475: for each open card on the board, the other open cards that wait on it (their `blockedBy` names its id). */
type WaitCard = {
  id: string;
  systemState?: string;
  outcome?: string | null;
  blockedBy?: Array<{ ticketId: string | null }>;
};

/** Card id -> the cards waiting on it. Done and cancelled cards neither count nor are counted; a card never waits on itself. */
export function waitingOnThis<T extends WaitCard>(cards: T[]): Map<string, T[]> {
  const open = cards.filter((c) => c.systemState !== "done" && c.outcome !== "cancelled");
  const ids = new Set(open.map((c) => c.id));
  const out = new Map<string, T[]>();
  for (const c of open) {
    const seen = new Set<string>();
    for (const b of c.blockedBy ?? []) {
      if (!b.ticketId || b.ticketId === c.id || !ids.has(b.ticketId) || seen.has(b.ticketId)) continue;
      seen.add(b.ticketId);
      out.set(b.ticketId, [...(out.get(b.ticketId) ?? []), c]);
    }
  }
  return out;
}

export function waitingWords(n: number): string {
  return `${n} waiting on this`;
}
