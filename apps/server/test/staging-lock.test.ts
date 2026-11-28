// BOS-2809: tests for withStagingLock (staging-lock.ts), the single in-process lock that stops two
// staging requests (the agent's request, the deploy card and the Settings button) from both passing
// the "nothing waiting" check and the later write replacing the earlier one (BOS-1796).
// No timers or sleeps: each fn is held open by a promise the test resolves by hand.
import { describe, expect, it } from "vitest";
import { withStagingLock } from "../src/services/staging-lock.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let the lock's promise chain (and any queued fn) reach its next await, without a timer.
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("withStagingLock", () => {
  it("does not start the second call until the first has settled", async () => {
    const firstGate = deferred();
    const order: string[] = [];

    const first = withStagingLock(async () => {
      order.push("first:start");
      await firstGate.promise;
      order.push("first:end");
      return "first";
    });
    const second = withStagingLock(async () => {
      order.push("second:start");
      return "second";
    });

    await settle();
    expect(order).toEqual(["first:start"]);

    firstGate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("resolves each call with its own fn's value", async () => {
    const one = withStagingLock(async () => 1);
    const text = withStagingLock(async () => "two");
    const object = withStagingLock(async () => ({ three: 3 }));

    await expect(one).resolves.toBe(1);
    await expect(text).resolves.toBe("two");
    await expect(object).resolves.toEqual({ three: 3 });
  });

  it("rejects the caller with the fn's error, and the next queued call still runs", async () => {
    const failure = new Error("boom");
    const gate = deferred();
    const ran: string[] = [];

    const failing = withStagingLock(async () => {
      ran.push("failing");
      await gate.promise;
      throw failure;
    });
    const next = withStagingLock(async () => {
      ran.push("next");
      return "ok";
    });

    await settle();
    expect(ran).toEqual(["failing"]);

    gate.resolve();
    await expect(failing).rejects.toBe(failure);
    await expect(next).resolves.toBe("ok");
    expect(ran).toEqual(["failing", "next"]);
  });

  it("runs three queued calls in the order they were made", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const order: number[] = [];

    const calls = [0, 1, 2].map((index) =>
      withStagingLock(async () => {
        order.push(index);
        await gates[index]!.promise;
        return index;
      }),
    );

    await settle();
    expect(order).toEqual([0]);

    gates[0]!.resolve();
    await settle();
    expect(order).toEqual([0, 1]);

    gates[1]!.resolve();
    await settle();
    expect(order).toEqual([0, 1, 2]);

    gates[2]!.resolve();
    await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2]);
  });
});
