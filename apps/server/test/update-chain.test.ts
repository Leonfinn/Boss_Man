// BOS-2672 (RCA-011): the update chain a wrap-up is tied to, pressed in every stage, and every way it ends. Pure (no
// database): chainFrom reads the records, stepTie is the one table of joins and ends.
import { describe, expect, it } from "vitest";
import type { DeployWait } from "../src/services/deploy-wait.js";
import { autoWrapDue, autoWrapStuck, chainFrom, EMPTY_CHAIN, forUpdateOf, RUNNER_GONE_GRACE_MS, stepTie, tieView, WAIT_STAGE_TO_WRAP, type ChainInput, type UpdateChain, type WrapTie } from "../src/services/update-chain.js";
import { WAIT_RULES } from "../src/services/update-waits.js";

const T = (hhmm: string, s = 0) => new Date(`2026-11-26T${hhmm}:${String(s).padStart(2, "0")}.000Z`);
const ID = "11111111-2222-3333-4444-555555555555";
const OPTS = { buildMaxMin: 45 };
const wait = (phase: DeployWait["phase"], extra: Partial<DeployWait> = {}): DeployWait => ({ decisionId: ID, commit: "b".repeat(40), fromCommit: "a".repeat(40), approvedAt: T("11:28").toISOString(), phase, deadline: T("11:58").toISOString(), minutes: 30, origin: "approve", ...extra });
const input = (i: Partial<ChainInput> = {}): ChainInput => ({ wait: null, trialEndsAt: null, runnerQueued: null, runnerUnderWay: false, last: null, queueCancelled: null, tiedServerEnd: null, ...i });
const chain = (i: Partial<ChainInput> = {}) => chainFrom(input(i));
/** Runs stepTie over a list of (time, chain) passes from a press, and answers the tie and end after each. */
function passes(steps: [Date, UpdateChain, { building?: boolean }?][], start: WrapTie = {}) {
  let tie = start;
  const out: ReturnType<typeof stepTie>[] = [];
  for (const [t, c, o] of steps) {
    const r = stepTie(tie, c, t, { ...OPTS, ...o });
    out.push(r);
    tie = r.tie;
    if (r.end) break;
  }
  return out;
}

describe("chainFrom: the chain from the records Boss Man keeps", () => {
  it("names the server stage for every deploy-wait phase", () => {
    expect(chain({ wait: wait("waiting") }).server?.stage).toBe("approved");
    expect(chain({ wait: wait("sent") }).server?.stage).toBe("going-in");
    expect(chain({ wait: wait("window", { windowUntil: T("11:47").toISOString() }) }).server).toMatchObject({ stage: "live-trial", trialEndsAt: T("11:47").toISOString() });
    expect(chain({ wait: wait("handover") }).server?.stage).toBe("handover");
  });
  it("a trial with no deploy wait behind it is a server step too", () => {
    expect(chain({ trialEndsAt: T("11:47").toISOString() }).server).toEqual({ decisionId: null, approvedAt: null, stage: "live-trial", trialEndsAt: T("11:47").toISOString() });
  });
  it("a queued press, the combined button, and a runner request with the host are the runner step", () => {
    expect(chain({ runnerQueued: { pressedAt: T("11:40").toISOString(), startsAt: T("11:47").toISOString(), why: "the trial" } }).runner).toMatchObject({ stage: "queued", startsAt: T("11:47").toISOString() });
    expect(chain({ wait: wait("sent", { thenRunners: true }) }).runner).toMatchObject({ stage: "queued" });
    expect(chain({ runnerUnderWay: true }).runner).toMatchObject({ stage: "building" });
  });
  it("nothing under way is no step", () => {
    expect(chain()).toEqual(EMPTY_CHAIN);
  });
});

