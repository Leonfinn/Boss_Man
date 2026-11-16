import { describe, expect, it, vi } from "vitest";
import { sharedGet } from "../src/shared-get";

// Two screens reading the same path at the same moment (App.tsx and Funding.tsx both read /api/runs) should
// cost one round trip. These tests pin the sharing: same key shares, different keys don't, and the slot is
// freed once the answer (or the failure) arrives so the next reader asks again.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("sharedGet: one request per key at a time", () => {
  it("sends once when two readers ask for the same key together", async () => {
    const gate = deferred<string>();
    const send = vi.fn(() => gate.promise);

    const first = sharedGet("same-key", send);
    const second = sharedGet("same-key", send);

    expect(send).toHaveBeenCalledTimes(1);

    gate.resolve("runs");

    await expect(first).resolves.toBe("runs");
    await expect(second).resolves.toBe("runs");
  });

  it("sends once per key, not once overall", async () => {
    const runs = deferred<string>();
    const secrets = deferred<string>();
    const send = vi.fn((signal: AbortSignal) => {
      void signal;
      return send.mock.calls.length === 1 ? runs.promise : secrets.promise;
    });

    const a = sharedGet("key-a", send);
    const b = sharedGet("key-b", send);

    expect(send).toHaveBeenCalledTimes(2);

    runs.resolve("a");
    secrets.resolve("b");

    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
  });

  it("hands the sender an AbortSignal", async () => {
    const gate = deferred<number>();
    const send = vi.fn((signal: AbortSignal) => {
      void signal;
      return gate.promise;
    });

    const answer = sharedGet("signal-key", send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);

    gate.resolve(1);
    await expect(answer).resolves.toBe(1);
  });

  it("asks again after the previous answer arrived", async () => {
    const send = vi.fn((signal: AbortSignal) => {
      void signal;
      return Promise.resolve("fresh");
    });

    await expect(sharedGet("settled-key", send)).resolves.toBe("fresh");
    await expect(sharedGet("settled-key", send)).resolves.toBe("fresh");

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("frees the key for an answer that settles in the same tick", async () => {
    const send = vi.fn((signal: AbortSignal) => {
      void signal;
      return Promise.resolve("now");
    });

    const first = sharedGet("same-tick-key", send);
    const second = sharedGet("same-tick-key", send);
    expect(send).toHaveBeenCalledTimes(1);

    await Promise.all([first, second]);

    await expect(sharedGet("same-tick-key", send)).resolves.toBe("now");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("shares a failure with everyone waiting, then lets the next reader try again", async () => {
    const gate = deferred<string>();
    const send = vi.fn(() => gate.promise);

    const first = sharedGet("failing-key", send);
    const second = sharedGet("failing-key", send);
    expect(send).toHaveBeenCalledTimes(1);

    gate.reject(new Error("server away"));

    await expect(first).rejects.toThrow("server away");
    await expect(second).rejects.toThrow("server away");
    expect(send).toHaveBeenCalledTimes(1);

    const retry = sharedGet("failing-key", vi.fn(() => Promise.resolve("back")));
    await expect(retry).resolves.toBe("back");
  });
});
