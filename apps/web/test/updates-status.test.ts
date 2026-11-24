import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_REASON, PLAIN_REASONS, LiveState, historyTag, historyWaitingOn, wrapUpBannerText, plainReason, runnerProgress, updateStatus, updateWaitExtras, waitingFor, type HistoryRow, type LiveRow, type DeployWaitView, type MaintenanceView, type SelfDeployView } from "../src/pages/settings/updates";
import { when } from "../src/pages/Runs";

// The Updates panel's status box (BOS-1238, design BOS-1214): rows checked in the page's table order, first match wins.

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (minFromNow: number) => new Date(NOW + minFromNow * 60_000).toISOString();

const base = (over: Partial<SelfDeployView> = {}): SelfDeployView => ({
  enabled: true,
  pending: false,
  status: null,
  available: { tip: "aaaaaaa1", deployed: "aaaaaaa1", checkedAt: iso(-3) },
  deployer: { reportedAt: iso(-1), late: false },
  ...over,
});
const offered = (over: Partial<SelfDeployView> = {}) => base({ available: { tip: "bbbbbbb2", deployed: "aaaaaaa1", checkedAt: iso(-3), commits: [{ sha: "x", subject: 'Merge "A change" (00000000-0000-4000-8000-000000000001)' }] }, ...over });
const st = (over: Partial<NonNullable<SelfDeployView["status"]>>) => ({ result: "deployed", message: "", target: "server", to_commit: "aaaaaaa1", ended: iso(-60), started: iso(-65), ...over });
const run = (over: Record<string, unknown> = {}) => ({ runId: "r1", agent: "Parsley - Web Developer", ticket: "BOS-1238", ticketTitle: "t", runningForMinutes: 20, sinceWrapUpMinutes: 5, waitingOn: null, ...over });
const maintUpdate = (over: Record<string, unknown> = {}) => ({ on: true, kind: "update", deadline: iso(5), runs: 2, companies: 1, ...over }) as unknown as MaintenanceView;
const asked = (runs: ReturnType<typeof run>[], over: Record<string, unknown> = {}) => maintUpdate({ wrapAsked: true, notRespondingAfter: 10, runsList: runs, runs: runs.length, ...over });

