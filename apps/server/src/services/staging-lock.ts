/**
 * One in-process lock for "check that no staging request is waiting, then write one" (BOS-1796). The agent's request, the deploy
 * card's automatic request and the Settings button all do that pair of steps; without the lock two of them can both pass the check
 * and the later write replaces the earlier request, leaving its deploy row "running" for hours.
 */
// lost on restart, harmless because a restart ends every waiting call too, and the request file itself is the durable record
let tail: Promise<unknown> = Promise.resolve();

export function withStagingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