describe("stepTie: pressed in every stage, the wrap-up is tied to it", () => {
  const press = (c: UpdateChain) => stepTie({}, c, T("11:29", 28), OPTS);
  it("nothing under way: tied to nothing", () => {
    expect(press(chain())).toEqual({ tie: {}, end: null });
    expect(forUpdateOf(press(chain()).tie)).toBe("none");
  });
  for (const phase of ["waiting", "sent", "window", "handover"] as const)
    it(`server ${phase}: tied to the server update`, () => {
      const r = press(chain({ wait: wait(phase) }));
      expect(r.end).toBeNull();
      expect(r.tie.server).toMatchObject({ decisionId: ID, joinedLive: phase === "window" || phase === "handover" });
      expect(forUpdateOf(r.tie)).toBe("server");
    });
  it("server going in with a runner update queued: tied to both", () => {
    const r = press(chain({ wait: wait("sent"), runnerQueued: { pressedAt: T("11:29").toISOString(), startsAt: null, why: "the server update" } }));
    expect(r.tie.server?.stage).toBe("going-in");
    expect(r.tie.runner?.stage).toBe("queued");
    expect(forUpdateOf(r.tie)).toBe("runner");
  });
  it("runner queued alone, and a runner build under way: tied to the runner update", () => {
    expect(press(chain({ runnerQueued: { pressedAt: T("11:10").toISOString(), startsAt: null, why: "a merge check" } })).tie.runner?.stage).toBe("queued");
    expect(press(chain({ runnerUnderWay: true })).tie.runner).toMatchObject({ stage: "building", buildingSince: T("11:29", 28).toISOString() });
  });
});

