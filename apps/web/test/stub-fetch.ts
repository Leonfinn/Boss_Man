// One fetch stub for web tests that answers by URL and fails the test on a request it has no answer for (BOS-2451).
//
// Why: a stub that sends one reply to every URL, or a page-walk server that answers "anything else" with `[]`, lets a
// page's new or forgotten request get a wrong shape. The page then throws late, often after the test ended, and only
// on a slower machine (GitHub): BOS-2425 (Workflow's "Latest retro" got the scorecard), BOS-2420 (a walked page gained
// /api/notifications/week). Here an unanswered request is refused at once, named, and fails the test on every machine.
//
// Routes: keys are paths. A key matches the request's path exactly (the query is ignored), or, ending in "*", any
// path starting with what comes before the "*". A key with a "?" is compared with path and query. The longest
// matching key wins. Exact by default, not prefix: a plain prefix would let "/api/notifications" answer
// "/api/notifications/week" with the wrong shape, the very fault this is here to catch.
//
// Values: a body, sent as 200 JSON, or a function of (url, init) returning a body or a Response (for a status, a
// header, or an answer that changes per call). Return a Response from a function, not as a value: it reads once.
//
//   jsdom:   const fetchMock = stubFetchByUrl({ "/api/companies/c1/workflow": card, "/api/companies/c1/retros/latest": { retro: null, changes: [] } });
//   browser: const stub = urlStub({ ... }); in the http server: const a = stub.answer(req.url); a.found ? 200 + a.body : 404
//
// Every stub made here is checked after each test: any request it could not answer fails that test with
// "no stub for GET /api/…" (an afterEach this file registers in each test file that imports it).
import { afterEach, vi } from "vitest";

export type Reply = unknown | ((url: string, init?: RequestInit) => unknown);
export type Routes = Record<string, Reply>;
export type Found = { found: true; body: unknown } | { found: false };

/** The path (and query) of a URL, absolute or relative. */
function parts(url: string): { path: string; query: string } {
  const u = new URL(url, "http://stub.invalid");
  return { path: u.pathname, query: u.search };
}

/** The route key that answers this URL, or undefined (longest match wins). */
export function matchRoute(routes: Routes, url: string): string | undefined {
  const { path, query } = parts(url);
  let best: string | undefined;
  for (const key of Object.keys(routes)) {
    const target = key.includes("?") ? path + query : path;
    const ok = key.endsWith("*") ? target.startsWith(key.slice(0, -1)) : target === key;
    if (ok && (best === undefined || key.length > best.length)) best = key;
  }
  return best;
}

export type UrlStub = {
  /** What the routes say for this URL; a miss is recorded and named after the test. */
  answer(url: string, init?: RequestInit): Found;
  /** Every request that had no route, as "METHOD url", in order. */
  misses: string[];
  /** Every request seen, as "METHOD url", in order. */
  calls: string[];
  /** The misses so far, emptying the list (so a test can check one step at a time). */
  takeMisses(): string[];
};

const live: UrlStub[] = [];

afterEach(() => {
  // Kept, not cleared: a browser test's stub is made once per file and serves every test in it.
  const missed = live.flatMap((s) => s.takeMisses());
  if (missed.length) throw new Error(`no stub for ${[...new Set(missed)].join(", ")}: add it to the test's stubFetchByUrl/urlStub routes`);
});

/** A route table for any caller (a jsdom fetch, a browser test's http server). */
export function urlStub(routes: Routes): UrlStub {
  const stub: UrlStub = {
    misses: [],
    calls: [],
    answer(url, init) {
      const line = `${(init?.method ?? "GET").toUpperCase()} ${url}`;
      stub.calls.push(line);
      const key = matchRoute(routes, url);
      if (key === undefined) {
        stub.misses.push(line);
        return { found: false };
      }
      const reply = routes[key];
      return { found: true, body: typeof reply === "function" ? (reply as (u: string, i?: RequestInit) => unknown)(url, init) : reply };
    },
    takeMisses() {
      return stub.misses.splice(0);
    },
  };
  live.push(stub);
  return stub;
}

/** Replace the global fetch with one that answers by URL. An unknown URL rejects with "no stub for GET <url>" and
 *  fails the test after it ends, even if the page caught the error. Undo with vi.unstubAllGlobals(). */
export function stubFetchByUrl(routes: Routes) {
  const stub = urlStub(routes);
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const a = stub.answer(url, init ?? (typeof input === "object" && "method" in input ? { method: input.method } : undefined));
    if (!a.found) throw new Error(`no stub for ${(init?.method ?? "GET").toUpperCase()} ${url}`);
    if (a.body instanceof Response) return a.body;
    return new Response(JSON.stringify(a.body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return Object.assign(fn, { stub });
}
