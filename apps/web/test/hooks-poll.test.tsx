// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "../src/hooks";
import { api } from "../src/api";

/**
 * BOS-408: usePoll keeps one chain per hook, pauses while the tab is hidden, and hooks polling the
 * same URL share one request. The first two fail on the old hook (a second chain started on every
 * visibility change mid-request, and polling carried on while hidden); the third fails on the old
 * api(), which sent one request per hook.
 */

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

let shown = true;
/** The tab looks away or comes back: the browser fires exactly one event per change, and nothing else. */
function setHidden(hidden: boolean) {
  shown = !hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

function Poll({ url, every }: { url: string; every: number }) {
  usePoll((signal) => api(url, { signal }), every, url);
  return null;
}

/** Let React settle: mount effects, the fetch, and the state updates that follow. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  shown = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (shown ? "visible" : "hidden"));
  vi.spyOn(document, "hidden", "get").mockImplementation(() => !shown);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePoll", () => {
  it("a visibility change during an in-flight request leaves exactly one loop", async () => {
    const resolvers: Array<() => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(() => resolve(json({ ok: true })));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<Poll url="/api/runs" every={1000} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);

    // The owner looks away and back while the first request is still out: twice, as slow responses allow.
    setHidden(true);
    setHidden(false);
    setHidden(true);
    setHidden(false);
    // Nothing new may start while the first request is still in flight.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // It comes back: the remembered reload runs once, and only one chain is left.
    resolvers[0]!();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1]!();
    await settle();

    // One tick of the clock is one request, not two or three.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    resolvers[2]!();
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Let the last answer land so it does not outlive the test and linger for the next one.
    resolvers[3]!();
    await settle();
  });

  it("no request fires while the tab is hidden, and one reload happens on return", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(<Poll url="/api/decisions" every={1000} />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setHidden(false);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("hooks polling the same URL share one request", async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    // App.tsx and Funding.tsx both poll /api/runs: mounting both must cost one round trip, not two
    // (the old code sent one per hook, so this fails there).
    render(
      <>
        <Poll url="/api/runs" every={1000} />
        <Poll url="/api/runs" every={2000} />
      </>,
    );
    await settle();
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