describe("stepTie: steps that start later join, and the wrap-up ends by itself", () => {
  it("pressed first, then approved: the server step joins and the wrap-up lifts when it is live", () => {
    const r = passes([
      [T("11:29"), chain()],
      [T("11:30"), chain({ wait: wait("waiting") })],
      [T("11:31"), chain({ wait: wait("sent") })],
      [T("11:32"), chain({ wait: wait("window", { windowUntil: T("11:47").toISOString() }) })],
    ]);
    expect(r.map((x) => x.end)).toEqual([null, null, null, { how: "in", server: true, runner: false }]);
  });
  it("tied to a server update going in, with nothing queued: lifts when it goes live, not when it is sent", () => {
    const r = passes([
      [T("11:29"), chain({ wait: wait("waiting") })],
      [T("11:30"), chain({ wait: wait("sent") })],
      [T("11:31"), chain({ wait: wait("sent") })],
      [T("11:32"), chain({ wait: wait("window") })],
    ]);
    expect(r.map((x) => x.end?.how ?? null)).toEqual([null, null, null, "in"]);
  });
  it("a single server with no trial: in once the host reports it deployed", () => {
    const r = passes([
      [T("11:29"), chain({ wait: wait("sent") })],
      [T("11:32"), chain({ last: { id: ID, target: "server", result: "deployed", ended: T("11:32").toISOString() } })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "in", server: true, runner: false });
  });
  it("pressed during the trial with nothing queued (row F): lifts when the trial ends", () => {
    const r = passes([
      [T("11:35"), chain({ wait: wait("window") })],
      [T("11:40"), chain({ wait: wait("window") })],
      [T("11:47"), chain()],
    ]);
    expect(r.map((x) => x.end?.how ?? null)).toEqual([null, null, "in"]);
  });
  it("with a runner update queued, the server going live does not lift it: the runner drain does", () => {
    const queued = { pressedAt: T("11:30").toISOString(), startsAt: T("11:47").toISOString(), why: "the trial" };
    const r = passes([
      [T("11:29"), chain({ wait: wait("sent") })],
      [T("11:30"), chain({ wait: wait("sent"), runnerQueued: queued })],
      [T("11:32"), chain({ wait: wait("window"), runnerQueued: queued })],
      [T("11:47"), chain({ runnerUnderWay: true })],
      [T("11:50"), chain({ runnerUnderWay: true }), { building: true }],
    ]);
    expect(r.map((x) => x.end)).toEqual([null, null, null, null, null]);
    expect(r.at(-1)!.tie.server?.doneAt).toBe(T("11:47").toISOString());
    expect(r.at(-1)!.tie.runner).toMatchObject({ stage: "building" });
  });
  it("a runner report of deployed after the tie ends it as in", () => {
    const r = passes([
      [T("11:29"), chain({ runnerUnderWay: true })],
      [T("11:55"), chain({ last: { id: "r", target: "runner", result: "deployed", ended: T("11:55").toISOString() } })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "in", server: false, runner: true });
  });
});

describe("stepTie: a step that fails, is cancelled or gives up lifts the wrap-up at once", () => {
  it("the server update failed", () => {
    const r = passes([
      [T("11:29"), chain({ wait: wait("sent") })],
      [T("11:31"), chain({ last: { id: ID, target: "server", result: "failed", ended: T("11:31").toISOString() } })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "failed", step: "server", switchedBack: false });
  });
  it("switched back in its trial, even with a runner update queued", () => {
    const r = passes([
      [T("11:29"), chain({ wait: wait("window"), runnerQueued: { pressedAt: T("11:29").toISOString(), startsAt: null, why: null } })],
      [T("11:40"), chain({ wait: wait("window"), last: { id: ID, target: "server", result: "rolled_back", ended: T("11:40").toISOString() } })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "failed", step: "server", switchedBack: true });
  });
  it("a trial with no deploy wait that was switched back", () => {
    const r = passes([
      [T("11:35"), chain({ trialEndsAt: T("11:47").toISOString() })],
      [T("11:40"), chain({ last: { id: "x", target: "server", result: "rolled_back", ended: T("11:40").toISOString() } })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "failed", step: "server", switchedBack: true });
  });
  it("the server update was cancelled before it went out", () => {
    const r = passes([
      [T("11:29"), chain({ wait: wait("waiting") })],
      [T("11:30"), chain({ tiedServerEnd: "cancelled" })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "cancelled", step: "server" });
  });
  it("the server update gave up (not sent: memory short; or ended with no record)", () => {
    expect(passes([[T("11:29"), chain({ wait: wait("waiting") })], [T("12:29"), chain({ tiedServerEnd: "not_sent" })]]).at(-1)!.end).toMatchObject({ how: "gave-up", step: "server" });
    expect(passes([[T("11:29"), chain({ wait: wait("sent") })], [T("12:15"), chain()]]).at(-1)!.end).toEqual({ how: "gave-up", step: "server", didNot: "go in" });
  });
  it("the runner build failed (the host's report)", () => {
    const r = passes([
      [T("11:29"), chain({ runnerUnderWay: true })],
      [T("11:40"), chain({ last: { id: "r", target: "runner", result: "failed", ended: T("11:40").toISOString() } })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "failed", step: "runner", switchedBack: false });
  });
  it("a runner failure reported before the press is not this update's", () => {
    const r = passes([[T("11:29"), chain({ runnerUnderWay: true, last: { id: "r", target: "runner", result: "failed", ended: T("10:00").toISOString() } })]]);
    expect(r[0]!.end).toBeNull();
  });
  it("the queued runner update was cancelled: lifts after the grace, with the reason when Boss Man gave one", () => {
    const queued = { pressedAt: T("11:29").toISOString(), startsAt: null, why: null };
    const cancelled = { at: T("11:31").toISOString(), why: "The server update was switched back, so the runner update you queued was cancelled." };
    const r = passes([
      [T("11:29"), chain({ runnerQueued: queued })],
      [T("11:31"), chain({ queueCancelled: cancelled })],
      [new Date(T("11:31").getTime() + RUNNER_GONE_GRACE_MS - 1000), chain({ queueCancelled: cancelled })],
      [new Date(T("11:31").getTime() + RUNNER_GONE_GRACE_MS), chain({ queueCancelled: cancelled })],
    ]);
    expect(r.map((x) => x.end)).toEqual([null, null, null, { how: "cancelled", step: "runner", why: cancelled.why }]);
  });
  it("a queued press that went to the host within the grace is not cancelled", () => {
    const queued = { pressedAt: T("11:29").toISOString(), startsAt: null, why: null };
    const r = passes([
      [T("11:29"), chain({ runnerQueued: queued })],
      [T("11:47", 0), chain()],
      [T("11:47", 30), chain({ runnerUnderWay: true })],
      [T("11:50"), chain()],
    ]);
    expect(r.map((x) => x.end)).toEqual([null, null, null, null]);
    expect(r.at(-1)!.tie.runner).toMatchObject({ stage: "building" });
    expect(r.at(-1)!.tie.runner?.goneSince).toBeUndefined();
  });
  it("a runner build that never reached a drain gives up after the build's own limit", () => {
    const r = passes([
      [T("11:29"), chain(), { building: true }],
      [T("12:14"), chain()],
      [T("12:15"), chain()],
    ]);
    expect(r.map((x) => x.end)).toEqual([null, null, { how: "gave-up", step: "runner", didNot: "start", minutes: 45 }]);
  });
  it("a queued runner update that never starts gives up at the runner-queued end", () => {
    const queued = { pressedAt: T("09:00").toISOString(), startsAt: null, why: null };
    const end = WAIT_RULES["runner-queued"].endMin;
    const r = passes([
      [T("09:00"), chain({ runnerQueued: queued })],
      [new Date(T("09:00").getTime() + end * 60_000 + 1000), chain({ runnerQueued: queued })],
    ]);
    expect(r.at(-1)!.end).toEqual({ how: "gave-up", step: "runner", didNot: "start", minutes: end });
  });
});

describe("the 26 Nov replay (the third report)", () => {
  // Approved 11:28, sent at once; wrap-up 11:29:28; live 11:31:55; trial to 11:47; runner pressed during the build.
  const sent = chain({ wait: wait("sent") });
  const queued = { pressedAt: T("11:30").toISOString(), startsAt: T("11:47").toISOString(), why: "the server update's 15-minute trial" };
  it("the press is tied to the server update going in (it was 'none' before BOS-2672)", () => {
    expect(forUpdateOf(stepTie({}, sent, T("11:29", 28), OPTS).tie)).toBe("server");
  });
  it("at 11:45 the screen names the runner update at 11:47 after the server update, and the wrap-up is still on", () => {
    const r = passes([
      [T("11:29", 28), sent],
      [T("11:30"), chain({ wait: wait("sent"), runnerQueued: queued })],
      [T("11:31", 55), chain({ wait: wait("window", { windowUntil: T("11:47").toISOString() }), runnerQueued: queued })],
      [T("11:45"), chain({ wait: wait("window", { windowUntil: T("11:47").toISOString() }), runnerQueued: queued })],
    ]);
    expect(r.at(-1)!.end).toBeNull();
    const v = tieView(r.at(-1)!.tie, T("11:29", 28).toISOString());
    expect(v).toMatchObject({ server: { stage: "live-trial", liveAt: T("11:31", 55).toISOString(), trialEndsAt: T("11:47").toISOString() }, runner: { stage: "queued", startsAt: T("11:47").toISOString() } });
    expect(v.liftsAt).toBeUndefined();
  });
});

describe("tieView", () => {
  it("tied to nothing: carries when it lifts", () => {
    expect(tieView({}, T("11:29").toISOString(), { liftsAt: T("12:29").toISOString() })).toEqual({ since: T("11:29").toISOString(), liftsAt: T("12:29").toISOString() });
  });
  it("taken over by the drain: the runner is swapping and the server update is still named", () => {
    const tie: WrapTie = { server: { decisionId: ID, approvedAt: T("11:28").toISOString(), stage: "live-trial", trialEndsAt: null, joinedAt: T("11:29").toISOString(), joinedLive: false, liveAt: T("11:32").toISOString(), doneAt: T("11:47").toISOString() } };
    expect(tieView(tie, T("11:29").toISOString(), { swapping: true })).toMatchObject({ server: { approvedAt: T("11:28").toISOString() }, runner: { stage: "swapping" } });
  });
});

// A fifth round can't come from a new update stage: every server and runner wait in WAIT_RULES says what a wrap-up
// pressed in it is tied to and how the screen words it.
describe("every update stage has a wrap-up stage", () => {
  it("WAIT_RULES and WAIT_STAGE_TO_WRAP list the same stages", () => {
    const stages = Object.keys(WAIT_RULES).filter((k) => k !== "wrapup").sort();
    expect(Object.keys(WAIT_STAGE_TO_WRAP).sort()).toEqual(stages);
    for (const k of stages) {
      const m = WAIT_STAGE_TO_WRAP[k as keyof typeof WAIT_STAGE_TO_WRAP];
      expect(WAIT_RULES[k as keyof typeof WAIT_RULES].forUpdate === "server" ? !!m.server : !!m.runner, k).toBe(true);
    }
  });
});

// BOS-2786: when Boss Man starts its own wrap-up for a runner update queued behind a trial, and when it gives up.
describe("autoWrapDue and autoWrapStuck (BOS-2786)", () => {
  const LEAD = { offFor: null, leadMin: 10 };
  const queued = (startsAt: string | null) => ({ pressedAt: T("10:05").toISOString(), startsAt, why: "the server update's 15-minute trial" });
  const onTrial = (end: string) => chain({ wait: wait("window", { windowUntil: end }), trialEndsAt: end, runnerQueued: queued(end) });

  it("queued behind a trial ending in the future: due now, agents asked the lead time before its end", () => {
    expect(autoWrapDue(onTrial(T("10:14").toISOString()), T("10:00"), LEAD)).toEqual({ queuedAt: T("10:05").toISOString(), startsAt: T("10:14").toISOString(), tellAt: T("10:04").toISOString() });
  });

  it("less than the lead time left: agents are asked at once", () => {
    expect(autoWrapDue(onTrial(T("10:14").toISOString()), T("10:08"), LEAD)?.tellAt).toBe(T("10:08").toISOString());
  });

  it("the press has no start time of its own: the live trial's end is used", () => {
    const c = chain({ wait: wait("window", { windowUntil: T("10:14").toISOString() }), runnerQueued: queued(null) });
    expect(autoWrapDue(c, T("10:00"), LEAD)?.startsAt).toBe(T("10:14").toISOString());
  });

  it("nothing is due: no press, a press with the host, a trial over, no trial at all, or the owner cancelled it for this press", () => {
    expect(autoWrapDue(chain({ wait: wait("window", { windowUntil: T("10:14").toISOString() }) }), T("10:00"), LEAD)).toBeNull();
    expect(autoWrapDue(chain({ runnerUnderWay: true, runnerQueued: queued(T("10:14").toISOString()) }), T("10:00"), LEAD)).toBeNull();
    expect(autoWrapDue(onTrial(T("10:14").toISOString()), T("10:15"), LEAD)).toBeNull();
    expect(autoWrapDue(chain({ runnerQueued: queued(null) }), T("10:00"), LEAD)).toBeNull();
    expect(autoWrapDue(chain({ wait: wait("sent", { thenRunners: true }) }), T("10:00"), LEAD)).toBeNull();
    expect(autoWrapDue(onTrial(T("10:14").toISOString()), T("10:00"), { offFor: T("10:05").toISOString(), leadMin: 10 })).toBeNull();
  });

  it("gives up only while the press is still queued past the trial's end plus the grace", () => {
    const auto = { queuedAt: null, startsAt: T("10:14").toISOString(), tellAt: T("10:04").toISOString() };
    const tie: WrapTie = { runner: { queuedAt: null, stage: "queued", startsAt: T("10:14").toISOString(), why: null, joinedAt: T("10:00").toISOString() } };
    expect(autoWrapStuck(tie, auto, T("10:23"), 10)).toBe(false);
    expect(autoWrapStuck(tie, auto, T("10:25"), 10)).toBe(true);
    expect(autoWrapStuck({ runner: { ...tie.runner!, stage: "building", buildingSince: T("10:16").toISOString() } }, auto, T("10:40"), 10)).toBe(false);
    expect(autoWrapStuck({}, auto, T("10:40"), 10)).toBe(false);
  });

  it("tieView says Boss Man started it, with its time, only when asked to", () => {
    const tie: WrapTie = { runner: { queuedAt: null, stage: "queued", startsAt: T("10:14").toISOString(), why: null, joinedAt: T("10:00").toISOString() } };
    expect(tieView(tie, T("10:00").toISOString(), { auto: { tellAt: T("10:04").toISOString() } })).toMatchObject({ by: "boss-man", tellAt: T("10:04").toISOString() });
    expect(tieView(tie, T("10:00").toISOString()).by).toBeUndefined();
  });
});