describe("updateStatus: one row per state, first match wins", () => {
  it("loading: Checking…, no button", () => {
    const s = updateStatus(null, null, null, NOW);
    expect(s.tag).toBe("Checking…");
    expect(s.primary).toBeNull();
  });

  it("1. Update failed: red, plain reason, raw kept, Try again only when an update is offered", () => {
    const failed = st({ result: "rolled_back", message: "Rolled back to abc12345: the smoke test (setup page) failed" });
    const withOffer = updateStatus(offered({ status: failed }), null, null, NOW);
    expect(withOffer.tag).toBe("Update failed");
    expect(withOffer.tone).toBe("red");
    expect(withOffer.alert).toBe(true);
    expect(withOffer.more).toContain("Why:");
    expect(withOffer.raw).toBe(failed.message);
    expect(withOffer.primary).toMatchObject({ id: "try-again", label: "Try again", blue: true });
    const noOffer = updateStatus(base({ status: failed }), null, null, NOW);
    expect(noOffer.primary).toBeNull();
    expect(noOffer.next).toBe("Nothing to retry: the next change will be offered when it merges.");
  });

  it("1. a rejection only because a newer update replaced it is history, not a failure", () => {
    const s = updateStatus(base({ status: st({ result: "rejected", message: "Rejected: abc is not on main any more (main is at def)" }) }), null, null, NOW);
    expect(s.tag).toBe("Up to date");
  });

  it("2. Waiting for agents, wrap-up not asked: one blue Ask agents to wrap up, plus a Cancel", () => {
    const s = updateStatus(base(), maintUpdate(), null, NOW);
    expect(s.tag).toBe("Waiting for agents");
    expect(s.say).toBe("The runner update is waiting for 2 agents to finish.");
    expect(s.primary).toMatchObject({ id: "ask-wrapup", blue: true });
    expect(s.normal.map((b) => b.id)).toEqual(["cancel-update"]);
  });

  it("2. Only a merge check left (BOS-1600): says what it waits for, offers stop-the-checks, not wrap up", () => {
    const check = { ticket: "BOS-1525", kind: "merge", scope: "full", startedAt: iso(-19), runningForMinutes: 19, usuallyMinutes: 15 };
    const m = maintUpdate({ runs: 0, companies: 0, checks: 1, checksList: [check] });
    const s = updateStatus(base(), m, null, NOW);
    expect(s.tag).toBe("Waiting for checks");
    expect(s.say).toContain("waiting for 1 check to finish before swapping the runners: BOS-1525 merge check, started ");
    expect(s.say).toContain("usually about 15 min");
    expect(s.say).not.toContain("swapping the runners now");
    expect(s.primary).toMatchObject({ id: "update-now", label: "Stop the check and update now" });
    expect(waitingFor(m as never)).toContain("BOS-1525 merge check");
  });

  it("2. Agents and checks are listed separately; with nothing left it says swapping now (BOS-1600)", () => {
    expect(waitingFor({ runs: 2, companies: 1, checks: 1, checksList: [] })).toBe("waiting for 2 runs in 1 company to finish, and for 1 check to finish before swapping the runners");
    expect(waitingFor({ runs: 0, companies: 0, checks: 0 })).toBe("swapping the runners now");
    expect(waitingFor({ runs: 0, companies: 0 })).toBe("swapping the runners now");
    // BOS-1951: a merge being pushed is named; a wait on nothing known is never a bare "swapping"/"updating".
    expect(waitingFor({ runs: 0, companies: 0, merges: 1, mergesList: [{ ticket: "BOS-7" }] })).toBe("waiting for 1 merge being pushed to main (BOS-7)");
    expect(waitingFor({ runs: 1, companies: 1, merges: 2 })).toBe("waiting for 1 run in 1 company to finish, and for 2 merges being pushed to main");
    expect(waitingFor({ runs: 0, companies: 0, unknownWait: true })).toMatch(/cannot name/);
  });

  // BOS-2479 (24 Nov 10:24): the banner said only "1 merge being pushed" while the owner saw two quick checks running.
  it("2. Names every wait with counts and tickets, the worker checks it doesn't wait for, and the latest go-ahead (BOS-2479)", () => {
    const quick = (ticket: string) => ({ ticket, kind: "pre_review", scope: "quick", startedAt: iso(-5), runningForMinutes: 5, usuallyMinutes: null });
    const m = { runs: 0, companies: 0, checks: 2, checksList: [quick("BOS-2456"), quick("BOS-2468")], merges: 1, mergesList: [{ ticket: "BOS-2408" }] };
    const text = waitingFor(m);
    expect(text).toContain("2 checks to finish before swapping the runners: BOS-2456 quick check");
    expect(text).toContain("BOS-2468 quick check");
    expect(text).toContain("1 merge being pushed to main (BOS-2408)");
    const extras = updateWaitExtras({ workerChecksList: [{ ticket: "BOS-2470", kind: "pre_review", scope: "quick" }, { ticket: "BOS-2471", kind: "pre_review", scope: "quick" }], goAheadAt: "2026-11-24T11:05:00.000Z" });
    expect(extras).toMatch(/^2 quick checks on a check worker keep running and are not waited for \(BOS-2470, BOS-2471\)\. Goes ahead by .+ at the latest\.$/);
    expect(updateWaitExtras({ workerChecksList: [{ ticket: null, kind: "merge", scope: "full" }] })).toBe("1 merge check on a check worker keeps running and is not waited for.");
    // An older server sends neither field: nothing extra. No counted push: never "being pushed".
    expect(updateWaitExtras({})).toBe("");
    expect(waitingFor({ runs: 0, companies: 0, checks: 2, checksList: [quick("BOS-2456"), quick("BOS-2468")], merges: 0, mergesList: [] })).not.toContain("being pushed");
  });

  it("2. Waiting for agents, wrap-up asked, before the deadline: no main button", () => {
    const s = updateStatus(base(), asked([run()], { deadline: iso(5) }), null, NOW);
    expect(s.tag).toBe("Waiting for agents");
    expect(s.primary).toBeNull();
  });

  it("2. after the deadline with runs left: Stop N and carry on, naming each run and sending the ids shown", () => {
    const s = updateStatus(base(), asked([run(), run({ runId: "r2", agent: "Dougal - Dev", ticket: "BOS-5" })], { deadline: iso(-1) }), null, NOW);
    expect(s.primary).toMatchObject({ id: "stop-stragglers", label: "Stop 2 and carry on with the update", blue: true, runIds: ["r1", "r2"] });
    expect(s.next).toContain("Parsley (BOS-1238) and Dougal (BOS-5)");
    expect(s.next).toContain("anything they haven't saved is lost");
  });

  it("2. past the deadline but no run left: no stop button", () => {
    const s = updateStatus(base(), asked([], { deadline: iso(-1) }), null, NOW);
    expect(s.primary).toBeNull();
  });

  it("2. an update with no agents left is Updating", () => {
    expect(updateStatus(base(), maintUpdate({ runs: 0 }), null, NOW).tag).toBe("Updating");
  });

  it("2b. a plain wrap-up with no update is Wrapping up, never Up to date", () => {
    const m = { on: true, kind: "wrapup", deadline: iso(5), runs: 1, companies: 1, wrapAsked: true, notRespondingAfter: 10, runsList: [run()] } as unknown as MaintenanceView;
    const s = updateStatus(base(), m, null, NOW);
    expect(s.tag).toBe("Wrapping up");
    expect(s.primary).toBeNull();
  });

  it("2c. BOS-2056: a wrap-up names the update it is for, or says none was waiting", () => {
    const mk = (over: Record<string, unknown>) => ({ on: true, kind: "wrapup", deadline: iso(5), runs: 0, companies: 1, wrapAsked: true, notRespondingAfter: 10, runsList: [], wrapSince: iso(-20), ...over }) as unknown as MaintenanceView;
    const server = updateStatus(base(), mk({ wrapForUpdate: "server" }), null, NOW);
    expect(server.say).toContain("Wrapping up for the server update");
    expect(server.more).toContain("lifts by itself");
    const none = updateStatus(base(), mk({ wrapForUpdate: "none" }), null, NOW);
    expect(none.more).toContain("no update was waiting");
    expect(none.more).not.toContain("Nothing new starts until you press");
    expect(wrapUpBannerText({ runs: 1, wrapSince: iso(-20), wrapForUpdate: "none" })).toMatch(/^You asked agents to wrap up at .+ \(no update was waiting\)\./);
    expect(wrapUpBannerText({ runs: 0, wrapSince: iso(-20), wrapForUpdate: "server" })).toContain("Wrapping up for the server update");
  });

  it("2d. BOS-2056: every Waiting row in Recent updates says what it waits on", () => {
    const row = (over: Partial<HistoryRow>) => ({ id: "h1", at: iso(-5), target: "server", result: "queued", changes: 2, message: "", ...over }) as unknown as HistoryRow;
    expect(historyTag(row({})).tag).toBe("Waiting");
    expect(historyWaitingOn(row({}), null, null, false)).toContain("your approval");
    const w: DeployWaitView = { on: true, phase: "waiting", origin: "approve", commit: "bbbbbbbb22", deadline: iso(20), quiet: { ready: false, runs: 1, checks: 0, freeMb: null, needMb: null, why: ["1 agent is running"] } };
    expect(historyWaitingOn(row({}), w, null, false)).toContain("a quiet machine: 1 agent is running");
    expect(historyWaitingOn(row({ target: "runner" }), null, maintUpdate(), false)).toContain("the runner swap: waiting for 2 runs");
    expect(historyWaitingOn(row({ target: "runner" }), null, null, true)).toContain("in front of it");
    expect(historyWaitingOn(row({ result: "deployed" }), null, null, false)).toBeNull();
  });

  it("3. Approved, waiting for a quiet machine: no main button, a Cancel, BOS-420's line", () => {
    const w: DeployWaitView = { on: true, phase: "waiting", origin: "approve", commit: "bbbbbbbb22", deadline: iso(20), quiet: { ready: false, runs: 1, checks: 0, freeMb: null, needMb: null, why: ["1 agent is running"] } };
    const s = updateStatus(offered(), null, w, NOW);
    expect(s.tag).toBe("Approved, waiting");
    expect(s.more).toContain("1 agent is running");
    expect(s.primary).toBeNull();
    expect(s.normal.map((b) => b.id)).toEqual(["cancel-wait"]);
  });

  it("4. Updating: while the host has a request or is running", () => {
    expect(updateStatus(base({ pending: true }), null, null, NOW).tag).toBe("Updating");
    expect(updateStatus(base({ status: st({ result: "running" }) }), null, null, NOW).tag).toBe("Updating");
  });

  it("5. In trial: with progress and no button", () => {
    const s = updateStatus(base({ trial: { endsAt: iso(10), seconds: 900 } }), null, null, NOW);
    expect(s.tag).toBe("In trial");
    expect(s.progress).toEqual({ doneMin: 5, totalMin: 15 });
    expect(s.primary).toBeNull();
  });

  it("6. Update ready: one blue Review and deploy, change count in the sentence", () => {
    const s = updateStatus(offered(), null, null, NOW);
    expect(s.tag).toBe("Update ready");
    expect(s.say).toBe("A server update with 1 change is ready.");
    expect(s.primary).toMatchObject({ id: "review-deploy", label: "Review and deploy", blue: true });
  });

  it("6. Update ready while rate-limited: the button is disabled and says when", () => {
    const s = updateStatus(offered({ deployWait: { until: iso(7) } }), null, null, NOW);
    expect(s.primary?.disabled).toBe(true);
    expect(s.next).toContain("You can deploy again from");
  });

  it("7. Host not reporting: amber, no button", () => {
    const s = updateStatus(base({ available: null, deployer: { reportedAt: iso(-60), late: true } }), null, null, NOW);
    expect(s.tag).toBe("Host not reporting");
    expect(s.tone).toBe("amber");
    expect(s.primary).toBeNull();
  });

  it("8. Up to date: green, a plain Check for updates now button", () => {
    const s = updateStatus(base({ status: st({ result: "deployed" }) }), null, null, NOW);
    expect(s.tag).toBe("Up to date");
    expect(s.tone).toBe("green");
    expect(s.primary).toMatchObject({ id: "check-now", blue: false });
    expect(s.more).toContain("Server updated");
  });

  // BOS-1648: the runner line is the server's one answer, word for word; never "may be needed".
  describe("8b. the runner line", () => {
    const at = (runnerUpdate: SelfDeployView["runnerUpdate"]) => updateStatus(base({ status: st({ result: "deployed" }), runnerImage: { running: "aaaaaaa1", needed: "bbbbbbb2" }, runnerUpdate }), null, null, NOW);

    it("not needed: green, names the server-only changes", () => {
      const words = "Runners are up to date: the changes since they were built (BOS-1635) are server-only.";
      const s = at({ state: "not_needed", words, tickets: ["BOS-1635"] });
      expect([s.tone, s.tag, s.say]).toEqual(["green", "Up to date", "Boss Man is up to date."]);
      expect(s.more).toContain(words);
    });

    it("needed: amber, names the tickets and the button", () => {
      const words = "Runner update needed: BOS-1583 changes what the runners are built from (they were built from aaaaaaa1; the server runs bbbbbbb2).";
      const s = at({ state: "needed", words, tickets: ["BOS-1583"] });
      expect([s.tone, s.tag]).toEqual(["amber", "Runner update needed"]);
      expect(s.more).toContain(`${words} Press Build and update runners under Other actions.`);
    });

    it("can't tell: amber, says why, never 'not needed'", () => {
      const words = "Boss Man can't tell whether a runner update is needed, because the server runs bbbbbbb2, which isn't a merge Boss Man recorded.";
      const s = at({ state: "unknown", words, tickets: [] });
      expect([s.tone, s.tag]).toEqual(["amber", "Can't tell"]);
      expect(s.more).toContain(words);
      expect(s.more).not.toMatch(/up to date: the changes/);
    });

    it("never says 'may', in any state", () => {
      for (const state of ["needed", "not_needed", "unknown"] as const) expect(at({ state, words: "x.", tickets: [] }).more).not.toMatch(/\bmay\b/);
      expect(at(null).more).not.toMatch(/\bmay\b|Runner image/);
    });
  });

  it("never more than one blue main button, in any row", () => {
    const rows = [
      updateStatus(offered(), null, null, NOW),
      updateStatus(base(), maintUpdate(), null, NOW),
      updateStatus(base(), asked([run()], { deadline: iso(-1) }), null, NOW),
      updateStatus(base(), null, null, NOW),
    ];
    for (const r of rows) expect([r.primary].filter((b) => b?.blue)).toHaveLength(r.primary?.blue ? 1 : 0);
  });
});

