// BOS-1619: the pure helpers of the soft hold a waiting server update puts on new work (BOS-1634).
// They decide the quiet-run limit from the environment, the owner's words for why the hold is on, and
// the limit as saved beside the limit in force. No database or network here: softHold() itself is left alone.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUIET_RUNS,
  DEPLOY_WAIT_KEY,
  SOFT_HOLD_MAX_MS,
  limitUnderHold,
  quietRuns,
  softHoldReason,
  type SoftHold,
} from "../src/services/deploy-wait-hold.js";

const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { DEPLOY_QUIET_RUNS: value });
const hold = (phase: string, approvedAt = "2026-11-16T10:00:00.000Z"): Extract<SoftHold, { on: true }> => ({
  on: true,
  phase,
  maxRuns: 3,
  approvedAt,
});

describe("quietRuns", () => {
  it("defaults to 3 when the environment says nothing", () => {
    expect(DEFAULT_QUIET_RUNS).toBe(3);
    expect(quietRuns(env())).toBe(3);
  });

  it("takes a whole number in range, including both ends", () => {
    expect(quietRuns(env("0"))).toBe(0);
    expect(quietRuns(env("7"))).toBe(7);
    expect(quietRuns(env("100"))).toBe(100);
  });

  it("falls back to the default for a number outside 0 to 100", () => {
    expect(quietRuns(env("-1"))).toBe(DEFAULT_QUIET_RUNS);
    expect(quietRuns(env("101"))).toBe(DEFAULT_QUIET_RUNS);
  });

  it("falls back to the default for a value that isn't a whole number", () => {
    expect(quietRuns(env("2.5"))).toBe(DEFAULT_QUIET_RUNS);
    expect(quietRuns(env("three"))).toBe(DEFAULT_QUIET_RUNS);
    expect(quietRuns(env("NaN"))).toBe(DEFAULT_QUIET_RUNS);
  });
});

describe("softHoldReason", () => {
  it("says the update is waiting for a quiet machine, since it was approved and until the 3-hour cap", () => {
    expect(softHoldReason(hold("waiting"))).toEqual({
      because: "a server update is waiting for a quiet machine",
      since: "2026-11-16T10:00:00.000Z",
      until: "2026-11-16T13:00:00.000Z",
    });
    expect(SOFT_HOLD_MAX_MS).toBe(3 * 60 * 60_000);
  });

  it("says the update is being applied", () => {
    expect(softHoldReason(hold("sent")).because).toBe("a server update is being applied");
  });

  it("says a live update still has the old server on standby for any other phase", () => {
    expect(softHoldReason(hold("standby")).because).toBe("a server update has just gone live and the old server is still on standby");
  });

  it("keeps the approval time as the start, whatever the phase", () => {
    const at = "2026-11-16T23:30:00.000Z";
    expect(softHoldReason(hold("sent", at)).since).toBe(at);
    expect(softHoldReason(hold("sent", at)).until).toBe("2026-11-17T02:30:00.000Z");
  });
});

describe("limitUnderHold", () => {
  const off: SoftHold = { on: false };

  it("leaves the saved limit alone when no hold is on", () => {
    expect(limitUnderHold(16, off, 3)).toEqual({ saved: 16, inForce: 16, because: null, since: null, until: null });
  });

  it("lowers the limit to the cap while a hold is on, with the reason and its window", () => {
    expect(limitUnderHold(16, hold("waiting"), 3)).toEqual({
      saved: 16,
      inForce: 3,
      because: "a server update is waiting for a quiet machine",
      since: "2026-11-16T10:00:00.000Z",
      until: "2026-11-16T13:00:00.000Z",
    });
  });

  it("can hold background work at zero", () => {
    expect(limitUnderHold(12, hold("sent"), 0)).toMatchObject({ saved: 12, inForce: 0, because: "a server update is being applied" });
  });

  it("reports no reason when the hold's cap isn't lower than the saved limit", () => {
    expect(limitUnderHold(16, hold("waiting"), 16)).toEqual({ saved: 16, inForce: 16, because: null, since: null, until: null });
    expect(limitUnderHold(16, hold("waiting"), 20)).toEqual({ saved: 16, inForce: 16, because: null, since: null, until: null });
  });

  it("names the key the hold row is read by", () => {
    expect(DEPLOY_WAIT_KEY).toBe("deploy_wait");
  });
});
