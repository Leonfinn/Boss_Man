// Watches whether the Boss Man server is answering, so a freeze or a version swap shows as a small
// banner over the page rather than in place of it (BOS-637).
//
// The page itself was already fine: the poll hooks keep their last data when a request fails. What
// looked catastrophic was where the message went: a lost connection replaced the whole screen, and
// a failed poll printed its message in place of the page. Now any request that fails because the
// server is restarting, unreachable or over its time limit reports it here: one banner at the top,
// the page stays where it was, and a silent check every few seconds takes the banner away as soon
// as the server answers again. Nothing is retried that would do something; the owner presses Send
// again, and their draft is still in the box (see drafts.ts).

const RESTARTING = new Set([502, 503, 504]);
/** A request that has not answered in this long is treated as a stall; the server's reads answer well under it. */
const SLOW_MS = 10_000;

let outage = false;
let listeners: Array<() => void> = [];
let probe: ReturnType<typeof setInterval> | undefined;

function announce() {
  for (const l of listeners) l();
}

/** The server is away: show the banner and start the quiet checks. Asked twice, still one banner. */
function markDown() {
  if (outage) return;
  outage = true;
  announce();
  if (probe) return;
  probe = setInterval(() => void checkNow(), 3000);
}

/** The server answered: take the banner down and stop the checks. */
function markUp() {
  if (!outage) return;
  outage = false;
  if (probe) clearInterval(probe);
  probe = undefined;
  announce();
}

/** True for a failure that means the server was unavailable, not that it refused the click. */
export function isUnavailable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 0 || (typeof status === "number" && RESTARTING.has(status));
}

/**
 * A screen with nothing to show yet should not print "restarting" in place of itself while the
 * banner already says it: an away server is `true`, so the screen keeps its place and catches up.
 */
export function away(err: unknown): boolean {
  return isUnavailable(err);
}

/** Called by the request client for every failed request: only an unavailable server shows the banner. */
export function reportFailure(err: unknown) {
  if (isUnavailable(err)) markDown();
}

/**
 * Ran for every answered request: one that took far longer than it should have means the server
 * stalled (it answered, but late), so the banner goes up until a check answers quickly again.
 */
export function reportSlow(ms: number) {
  if (ms >= SLOW_MS) markDown();
}

/** Ran for every request the server answered, whatever its status: the server is there. */
export function reportAnswered() {
  markUp();
}

/** One quiet check: does a read come back quickly? Answers with the banner still up when it does not. */
export async function checkNow(): Promise<boolean> {
  try {
    const res = await fetch("/api/setup", {
      credentials: "same-origin",
      cache: "no-store",
      // A request that hangs forever would leave the banner up; a stall is the outage too.
      signal: AbortSignal.timeout(SLOW_MS),
    });
    // A 502/503/504 from the front door is the outage itself; any other answer means it is serving.
    if (RESTARTING.has(res.status)) return outage;
    markUp();
    return false;
  } catch {
    return outage;
  }
}

export function subscribeServer(fn: () => void): () => void {
  listeners = [...listeners, fn];
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export function serverDown(): boolean {
  return outage;
}

/** Back to "the server is here": for a sign-out and for tests, never called while the app runs. */
export function resetServerWatch() {
  markUp();
}