describe("plain failure reasons", () => {
  it("maps each listed host message, and falls back to the default for an unknown one", () => {
    for (const r of PLAIN_REASONS) expect(r.reason.length).toBeGreaterThan(0);
    expect(plainReason("Rejected: the request file is not a plain file under 4 KB.")).toContain("damaged");
    expect(plainReason("Rolled back to abc12345: it went wrong")).toContain("switched back");
    expect(plainReason("something nobody has seen before")).toBe(DEFAULT_REASON);
    expect(plainReason(null)).toBe(DEFAULT_REASON);
    expect(DEFAULT_REASON).toBe("the update stopped with an error");
  });

  // BOS-1469: a press that waits comes first; the earlier refusal is only "Previous attempt", never "Try again in N minutes".
  describe("a waiting request and an older rejected result (BOS-1469)", () => {
    const refusal = st({ result: "rejected", target: "runner", message: "Rejected: only one runner deploy every 10 minutes.", ended: iso(-3), started: iso(-3) });
    const real = st({ result: "deployed", target: "runner", message: "Image built.", ended: iso(-12), started: iso(-15) });

    it("says what was pressed and that it waits for the host, with the previous result below", () => {
      const s = updateStatus(base({ status: refusal, previousRun: real, active: { phase: "waiting", what: "Build and update runners", since: iso(-1) } }), null, null, NOW);
      expect(s.tag).toBe("Updating");
      expect(s.say).toBe(`Build and update runners, pressed ${when(iso(-1))}: waiting for the host, it checks every minute.`);
      expect(s.more).toBe(`Previous attempt: deployed, runner aaaaaaa1, ${when(real.ended)}. Image built.`);
      expect(s.more).not.toMatch(/Try again/);
      expect(s.primary).toBeNull();
    });

    it("says running since when the host has started it", () => {
      const s = updateStatus(base({ status: refusal, previousRun: real, active: { phase: "running", what: "Build and update runners", since: iso(-1) } }), null, null, NOW);
      expect(s.say).toBe(`Build and update runners, pressed ${when(iso(-1))}: running since ${when(iso(-1))}.`);
    });

    it("a refused runner press shows when to press again, and does not grey the server button", () => {
      const view = offered({ status: refusal, deployWait: { until: iso(2), target: "runner" } });
      const s = updateStatus(view, null, null, NOW);
      expect(s.tag).toBe("Update ready");
      expect(s.primary?.disabled).toBeFalsy();
      const upToDate = updateStatus(base({ status: refusal, deployWait: { until: iso(2), target: "runner" }, runnerImage: { running: "aaaaaaa1", needed: "bbbbbbb2" } }), null, null, NOW);
      expect(upToDate.more).toContain("Runner update: press Build and update runners again from ");
      expect(upToDate.more).not.toMatch(/may still be needed/);
    });
  });

  // BOS-1238 open question 3: every failure message the host can write gets a reason, so a new one falls back to the
  // default and never shows nothing. The messages are read from the script itself, so a new one is covered here.
  it("every failure message in host-deployer.sh yields a non-empty plain reason", () => {
    const script = readFileSync(path.resolve(__dirname, "../../../scripts/host-deployer.sh"), "utf8");
    const msgs = [...script.matchAll(/(?:finish (?:failed|rolled_back|partial|rejected)|bg_fail (?:failed|rolled_back)) "((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    expect(msgs.length).toBeGreaterThan(15);
    for (const m of msgs) {
      const reason = plainReason(m);
      expect(reason, m).toBeTruthy();
      expect(reason.endsWith("."), m).toBe(false);
    }
  });
});

describe("runner swap in progress: every part of the page agrees (BOS-1558)", () => {
  const row = (slug: string, imageVersion: string, over: Record<string, unknown> = {}) => ({ slug, name: slug, registered: true, connected: true, at: iso(-1), imageVersion, fault: null, ...over }) as unknown as LiveRow;
  const hist = { id: "h1", target: "runner", commit: "abc", changes: 0, result: "deployed", message: null, at: iso(-5) } as HistoryRow;
  const view = base({ status: st({ target: "runner", result: "deployed" }) });

  it("image built, one company swapped, one still waiting: all say still in progress", () => {
    const live = [row("a", "202611151140"), row("b", "202611151017")];
    const m = maintUpdate({ runs: 0 });
    const p = runnerProgress(live, m);
    expect(p).toMatchObject({ inProgress: true, done: 1, total: 2 });
    expect(historyTag(hist, p).tag).toBe("Swapping (1 of 2 companies done)");
    expect(updateStatus(view, m, null, NOW).tag).toBe("Updating");
    expect(renderToStaticMarkup(createElement(LiveState, { r: live[1]!, progress: p }))).toContain("waiting for runs to finish, old image 202611151017");
    expect(renderToStaticMarkup(createElement(LiveState, { r: live[0]!, progress: p }))).not.toContain("old image");
  });

  it("all swapped and the hold is off: all say done", () => {
    const live = [row("a", "202611151140"), row("b", "202611151140")];
    const m = { on: false } as MaintenanceView;
    const p = runnerProgress(live, m);
    expect(p.inProgress).toBe(false);
    expect(historyTag(hist, p).tag).toBe("Done");
    expect(updateStatus(view, m, null, NOW).tag).not.toBe("Updating");
    expect(renderToStaticMarkup(createElement(LiveState, { r: live[1]!, progress: p }))).not.toContain("old image");
  });

  // BOS-2525: the badge count and the "Now running" list use one test, even with a leftover swap mark.
  it("badge count matches the list: 0 of 3, 2 of 3 and 3 of 3", () => {
    const m = maintUpdate({ runs: 1 });
    const NEW = "202611241722";
    const OLD = "202611241201";
    const tagFor = (live: LiveRow[]) => historyTag(hist, runnerProgress(live, m)).tag;
    const connectedCount = (live: LiveRow[]) => live.filter((l) => renderToStaticMarkup(createElement(LiveState, { r: l, progress: runnerProgress(live, m) })).includes(">Connected<")).length;

    const two = [row("a", NEW, { swap: { id: "s" } }), row("b", NEW, { swap: { id: "s" } }), row("c", OLD)];
    expect(tagFor(two)).toBe("Swapping (2 of 3 companies done)");
    expect(connectedCount(two)).toBe(2);

    const none = [row("a", OLD), row("b", OLD), row("c", NEW, { connected: false })];
    expect(tagFor(none)).toBe("Swapping (0 of 3 companies done)");

    // Held but every runner already connected on the new image: the hold has not lifted yet, so "3 of 3" still reads "Swapping".
    const all = [row("a", NEW), row("b", NEW), row("c", NEW)];
    expect(tagFor(all)).toBe("Swapping (3 of 3 companies done)");
    expect(connectedCount(all)).toBe(3);
  });
});
