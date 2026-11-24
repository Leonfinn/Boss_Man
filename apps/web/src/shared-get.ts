/**
 * One request per URL at a time: two hooks reading the same path together (App.tsx and Funding.tsx both read
 * /api/runs, several screens read /api/secrets and /api/funding-sources) cost one round trip, not two.
 * For reads only: a POST is never shared, because sharing it would send it once for two callers.
 *
 * Lives in its own module so api.ts and hooks.ts can both use it without importing each other.
 */
type Shared = { promise: Promise<unknown> };

const inFlight = new Map<string, Shared>();

/**
 * How long a shared read may hold its path before the next reader sends its own request (BOS-2540).
 * A read that never settles (a dropped connection, a server hanging mid-restart) would otherwise keep its key
 * for the rest of the session, and every later reader of that path would wait on it forever ("Loading…" until
 * the tab is reloaded). Well above a normal slow read, so reads in flight together are still shared.
 */
export const SHARED_GET_STALE_MS = 60_000;

export function sharedGet<S>(key: string, send: (signal: AbortSignal) => Promise<S>): Promise<S> {
  let entry = inFlight.get(key);
  if (!entry) {
    const shared: Shared = { promise: Promise.resolve() };
    // Record the entry before the request can settle: a fast (or failing) answer must still find the entry
    // it belongs to when it clears it, or a finished request would linger and be served to the next reader.
    inFlight.set(key, shared);
    const cleared = () => {
      clearTimeout(stale);
      if (inFlight.get(key) === shared) inFlight.delete(key);
    };
    // Only the entry is dropped: the stuck request stays as it is for the callers already waiting on it.
    const stale = setTimeout(cleared, SHARED_GET_STALE_MS);
    try {
      shared.promise = send(new AbortController().signal);
    } catch (err) {
      // A sender that throws before returning a promise must not leave its placeholder behind.
      cleared();
      throw err;
    }
    shared.promise.then(cleared, cleared);
    entry = shared;
  }
  return entry.promise as Promise<S>;
}
