// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "../src/hooks";
import { api, apiOnce, ApiError, READ_TIMEOUT_MS } from "../src/api";
import { SHARED_GET_STALE_MS } from "../src/shared-get";
import { resetServerWatch } from "../src/server-watch";

// BOS-2559: a read that never answers must fail like an error, and a poll waiting on it must try again on its
// next tick. Fake timers throughout: nothing here waits on the real clock.

/** A fetch that never answers, but honours abort the way the browser does. */
function hangingFetch() {
  return vi.fn(
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  );
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetServerWatch();
});

describe("apiOnce: a read that never answers", () => {
  it("is shorter than the shared-read hold, so the hold never outlives the read", () => {
    expect(READ_TIMEOUT_MS).toBeLessThan(SHARED_GET_STALE_MS);
  });

  it("fails with an ApiError (not an AbortError) once the limit passes", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const got = apiOnce("/api/updates-stuck").catch((e) => e);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    const err = await got;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });

  it("lets a slow read inside the limit answer, with one request", async () => {
    const f = vi.fn(() => new Promise<Response>((res) => setTimeout(() => res(json({ ok: 1 })), READ_TIMEOUT_MS - 1000)));
    vi.stubGlobal("fetch", f);
    const got = apiOnce<{ ok: number }>("/api/slow-ok");
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 2);
    await expect(got).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not cut a write short", async () => {
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    let settled = false;
    void apiOnce("/api/x", { method: "POST", body: {} }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 3);
    expect(settled).toBe(false);
  });

  it("still passes a caller's own abort through as an AbortError", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctl = new AbortController();
    const got = apiOnce("/api/x", { signal: ctl.signal }).catch((e) => e);
    ctl.abort();
    expect(((await got) as Error).name).toBe("AbortError");
  });
});

describe("usePoll: a read that timed out", () => {
  it("asks again on the next tick and then shows the data", async () => {
    let calls = 0;
    const f = vi.fn((path: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) return hangingFetch()(path, init);
      return Promise.resolve(json({ ok: true }));
    });
    vi.stubGlobal("fetch", f);
    let seen: { data: unknown; error: ApiError | null } = { data: null, error: null };
    function Poll() {
      const r = usePoll((signal) => api<{ ok: boolean }>("/api/updates-retry", { signal }), 5000, "k");
      seen = r;
      return null;
    }
    render(<Poll />);
    await act(() => vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS));
    expect(f.mock.calls.filter((c) => c[0] === "/api/updates-retry")).toHaveLength(1);
    expect(seen.error).toBeInstanceOf(ApiError);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    // The server-watch banner also probes /api/setup once a read has failed; only the poll's own path counts here.
    expect(f.mock.calls.filter((c) => c[0] === "/api/updates-retry")).toHaveLength(2);
    expect(seen.data).toEqual({ ok: true });
    expect(seen.error).toBeNull();
  });
});
