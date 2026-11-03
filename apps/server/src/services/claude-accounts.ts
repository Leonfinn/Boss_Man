// Which of the owner's Claude subscriptions a new run goes to (BOS-383). Pure: the scheduler
// works out, for each account in the owner's order, whether a new run may start on it, and this
// picks the first that can.

export interface AccountCandidate<S> {
  source: S;
  /** Position in the owner's list; 1 is the preferred account. */
  rank: number;
  /** Whether a new run of this kind may start on the account right now. */
  passes: boolean;
}

/**
 * The first account in the owner's order that has room, or null when every one is full (the
 * existing quota hold then applies). Going back to the preferred account needs no memory: it is
 * first again as soon as its window has reset.
 */
export function pickAccount<S>(candidates: AccountCandidate<S>[]): S | null {
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank);
  return ordered.find((c) => c.passes)?.source ?? null;
}
