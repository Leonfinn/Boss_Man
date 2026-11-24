import { describe, expect, it } from "vitest";
import { atTime, checkSentence, drainTiming, deployerLine, historyWhat, inAbout, isReplaced, runsSentence, waitCancelLabel, waitLine, wrapUpFor, type DeployWaitView, type HistoryRow, type RunnerCheckView, type SelfDeployView, type WrapUpRun } from "../src/pages/settings/updates";
import { when } from "../src/pages/Runs";

// BOS-1846: the sentences the owner reads in Settings → Updates, pinned with a fixed clock. Clock times are built
// with the page's own formatters so the pins hold in any time zone and language.

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();
const hhmm = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

describe("drainTiming (BOS-1877)", () => {
  it("says when it started and when it should end; overdue says so plainly; swapping and an old server differ", () => {
    expect(drainTiming({ runs: 0, since: iso(-30), phase: "waiting", expectedFinishAt: iso(20) })).toBe(`Started ${hhmm(iso(-30))}. Expected to finish about ${hhmm(iso(20))}.`);
    expect(drainTiming({ runs: 0, since: iso(-30), phase: "waiting", expectedFinishAt: null, overdue: true })).toBe(`Started ${hhmm(iso(-30))}. This is taking longer than expected.`);
    expect(drainTiming({ runs: 2, since: iso(-5), phase: "waiting", expectedFinishAt: null })).toMatch(/No time estimate/);
    // BOS-2531: "being swapped now" only while a runner is really being recreated (chatOpen false), with a back-by time.
    expect(drainTiming({ runs: 0, phase: "swapping", chatOpen: false, chatBackBy: iso(2) })).toBe(`Back by ${hhmm(iso(2))} at the latest.`);
    expect(drainTiming({ runs: 0, phase: "swapping", chatOpen: true, chatBackBy: null })).toBe("The runners are swapped next.");
    expect(drainTiming({ runs: 0 })).toBe("");
  });
});

describe("atTime", () => {
  it("is the reader's clock time", () => {
    expect(atTime(iso(0))).toBe(hhmm(iso(0)));
    expect(atTime(iso(0))).toMatch(/\d{1,2}[:.]\d{2}/);
  });
});

describe("inAbout", () => {
  it("says now for the present and the past", () => {
    expect(inAbout(iso(0), NOW)).toBe("now");
    expect(inAbout(iso(-5), NOW)).toBe("now");
  });
  it("one minute is singular, and a few seconds round up to it", () => {
    expect(inAbout(iso(1), NOW)).toBe("in about 1 minute");
    expect(inAbout(new Date(NOW + 5_000).toISOString(), NOW)).toBe("in about 1 minute");
  });
  it("many minutes", () => {
    expect(inAbout(iso(6), NOW)).toBe("in about 6 minutes");
    expect(inAbout(new Date(NOW + 6 * 60_000 + 1000).toISOString(), NOW)).toBe("in about 7 minutes");
  });
});

describe("checkSentence", () => {
  const c = (over: Partial<RunnerCheckView> = {}): RunnerCheckView => ({ ticket: "BOS-1525", kind: "merge", scope: "quick", startedAt: iso(-10), runningForMinutes: 10, usuallyMinutes: 15, ...over });
  it("a merge check with start and usual time", () => {
    expect(checkSentence(c())).toBe(`BOS-1525 merge check, started ${hhmm(iso(-10))}, usually about 15 min`);
  });
  it("a quick check and a plain check", () => {
    expect(checkSentence(c({ kind: "request", scope: "quick", usuallyMinutes: null }))).toBe(`BOS-1525 quick check, started ${hhmm(iso(-10))}`);
    expect(checkSentence(c({ kind: "request", scope: "full", startedAt: null, usuallyMinutes: 40 }))).toBe("BOS-1525 check, usually about 40 min");
  });
  it("unknown ticket, start and usual time", () => {
    expect(checkSentence(c({ ticket: null, startedAt: null, usuallyMinutes: null }))).toBe("A merge check");
  });
});

