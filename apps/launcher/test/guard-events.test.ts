import { describe, expect, it } from "vitest";
import type { Docker, DockerEvent } from "../src/docker.js";
import { MAX_RECONNECT_MS, RECONNECT_MS, reconnectWait, watchGuardEvents } from "../src/guard-events.js";

/** A Docker whose event stream the test drives; `sent` records the filters/since of each watch. */
function fakeEvents() {
  const watchers: Array<{ onEvent: (e: DockerEvent) => void; end: () => void }> = [];
  const sent: Array<{ filter: unknown; since: number }> = [];
  const docker: Pick<Docker, "events"> = {
    events(filter, since, onEvent, _onError, signal) {
      sent.push({ filter, since });
      return new Promise<void>((resolve) => {
        const end = () => resolve();
        signal.addEventListener("abort", end, { once: true });
        watchers.push({ onEvent, end });
      });
    },
  };
  /** Emits on the current stream, and ends it, as Docker does when its socket drops. */
  const emit = (e: DockerEvent) => watchers.at(-1)?.onEvent(e);
  const end = () => watchers.at(-1)?.end();
  return { docker, sent, emit, end };
}

const restart = (id = "runner-1"): DockerEvent => ({ Type: "container", Action: "restart", Actor: { ID: id, Attributes: { "boss-man.launcher": "1" } } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the guard's fast path watches Docker events (BOS-335)", () => {
  it("reconciles once at start, then on every runner start, restart or die", async () => {
    const ev = fakeEvents();
    const calls: string[] = [];
    const watch = watchGuardEvents({ docker: ev.docker, label: "boss-man.launcher=1", reconcile: (why) => calls.push(why) });
    // The first reconciliation is the start one, and it happens synchronously.
    expect(calls).toEqual(["start"]);
    await wait(0);
    ev.emit(restart());
    ev.emit({ Type: "container", Action: "start" });
    ev.emit({ Type: "container", Action: "die" });
    expect(calls).toEqual(["start", "docker event", "docker event", "docker event"]);
    // It asks for just the runner label and the three actions that make a new namespace, never the whole stream.
    expect(ev.sent[0]!.filter).toEqual({ type: "container", action: ["start", "restart", "die"], label: "boss-man.launcher=1" });
    watch.stop();
  });

  it("looks back a second when asking, so nothing between a crash and a reconnect is lost", async () => {
    const ev = fakeEvents();
    const watch = watchGuardEvents({ docker: ev.docker, label: "boss-man.launcher=1", reconcile: () => undefined, now: () => 1_700_000_000_500 });
    await wait(0);
    expect(ev.sent[0]!.since).toBe(1_700_000_000 - 1 - 0); // floor(…500 / 1000) - 1
    watch.stop();
  });

  it("reconnects after the stream ends, and stops when told to", async () => {
    const ev = fakeEvents();
    const calls: string[] = [];
    const watch = watchGuardEvents({ docker: ev.docker, label: "boss-man.launcher=1", reconcile: (why) => calls.push(why) });
    await wait(0);
    expect(ev.sent.length).toBe(1);
    // Docker restarted: the stream ends, and the watcher asks again (after the 1 s pause).
    ev.end();
    await wait(1_100);
    expect(ev.sent.length).toBe(2);
    // A runner restart on the new stream is still reconciled at once.
    ev.emit(restart("runner-2"));
    expect(calls).toEqual(["start", "docker event"]);
    watch.stop();
    await wait(1_100);
    expect(ev.sent.length).toBe(2);
  });

  it("backs off when Docker keeps failing, up to the 5 s backstop", async () => {
    // Delays follow 1 s, 2 s, 4 s, then hold at the 5 s maximum: never faster, so a Docker that is down logs once per pause.
    expect(reconnectWait(0)).toBe(RECONNECT_MS);
    expect(reconnectWait(1)).toBe(RECONNECT_MS);
    expect(reconnectWait(2)).toBe(RECONNECT_MS * 2);
    expect(reconnectWait(3)).toBe(RECONNECT_MS * 4);
    expect(reconnectWait(4)).toBe(MAX_RECONNECT_MS);
    expect(reconnectWait(99)).toBe(MAX_RECONNECT_MS);
    // A stream that keeps ending at once is retried: attempt 1 is at once, then 1 s, then 2 s later, so in 2.5 s
    // it has tried twice and is inside the 2 s pause before the third (a fixed 1 s retry would have made five).
    let attempts = 0;
    const docker: Pick<Docker, "events"> = {
      events() {
        attempts += 1;
        return Promise.resolve();
      },
    };
    const watch = watchGuardEvents({ docker, label: "boss-man.launcher=1", reconcile: () => undefined });
    await wait(2_500);
    watch.stop();
    expect(attempts).toBe(2);
  });
});
