// BOS-2672 (RCA-011): every state a wrap-up can be in, with the exact words the banner and the status box show, and the
// notice for every way it ends. The rules a fourth round would break: "no update was waiting" only when nothing is tied,
// and a runner time said at most once in the box.
import { describe, expect, it } from "vitest";
import { wrapUpEndWords, wrapUpWords, type WrapEnd, type WrapTieView } from "../src/wrap-up-words.js";

const at = (iso: string) => iso.slice(11, 16);
const T = (hhmm: string) => `2026-11-26T${hhmm}:00.000Z`;
const since = T("11:29");

const ROWS: { row: string; v: WrapTieView; banner: string; say: string; more: string }[] = [
  {
    row: "A: nothing approved, going in, on trial or queued",
    v: { since, liftsAt: T("12:29") },
    banner: "You asked agents to wrap up at 11:29. No update was approved, going in or queued, so this lifts by itself at 12:29, or press Cancel wrap-up on Settings → Server and runner. Waiting for 2 runs to finish.",
    say: "No update was waiting when you asked at 11:29. 2 agents are still finishing the step they are on.",
    more: "Lifts by itself at 12:29, or press Cancel wrap-up to restart work now.",
  },
  {
    row: "B: server update approved, waiting for a quiet machine",
    v: { since, server: { approvedAt: T("11:20"), stage: "approved" } },
    banner: "Wrapping up for the server update you approved at 11:20. It goes in once agents finish and the machine is quiet. This lifts by itself when it is live. Waiting for 2 runs to finish.",
    say: "Wrapping up for the server update you approved at 11:20. It goes in once agents finish and the machine is quiet. 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when it is live.",
  },
  {
    row: "C: server update going in",
    v: { since, server: { approvedAt: T("11:28"), stage: "going-in" } },
    banner: "Wrapping up for the server update you approved at 11:28: it is going in now. This lifts by itself when it is live. Waiting for 2 runs to finish.",
    say: "Wrapping up for the server update you approved at 11:28: it is going in now. 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when it is live.",
  },
  {
    row: "D: server update going in, runner update queued after it",
    v: { since, server: { approvedAt: T("11:28"), stage: "going-in" }, runner: { queuedAt: T("11:29"), stage: "queued", startsAt: T("11:47") } },
    banner: "Wrapping up for the server update you approved at 11:28 (going in now), then the runner update after its trial (about 11:47). This lifts by itself when both are in. Waiting for 2 runs to finish.",
    say: "Wrapping up for the server update you approved at 11:28 (going in now), then the runner update after its trial (about 11:47). 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when both are in.",
  },
  {
    row: "E: server live and on trial, runner update queued (26 Nov 11:45)",
    v: { since, server: { approvedAt: T("11:28"), stage: "live-trial", liveAt: T("11:32"), trialEndsAt: T("11:47") }, runner: { queuedAt: T("11:40"), stage: "queued", startsAt: T("11:47"), why: "the server update's 15-minute trial" } },
    banner: "Wrapping up for the runner update at 11:47, after the server update you approved at 11:28 (live since 11:32). This lifts by itself when the runners are updated. Waiting for 2 runs to finish.",
    say: "Wrapping up for the runner update at 11:47, after the server update you approved at 11:28 (live since 11:32). 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when the runners are updated.",
  },
  {
    row: "F: server live and on trial, nothing queued",
    v: { since, server: { approvedAt: T("11:28"), stage: "live-trial", liveAt: T("11:32"), trialEndsAt: T("11:47") } },
    banner: "Wrapping up while the server update you approved at 11:28 finishes its trial (ends 11:47). This lifts by itself then. Waiting for 2 runs to finish.",
    say: "Wrapping up while the server update you approved at 11:28 finishes its trial (ends 11:47). 2 agents are still finishing the step they are on.",
    more: "This lifts by itself then.",
  },
  {
    row: "G: runner image being built",
    v: { since, server: { approvedAt: T("11:28"), stage: "live-trial", liveAt: T("11:32") }, runner: { queuedAt: T("11:40"), stage: "building" } },
    banner: "Wrapping up for the runner update (after the server update you approved at 11:28): the new runner image is being built. This lifts by itself when the runners are updated. Waiting for 2 runs to finish.",
    say: "Wrapping up for the runner update (after the server update you approved at 11:28): the new runner image is being built. 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when the runners are updated.",
  },
  {
    row: "H: runners swapping (the drain took the wrap-up over)",
    v: { since, runner: { queuedAt: null, stage: "swapping" } },
    banner: "Wrapping up for the runner update: each runner is swapped as its company goes idle. This lifts by itself when the runners are updated. Waiting for 2 runs to finish.",
    say: "Wrapping up for the runner update: each runner is swapped as its company goes idle. 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when the runners are updated.",
  },
  {
    row: "I: runner update queued with no server update",
    v: { since, runner: { queuedAt: T("11:10"), stage: "queued", why: "a merge check to finish." } },
    banner: "Wrapping up for the runner update you queued at 11:10: it is waiting for a merge check to finish. This lifts by itself when the runners are updated. Waiting for 2 runs to finish.",
    say: "Wrapping up for the runner update you queued at 11:10: it is waiting for a merge check to finish. 2 agents are still finishing the step they are on.",
    more: "This lifts by itself when the runners are updated.",
  },
];