describe("waitLine", () => {
  const w = (over: Partial<Extract<DeployWaitView, { on: true }>> = {}) => ({ on: true as const, phase: "waiting" as const, origin: "approve" as const, commit: "0123456789abcdef", deadline: iso(30), ...over });
  const held = " Meanwhile new merge checks wait and fewer runs start.";
  it("approved update waiting for a quiet machine, with memory", () => {
    const quiet = { ready: false, runs: 1, checks: 0, freeMb: 2048, needMb: 6656, why: ["1 run is going", "a check is running"] };
    expect(waitLine(w({ quiet }))).toBe(`The update to 01234567 is waiting for a quiet machine: 1 run is going; a check is running. 2.0 GB free of the 6.5 GB it needs. You'll be asked at ${when(iso(30))} if it is still waiting.${held}`);
  });
  it("says checking when there is no reason yet", () => {
    expect(waitLine(w())).toBe(`The update to 01234567 is waiting for a quiet machine: checking. You'll be asked at ${when(iso(30))} if it is still waiting.${held}`);
  });
  it("by hand: making room, then ready", () => {
    expect(waitLine(w({ origin: "hand", quiet: { ready: false, runs: 0, checks: 1, freeMb: null, needMb: null, why: ["a check is running"] } }))).toBe(`Making room before you apply the update to 01234567 by hand: a check is running.${held}`);
    expect(waitLine(w({ origin: "hand", quiet: { ready: true, runs: 0, checks: 0, freeMb: null, needMb: null, why: [] } }))).toBe(`Ready: the machine is quiet. Apply the update to 01234567 by hand now.${held}`);
  });
  it("sent, window and handover", () => {
    expect(waitLine(w({ phase: "sent" }))).toBe(`The update to 01234567 has gone to the machine.${held}`);
    expect(waitLine(w({ phase: "window", windowUntil: iso(10) }))).toBe(`The update is live; its standby window runs until ${when(iso(10))}.${held}`);
    expect(waitLine(w({ phase: "window" }))).toContain(`until ${when(iso(30))}`);
    expect(waitLine(w({ phase: "handover" }))).toBe(`The update is live; waiting for the runner update to start.${held}`);
  });
});

describe("runsSentence", () => {
  const r = (agent: string | null, ticket: string | null): WrapUpRun => ({ runId: "r", agent, ticket, ticketTitle: null, runningForMinutes: 1, sinceWrapUpMinutes: 0, waitingOn: null });
  it("none, one, two, three", () => {
    expect(runsSentence([])).toBe("");
    expect(runsSentence([r("Parsley - Web Developer", "BOS-1238")])).toBe("Parsley (BOS-1238)");
    expect(runsSentence([r("Parsley - Web Developer", "BOS-1238"), r("Dougal - Infra", "BOS-5")])).toBe("Parsley (BOS-1238) and Dougal (BOS-5)");
    expect(runsSentence([r("A", null), r("B", "BOS-2"), r("C", "BOS-3")])).toBe("A, B (BOS-2) and C (BOS-3)");
  });
  it("an unnamed agent reads An agent", () => {
    expect(runsSentence([r(null, null)])).toBe("An agent");
  });
});

describe("deployerLine", () => {
  const v = (deployer?: SelfDeployView["deployer"], lateAfterMinutes?: number) => ({ enabled: true, pending: false, status: null, available: null, deployer, lateAfterMinutes }) as SelfDeployView;
  it("not reported yet: older server, or no report time", () => {
    expect(deployerLine(v())).toBe("The host deployer has not reported yet.");
    expect(deployerLine(v({ reportedAt: null, late: false }))).toBe("The host deployer has not reported yet. Check that its cron job is running.");
  });
  it("late, with the default and a set limit", () => {
    expect(deployerLine(v({ reportedAt: iso(-20), late: true }))).toBe(`The host deployer last reported ${when(iso(-20))}, more than 10 minutes ago; it should report every minute. Check that its cron job is running.`);
    expect(deployerLine(v({ reportedAt: iso(-20), late: true }, 5))).toContain("more than 5 minutes ago");
  });
  it("on time", () => {
    expect(deployerLine(v({ reportedAt: iso(-1), late: false }))).toBe(`The host deployer last reported ${when(iso(-1))}. It is reading main again and shows what is waiting within a few minutes.`);
  });
});

// BOS-1985: the labels on the waiting-update button, the "replaced" check, and the Recent updates line.

