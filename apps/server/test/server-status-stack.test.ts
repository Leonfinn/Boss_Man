import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import type { BlueGreen } from "../src/services/bluegreen.js";
import { serverStatusService, stackSummary } from "../src/services/server-status.js";

// BOS-489 (DR-020 E): server_status names the whole stack, so one server answering is never read as "up".
const NOW = new Date("2026-11-05T12:00:00Z");
const DB = "2026-11-01T00:00:00.000Z";
const colour = (c: string, up: boolean, role: string | null) => ({ colour: c, up, role, commit: up ? "abc" : null, startedAt: null });
const bg = (green: ReturnType<typeof colour>): BlueGreen => ({ enabled: true, self: "blue", colours: [colour("blue", true, "leader"), green] });
const single: BlueGreen = { enabled: false };
const base = { role: "leader", colours: single, dbStartedAt: DB, status: null, available: null, now: NOW };
const deployedAt = (secondsAgo: number) => ({ target: "server", result: "deployed", ended: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(), message: "" });

describe("stackSummary", () => {
  it("is healthy on a single server with a database and no failed deploy", () => {
    expect(stackSummary(base)).toEqual({ stack: "healthy", why: [] });
    expect(stackSummary({ ...base, role: "single" }).stack).toBe("healthy");
  });

  it("reads a failed or partial deploy as degraded, with the deployer's message", () => {
    const failed = stackSummary({ ...base, status: { target: "server", result: "failed", message: "the automatic switch-back to green ALSO failed" } });
    expect(failed.stack).toBe("degraded");
    expect(failed.why.join(" ")).toContain("ALSO failed");
    expect(stackSummary({ ...base, status: { target: "runner", result: "partial", message: "" } }).stack).toBe("degraded");
  });

  // BOS-2616: "degraded" lasted until a runner update succeeded, even when none was needed any more.
  it("drops a failed runner update once no runner update is needed, and keeps it when one is or Boss Man can't tell", () => {
    const failed = { target: "runner", result: "failed", message: "The runner action stopped with an error (exit 1)." };
    expect(stackSummary({ ...base, status: failed, runnerUpdate: { state: "not_needed" } })).toEqual({ stack: "healthy", why: [] });
    expect(stackSummary({ ...base, status: failed, runnerUpdate: { state: "needed" } }).stack).toBe("degraded");
    expect(stackSummary({ ...base, status: failed, runnerUpdate: { state: "unknown" } }).stack).toBe("degraded");
    expect(stackSummary({ ...base, status: failed, runnerUpdate: null }).stack).toBe("degraded");
    // A failed server deploy is never excused by the runner answer.
    expect(stackSummary({ ...base, status: { ...failed, target: "server" }, runnerUpdate: { state: "not_needed" } }).stack).toBe("degraded");
  });

  it("clears once a later deploy result replaces the failed one", () => {
    expect(stackSummary({ ...base, status: { target: "server", result: "deployed", ended: DB } }).stack).toBe("healthy");
  });

  it("is down with no database or no leader", () => {
    expect(stackSummary({ ...base, dbStartedAt: null })).toMatchObject({ stack: "down", why: ["The database did not answer."] });
    expect(stackSummary({ ...base, role: "standby", colours: bg(colour("green", false, null)) }).stack).toBe("down");
  });

  it("counts the other colour's leadership", () => {
    expect(stackSummary({ ...base, role: "standby", colours: bg(colour("green", true, "leader")) }).stack).toBe("healthy");
    expect(stackSummary({ ...base, colours: bg(colour("green", true, "leader")) })).toMatchObject({ stack: "degraded", why: ["More than one server says it leads."] });
  });

  it("wants the other colour up only during the standby window after a swap", () => {
    const greenDown = bg(colour("green", false, null));
    // Inside the window (default 900 s, or the host's soakSeconds) a down standby is degraded.
    expect(stackSummary({ ...base, colours: greenDown, status: deployedAt(60) }).stack).toBe("degraded");
    expect(stackSummary({ ...base, colours: greenDown, status: deployedAt(60), available: { soakSeconds: 30 } }).stack).toBe("healthy");
    // After it the deployer stops the old colour on purpose.
    expect(stackSummary({ ...base, colours: greenDown, status: deployedAt(901) }).stack).toBe("healthy");
    expect(stackSummary({ ...base, colours: bg(colour("green", true, "standby")), status: deployedAt(60) }).stack).toBe("healthy");
  });

  it("is degraded when the colours could not be checked", () => {
    expect(stackSummary({ ...base, colours: null })).toMatchObject({ stack: "degraded", why: ["The other colour could not be checked."] });
  });
});

describe("server_status stack fields", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function status(deps: { colours?: () => Promise<BlueGreen>; status?: unknown; runnerUpdate?: unknown; cpuReserve?: () => Promise<unknown> }) {
    const opened = await openPglite();
    close = opened.close;
    const svc = serverStatusService(opened.db, {
      role: () => "leader", isConnected: () => false, hold: async () => null,
      errors: { recent: () => [], count: () => 0, untagged: () => 0 } as never,
      deploy: async () => ({ enabled: true, pending: false, status: deps.status ?? null, available: null, runnerUpdate: deps.runnerUpdate ?? null }),
      colours: deps.colours,
      cpuReserve: deps.cpuReserve,
      commit: "dev", startedAt: new Date(0), now: () => NOW,
    });
    return svc.status(randomUUID());
  }

  it("shows both colours, the database start time and the stack", async () => {
    const both = bg(colour("green", true, "standby"));
    const s = await status({ colours: async () => both });
    expect(s).toMatchObject({ stack: "healthy", stackWhy: [], colours: both });
    expect(Date.parse(s.database.startedAt!)).not.toBeNaN();
  });

  it("reports the 4 Nov case (server answers, switch-back failed) as degraded", async () => {
    const s = await status({
      colours: async () => bg(colour("green", false, null)),
      status: { target: "server", result: "failed", message: "The checks on blue failed and the automatic switch-back to green ALSO failed" },
    });
    expect(s.stack).toBe("degraded");
    expect(s.deploy.lastResult).toBe("failed");
  });

  it("reads the Updates panel's runner answer: a failed runner update nobody needs any more is not degraded (BOS-2616)", async () => {
    const failed = { target: "runner", result: "failed", message: "The runner action stopped with an error (exit 1)." };
    expect((await status({ colours: async () => bg(colour("green", true, "standby")), status: failed, runnerUpdate: { state: "not_needed", words: "Runners are up to date." } })).stack).toBe("healthy");
    await close?.();
    close = undefined;
    expect((await status({ colours: async () => bg(colour("green", true, "standby")), status: failed, runnerUpdate: { state: "needed", words: "Runner update needed." } })).stack).toBe("degraded");
  });

  it("reads a probe that throws as could-not-check, never as a single server", async () => {
    const s = await status({ colours: async () => Promise.reject(new Error("boom")) });
    expect(s).toMatchObject({ stack: "degraded", colours: null });
  });

  // BOS-586: the launcher's GET /cpu reading is passed through; no launcher (or none answering) reads as null.
  it("shows the reserved CPU threads from the launcher, or null without one", async () => {
    const on = { on: true, reserved: [10, 11], runners: "0-9", threads: 12, why: "auto: 12 threads" };
    expect((await status({ cpuReserve: async () => on })).cpuReserve).toEqual(on);
    await close?.();
    expect((await status({ cpuReserve: async () => null })).cpuReserve).toBeNull();
    await close?.();
    expect((await status({})).cpuReserve).toBeNull();
  });
});
