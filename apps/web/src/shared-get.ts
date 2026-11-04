/**
 * One request per URL at a time: two hooks reading the same path together (App.tsx and Funding.tsx both read
 * /api/runs, several screens read /api/secrets and /api/funding-sources) cost one round trip, not two.
 * For reads only: a POST is never shared, because sharing it would send it once for two callers.
 *
 * Lives in its own module so api.ts and hooks.ts can both use it without importing each other.
 */
type Shared = { promise: Promise<unknown> };

const inFlight = new Map<string, Shared>();

export function sharedGet<S>(key: string, send: (signal: AbortSignal) => Promise<S>): Promise<S> {
  let entry = inFlight.get(key);
  if (!entry) {
    const shared: Shared = { promise: Promise.resolve() };
    // Record the entry before the request can settle: a fast (or failing) answer must still find the entry
    // it belongs to when it clears it, or a finished request would linger and be served to the next reader.
    inFlight.set(key, shared);
    shared.promise = send(new AbortController().signal);
    const cleared = () => {
      if (inFlight.get(key) === shared) inFlight.delete(key);
    };
    shared.promise.then(cleared, cleared);
    entry = shared;
  }
  return entry.promise as Promise<S>;
}
