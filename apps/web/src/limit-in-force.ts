// BOS-1634: a limit as the owner saved it and as the scheduler enforces it. The server sends `because`, `since` and
// `until` only when the number in force is lower (a server update's hold), and every screen words it with this one
// function, so Settings and the dashboard can't drift from each other or from the server.

export type LimitInForce = { saved: number; inForce: number; because: string | null; since: string | null; until: string | null };

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "Saved 16 · in force 3 until the update goes in", or null when the saved number is the one in force. */
export function inForceHeadline(l: LimitInForce | null | undefined): string | null {
  if (!l || !l.because || l.inForce >= l.saved) return null;
  return `Saved ${l.saved} · in force ${l.inForce} until the update goes in`;
}

/** The reason in a sentence: why, since when, the latest it lifts, and that the owner has nothing to change. */
export function inForceReason(l: LimitInForce): string {
  const since = l.since ? ` since ${clock(l.since)}` : "";
  const until = l.until ? ` It goes back to ${l.saved} by ${clock(l.until)} at the latest.` : "";
  return `Lower because ${l.because}${since}.${until} Nothing to change: runs already going carry on, and your number comes back by itself.`;
}
