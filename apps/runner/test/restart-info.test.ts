// BOS-594: the runner tells the server how its last process ended and when the host booted.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostBootAt, markStopped, previousExit } from "../src/restart-info.js";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(path.join(tmpdir(), "bm-restart-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("previousExit", () => {
  it("is null on a first start, crashed after a start that never stopped, stopped after a SIGTERM", () => {
    const d = fresh();
    expect(previousExit(d)).toBeNull(); // nothing ran here before
    expect(previousExit(d)).toBe("crashed"); // the last process ended without markStopped: killed or crashed
    markStopped(d);
    expect(previousExit(d)).toBe("stopped");
    // The marker is used once: the next start without a stop is a crash again.
    expect(previousExit(d)).toBe("crashed");
  });
});

describe("hostBootAt", () => {
  it("reads the kernel's btime as an ISO time, and null when it can't", () => {
    const d = fresh();
    const stat = path.join(d, "stat");
    writeFileSync(stat, "cpu  1 2 3\nbtime 1793918400\nprocesses 5\n");
    expect(hostBootAt(stat)).toBe(new Date(1793918400 * 1000).toISOString());
    writeFileSync(stat, "cpu 1 2 3\n");
    expect(hostBootAt(stat)).toBeNull();
    expect(hostBootAt(path.join(d, "missing"))).toBeNull();
  });
});
