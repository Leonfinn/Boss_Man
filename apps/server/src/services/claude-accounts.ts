// Which of the owner's Claude subscriptions a new run goes to (BOS-383). Pure: the scheduler
// works out, for each account in the owner's order, whether a new run may start on it, and this
// picks the first that can.

export interface AccountCandidate<S> {
  source: S;
  /** Position in the owner's list; 1 is the preferred account. */
  rank: number;
  /** Whether a new run of this kind may start on the account right now. */
  passes: boolean;
  /** Whether the account is under its hold threshold (so no extra usage is needed). Defaults to passes. */
  hasRoom?: boolean;
}

/**
 * The first account in the owner's order with real room; when none has room, the first that may
 * still run (extra usage allowed), else null (the existing quota hold then applies). Extra usage is
 * therefore spent only when no account in the list has room (BOS-463). Going back to the preferred
 * account needs no memory: it is first again as soon as its window has reset.
 */
export function pickAccount<S>(candidates: AccountCandidate<S>[]): S | null {
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank);
  return (ordered.find((c) => c.passes && (c.hasRoom ?? true)) ?? ordered.find((c) => c.passes))?.source ?? null;
}