describe("wrapUpWords: one wording for the banner and the status box (BOS-2672)", () => {
  for (const r of ROWS)
    it(r.row, () => {
      expect(wrapUpWords(r.v, 2, at)).toEqual({ banner: r.banner, say: r.say, more: r.more });
    });

  it("says no update was waiting only when nothing is tied, and then names no update step", () => {
    for (const r of ROWS) {
      const w = wrapUpWords(r.v, 2, at);
      const all = `${w.banner} ${w.say} ${w.more}`;
      const tied = !!r.v.server || !!r.v.runner;
      expect(/no update was (waiting|approved)/i.test(all), r.row).toBe(!tied);
      if (!tied) expect(all).not.toMatch(/runner update|server update|Runners will/);
    }
  });

  it("names the runner time at most once in the status box", () => {
    for (const r of ROWS) {
      const w = wrapUpWords(r.v, 2, at);
      const box = `${w.say} ${w.more}`;
      expect(box.split("11:47").length - 1, r.row).toBeLessThanOrEqual(1);
    }
  });

  it("says every agent has finished when none is left", () => {
    expect(wrapUpWords(ROWS[2]!.v, 0, at)).toMatchObject({ say: "Wrapping up for the server update you approved at 11:28: it is going in now. Every agent has finished." });
    expect(wrapUpWords(ROWS[2]!.v, 0, at).banner).not.toContain("Waiting for");
  });
});

describe("wrapUpEndWords: the notice for every way a wrap-up ends (BOS-2672)", () => {
  const ENDS: { end: WrapEnd; title: string; body: string }[] = [
    { end: { how: "in", server: true, runner: true }, title: "Wrap-up over", body: "Wrap-up over: the server update and the runner update are in (11:52). Work has restarted." },
    { end: { how: "in", server: true, runner: false }, title: "Wrap-up over", body: "Wrap-up over: the server update is in (11:52). Work has restarted." },
    { end: { how: "failed", step: "server" }, title: "Wrap-up lifted: the server update failed", body: "The server update failed at 11:52; Boss Man is still on the earlier version. Work has restarted." },
    { end: { how: "failed", step: "server", switchedBack: true }, title: "Wrap-up lifted: the server update was switched back", body: "The server update was switched back at 11:52; Boss Man is still on the earlier version. Work has restarted." },
    { end: { how: "failed", step: "runner" }, title: "Wrap-up lifted: the runner update failed", body: "The runner update failed at 11:52; Boss Man is still on the earlier runner image. Work has restarted." },
    { end: { how: "cancelled", step: "server" }, title: "Wrap-up lifted: the server update was cancelled", body: "The server update was cancelled at 11:52. Work has restarted." },
    { end: { how: "cancelled", step: "runner", why: "The server update was switched back, so the runner update you queued was cancelled." }, title: "Wrap-up lifted: the runner update was cancelled", body: "The server update was switched back, so the runner update you queued was cancelled. Work has restarted." },
    { end: { how: "gave-up", step: "runner", didNot: "start", minutes: 45 }, title: "Wrap-up lifted: the runner update did not start", body: "The runner update it was tied to did not start within 45 minutes, so work has restarted." },
    { end: { how: "standalone" }, title: "Wrap-up lifted after 60 minutes", body: "No update was waiting for it, so new runs start again after 60 minutes. Agents that were still going finish on their own; any that ended cleanly are woken on their tickets." },
  ];
  for (const e of ENDS)
    it(`${e.end.how}${"step" in e.end ? ` (${e.end.step})` : ""}`, () => {
      expect(wrapUpEndWords(e.end, "11:52")).toEqual({ title: e.title, body: e.body });
    });

  it("says no update was waiting only for a wrap-up tied to nothing", () => {
    for (const e of ENDS) expect(/no update was waiting/i.test(wrapUpEndWords(e.end, "11:52").body)).toBe(e.end.how === "standalone");
  });
});

// BOS-2786 row J: Boss Man started the wrap-up itself for a runner update queued behind a trial. It says so, when it asks
// agents to finish (before and after that time), counts the checks the swap waits for, and asks the owner to press nothing.
describe("Boss Man's own wrap-up (BOS-2786, row J)", () => {
  const v: WrapTieView = {
    since: T("10:05"),
    by: "boss-man",
    tellAt: T("10:04"),
    server: { approvedAt: T("09:50"), stage: "live-trial", liveAt: T("09:59"), trialEndsAt: T("10:14") },
    runner: { queuedAt: T("10:05"), stage: "queued", startsAt: null, why: null },
  };

  it("before and after the ask, with runs and checks still finishing", () => {
    const before = wrapUpWords({ ...v, tellAt: T("10:08") }, 2, at, 1, Date.parse(T("10:06")));
    expect(before.banner).toBe("Runner update queued for 10:14, when the server update's trial ends. Boss Man is holding new work and checks since 10:05 and asks agents to finish at 10:08. It lifts by itself when the runners are updated, or if the update is switched back or cancelled. Nothing for you to press. Waiting for 2 runs and 1 check to finish.");
    expect(before.say).toBe("Runner update queued for 10:14, when the server update's trial ends. Boss Man is holding new work and checks since 10:05 and asks agents to finish at 10:08. 2 agents are still finishing the step they are on. 1 check still running.");
    const after = wrapUpWords(v, 0, at, 0, Date.parse(T("10:06")));
    expect(after.say).toBe("Runner update queued for 10:14, when the server update's trial ends. Boss Man is holding new work and checks since 10:05 and asked agents to finish at 10:04. Every agent has finished.");
    expect(after.banner).not.toMatch(/press Cancel|you asked/i);
  });

  it("once the runner update is building or swapping, the usual rows apply", () => {
    expect(wrapUpWords({ ...v, runner: { ...v.runner!, stage: "building" } }, 0, at).say).toMatch(/^Wrapping up for the runner update/);
  });

  it("the owner's own wrap-up keeps its words when checks are counted", () => {
    expect(wrapUpWords({ since }, 0, at, 2).say).toBe("No update was waiting when you asked at 11:29. Every agent has finished; 2 checks still running.");
  });
});