describe("waitCancelLabel", () => {
  const w = (over: Partial<Extract<DeployWaitView, { on: true }>> = {}) => ({ on: true as const, phase: "waiting" as const, origin: "approve" as const, commit: "0123456789abcdef", deadline: iso(30), ...over });
  it("by hand while making room says Stop making room", () => {
    expect(waitCancelLabel(w({ origin: "hand" }))).toBe("Stop making room");
  });
  it("an approved update waiting, or one already sent, says Cancel the update", () => {
    expect(waitCancelLabel(w())).toBe("Cancel the update");
    expect(waitCancelLabel(w({ phase: "sent" }))).toBe("Cancel the update");
  });
  it("an update that is live in its window or handover says Lift the hold now", () => {
    expect(waitCancelLabel(w({ phase: "window" }))).toBe("Lift the hold now");
    expect(waitCancelLabel(w({ phase: "handover" }))).toBe("Lift the hold now");
  });
});

describe("isReplaced", () => {
  it("matches the stale-on-main message, whatever its case", () => {
    expect(isReplaced("Commit abc123 is not on main any more")).toBe(true);
    expect(isReplaced("COMMIT ABC123 IS NOT ON MAIN ANY MORE")).toBe(true);
  });
  it("is false for another message, null and undefined", () => {
    expect(isReplaced("the build failed")).toBe(false);
    expect(isReplaced(null)).toBe(false);
    expect(isReplaced(undefined)).toBe(false);
  });
});

describe("historyWhat", () => {
  const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({ id: "h", target: "server", commit: "0123456789abcdef", changes: 0, result: "deployed", message: null, at: iso(0), ...over });
  it("a runner row names every company", () => {
    expect(historyWhat(row({ target: "runner" }))).toBe("Runners, all companies");
  });
  it("a rejected server row replaced by a newer update says it was not sent", () => {
    expect(historyWhat(row({ result: "rejected", message: "Commit abc123 is not on main any more" }))).toBe("Server: not sent, a newer update replaced it");
  });
  it("a server row counts its changes, singular and plural", () => {
    expect(historyWhat(row({ changes: 1 }))).toBe("Server, 1 change");
    expect(historyWhat(row({ changes: 3 }))).toBe("Server, 3 changes");
  });
  it("a server row with no changes is just Server", () => {
    expect(historyWhat(row({ changes: 0 }))).toBe("Server");
    // BOS-2549: the real count, and what is cut from the list; a replaced row names its successor.
    expect(historyWhat(row({ changes: 38, shown: 20 }))).toBe("Server, 38 changes (showing 20 of 38)");
    expect(historyWhat(row({ changes: 3, shown: 3 }))).toBe("Server, 3 changes");
    expect(historyWhat(row({ changes: 4, result: "replaced", replacedBy: "a63be888" }))).toBe("Server, 4 changes: replaced by a newer update (a63be888)");
  });
});

describe("wrapUpFor (BOS-2056)", () => {
  it("an explicit answer wins over the kind", () => {
    expect(wrapUpFor({ kind: "wrapup", wrapForUpdate: "server" })).toEqual({ forUpdate: "server", at: null });
    expect(wrapUpFor({ kind: "update", wrapForUpdate: "runner" })).toEqual({ forUpdate: "runner", at: null });
    expect(wrapUpFor({ kind: "update", wrapForUpdate: "none" })).toEqual({ forUpdate: "none", at: null });
  });
  it("a plain wrap-up is for no update; a hold that joined an update is for the runner update", () => {
    expect(wrapUpFor({ kind: "wrapup" })).toEqual({ forUpdate: "none", at: null });
    expect(wrapUpFor({ kind: "update" })).toEqual({ forUpdate: "runner", at: null });
    expect(wrapUpFor({})).toEqual({ forUpdate: "runner", at: null });
  });
  it("names when it was asked: wrapSince first, then since, then null", () => {
    expect(wrapUpFor({ kind: "update", wrapSince: iso(0), since: iso(-5) })).toEqual({ forUpdate: "runner", at: iso(0) });
    expect(wrapUpFor({ kind: "wrapup", since: iso(-5) })).toEqual({ forUpdate: "none", at: iso(-5) });
    expect(wrapUpFor({ kind: "update", wrapSince: undefined, since: undefined })).toEqual({ forUpdate: "runner", at: null });
  });
});
