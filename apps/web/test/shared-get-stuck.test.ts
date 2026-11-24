import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARED_GET_STALE_MS, sharedGet } from "../src/shared-get";

// BOS-2540: a shared read that never answers must not hold its path for the rest of the session. These use
// fake timers, so no test waits on the real clock; each key is unique because the module's map lives on
// between tests in this file.

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("sharedGet: a read that never answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is still shared with readers that arrive before the limit", () => {
    const send = vi.fn(() => never<string>());
    const first = sharedGet("stuck-shared", send);
    vi.advanceTimersByTime(SHARED_GET_STALE_MS - 1);
    const second = sharedGet("stuck-shared", send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("lets a later reader send a fresh request, which answers", async () => {
    const stuck = vi.fn(() => never<string>());
    const first = sharedGet("stuck-then-fresh", stuck);

    vi.advanceTimersByTime(SHARED_GET_STALE_MS);

    const fresh = vi.fn(() => Promise.resolve("back"));
    const later = sharedGet("stuck-then-fresh", fresh);

    expect(stuck).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(later).not.toBe(first);
    await expect(later).resolves.toBe("back");
  });

  it("leaves the fresh request's entry alone when the old one finally answers", async () => {
    let answerOld!: (v: string) => void;
    const old = sharedGet("late-old", () => new Promise<string>((res) => (answerOld = res)));
    vi.advanceTimersByTime(SHARED_GET_STALE_MS);

    let answerFresh!: (v: string) => void;
    const freshSend = vi.fn(() => new Promise<string>((res) => (answerFresh = res)));
    const fresh = sharedGet("late-old", freshSend);

    // The old request answers late: its callers get their answer, and the fresh one is still shared.
    answerOld("old");
    await expect(old).resolves.toBe("old");
    const alongside = sharedGet("late-old", freshSend);
    expect(alongside).toBe(fresh);
    expect(freshSend).toHaveBeenCalledTimes(1);

    answerFresh("fresh");
    await expect(fresh).resolves.toBe("fresh");
  });

  it("does not drop a later request's entry when an answered one's limit would have passed", async () => {
    await expect(sharedGet("answered-then-slow", () => Promise.resolve("a"))).resolves.toBe("a");

    const slowSend = vi.fn(() => never<string>());
    const slow = sharedGet("answered-then-slow", slowSend);
    // The first request's timer was cleared when it answered, so it can't cut the second one short.
    vi.advanceTimersByTime(SHARED_GET_STALE_MS - 1);
    expect(sharedGet("answered-then-slow", slowSend)).toBe(slow);
    expect(slowSend).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("frees the key when the sender throws before returning a promise", async () => {
    expect(() =>
      sharedGet("throws-sync", () => {
        throw new Error("bad request");
      }),
    ).toThrow("bad request");

    await expect(sharedGet("throws-sync", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});
