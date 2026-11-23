import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";
import { mergeJamService } from "../src/services/merge-jam.js";
import { fixText, heldText, mergeLineHealth, pausedText, slowText, type HealthInput } from "../src/services/merge-line-health.js";

// BOS-1594: the one verdict on the merge line. Stuck (nothing landing, or a fault) pages; over capacity (landing, slowly) never does.

const NOW = new Date("2026-11-15T19:10:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const merged = (min: number, i = 0) => ({ ticketId: `t${i}`, ref: `X-${i}`, title: "t", result: "merged" as const, detail: "merged as abc1234", at: ago(min) });
const row = (extra: Record<string, unknown> = {}) =>
  ({ ticketId: "w", ref: "X-1", title: "One", minutes: 90, state: "waiting_for_check_capacity", label: "waiting for a check slot", stuck: true, next: "Boss Man starts it as soon as a slot frees.", actor: "system", decisionId: null, ...extra }) as never;
const input = (extra: Partial<HealthInput> = {}): HealthInput => ({ running: [], waiting: [], recent: [], slots: 3, ...extra });
const queue = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => row({ ticketId: `w${i}`, ref: `X-${i + 10}`, minutes: 120 + i, ...extra }));

describe("mergeLineHealth: held behind a main fix (R28)", () => {
  const held = (row1 = row({ state: "held", stuck: false, actor: "agent" })) => input({ waiting: [row1, row1], recent: [merged(300, 1)] });
  const fix = (extra: Record<string, unknown> = {}) => ({ ticketId: "f", ref: "X-9", title: "Fix main", stateText: "in review", ownerUpdate: false, stalled: null, ...extra }) as never;

  it("six held rows used to read healthy; with the hold's own ids the line says held behind the fix", () => {
    expect(mergeLineHealth(held(), { now: NOW }).state).toBe("healthy");
    const line = mergeLineHealth(held(), { now: NOW, heldBehindFix: { held: 6, fixes: [fix()], since: ago(90) } });
    expect(line).toMatchObject({ state: "held_behind_fix", held: 6, since: ago(90) });
    expect(heldText(line as never, () => "11:37")).toBe("Merges are held: 6 approved tickets are held behind the fix X-9 (in review), since 11:37. They merge by themselves once it is merged and live.");
  });

  it("says when only the owner's server update is left", () => {
    const line = mergeLineHealth(held(), { now: NOW, heldBehindFix: { held: 1, fixes: [fix({ stateText: "merged, waiting for the server update", ownerUpdate: true })], since: null } });
    expect(heldText(line as never, () => "")).toBe("Merges are held: 1 approved ticket is held behind the fix X-9 (merged, waiting for the server update). It goes on once you run the server update.");
  });

  it("a stalled fix is stuck (fix_stalled), not calm", () => {
    const line = mergeLineHealth(held(), { now: NOW, heldBehindFix: { held: 3, fixes: [fix({ stalled: { reason: "it has been landing for 75 minutes with no result" } })], since: null } });
    expect(line).toMatchObject({ state: "stuck", cause: "fix_stalled", others: 3, fix: "The CEO looks at X-9." });
  });
});

describe("mergeLineHealth: banner and sidebar badge agree (BOS-1715)", () => {
  it("31 in the queue, 10 of them held by an agent: the banner names both figures, and no clear time from one landing", () => {
    const waiting = [...queue(21), ...queue(10, { state: "held", actor: "agent", stuck: false })];
    const line = mergeLineHealth(input({ waiting, recent: [merged(3, 1)] }), { now: NOW });
    // The badge shows lineCount (waiting + running, here no running); the banner must carry that same 31.
    expect(line).toMatchObject({ state: "over_capacity", waiting: 21, inQueue: waiting.length, etaMinutes: null });
    const text = slowText(line as never, () => "08:13");
    // R43: each figure under its own label; neither says "waiting".
    expect(text).toContain("21 for Boss Man to merge (31 in the merge line; the rest are merging now or with an agent or you)");
    expect(text).not.toMatch(/\bwaiting\b/);
    expect(text).toContain("estimating the time to clear…");
  });

  it("R43: the merge-line figure counts running merges too, as the badge and Merges tab do", () => {
    const running = [{ ticketId: "r1", ref: "X-90", title: "r", phase: "checking", startedAt: ago(5), startedBy: null, minutes: 5, what: "merge_check", slot: 1, overLimit: false }];
    const line = mergeLineHealth(input({ waiting: queue(17), running: running as never, recent: [merged(7, 1), merged(27, 2), merged(47, 3), merged(67, 4)] }), { now: NOW });
    expect(line).toMatchObject({ state: "over_capacity", waiting: 17, inQueue: 18 });
  });

  it("landings bunched into a few minutes (just after a restart) give no estimate", () => {
    const line = mergeLineHealth(input({ waiting: queue(5), recent: [merged(1, 1), merged(2, 2), merged(4, 3)] }), { now: NOW });
    expect(line).toMatchObject({ state: "over_capacity", etaMinutes: null });
  });
});

describe("mergeLineHealth", () => {
  it("17 tickets behind 3 slots, landing every 20 minutes: over capacity, not stuck (the 15 Nov case)", () => {
    const line = mergeLineHealth(input({ waiting: queue(17), recent: [merged(7, 1), merged(27, 2), merged(47, 3), merged(67, 4)] }), { now: NOW });
    expect(line).toEqual({ state: "over_capacity", waiting: 17, etaMinutes: 340, lastLandedAt: ago(7), advice: null });
    expect(slowText(line as never, () => "19:03")).toBe("Merging, but slowly: 17 for Boss Man to merge, about 5 h 40 min to clear at the current rate, last landed 19:03.");
  });

  it("names a check worker only when none is connected", () => {
    const base = input({ waiting: queue(5), recent: [merged(7, 1), merged(27, 2)] });
    expect(mergeLineHealth(base, { now: NOW, workerReady: false })).toMatchObject({ state: "over_capacity", advice: expect.stringContaining("check worker") });
    expect(mergeLineHealth(base, { now: NOW, workerReady: true })).toMatchObject({ state: "over_capacity", advice: null });
    expect(mergeLineHealth(base, { now: NOW })).toMatchObject({ state: "over_capacity", advice: null });
  });

  it("BOS-2361: every merge waiting for another ticket's landing turn still counts as no landing", () => {
    const waiting = queue(3, { state: "waiting_for_turn", label: "waiting for X-1 to land", stuck: false });
    const line = mergeLineHealth(input({ waiting, recent: [merged(100, 1)] }), { now: NOW });
    expect(line).toMatchObject({ state: "stuck", cause: "no_landing", others: 2 });
    expect((line as { reason: string }).reason).toContain("3 wait for another ticket's landing turn");
    // Landing within 45 minutes is not stuck.
    expect(mergeLineHealth(input({ waiting, recent: [merged(10, 1)] }), { now: NOW }).state).not.toBe("stuck");
  });

  it("nothing landed for 45+ minutes while work waits: stuck, with the step that fixes it", () => {
    const line = mergeLineHealth(input({ waiting: queue(3), recent: [merged(100, 1)] }), { now: NOW });
    expect(line).toMatchObject({ state: "stuck", cause: "no_landing", title: "Nothing has merged for 1 h 40 min", others: 2 });
    expect((line as { fix: string }).fix).toContain("CEO");
  });

  it("a ticket approved just now after a quiet night is healthy, not stuck", () => {
    expect(mergeLineHealth(input({ waiting: [row({ minutes: 3, stuck: false })], recent: [merged(600, 1)] }), { now: NOW })).toEqual({ state: "healthy" });
  });

  it("a check running past the hour is stuck even while others land", () => {
    const running = [{ what: "merge_check", overLimit: true, ref: "X-9", title: "Nine", minutes: 130, phase: "checking" }] as never;
    expect(mergeLineHealth(input({ running, recent: [merged(5, 1)] }), { now: NOW })).toMatchObject({ state: "stuck", cause: "check_too_long", title: "X-9 has been in its check for 2 h 10 min" });
  });

  it("a fault that is not a plain wait for a slot (no runner) is stuck and names its fix", () => {
    const w = row({ state: "waiting_for_slot", label: "waiting: no runner is connected", next: "Start the runner container on your host." });
    expect(mergeLineHealth(input({ waiting: [w], recent: [merged(5, 1)] }), { now: NOW })).toMatchObject({ state: "stuck", cause: "gate_fault", reason: "Waiting: no runner is connected", fix: "Start the runner container on your host." });
  });

  it("an empty train seat with work waiting is stuck after 3 minutes", () => {
    const base = input({ waiting: [row({ minutes: 20, stuck: false })], recent: [merged(5, 1)] });
    expect(mergeLineHealth(base, { now: NOW, emptySeatSince: NOW.getTime() - 2 * 60_000 })).toEqual({ state: "healthy" });
    expect(mergeLineHealth(base, { now: NOW, emptySeatSince: NOW.getTime() - 5 * 60_000 })).toMatchObject({ state: "stuck", cause: "empty_seat" });
  });

  it("owner-turn, card-held and agent-turn rows are never this line's stuck or slow", () => {
    const waiting = [row({ actor: "owner", decisionId: "d1", state: "waiting_for_sign_off" }), row({ actor: "agent", state: "check_failed_retrying" }), row({ actor: "ceo", state: "needs_you" })];
    expect(mergeLineHealth(input({ waiting, recent: [merged(300, 1)] }), { now: NOW })).toEqual({ state: "healthy" });
  });

  it("an empty line is healthy", () => {
    expect(mergeLineHealth(input(), { now: NOW })).toEqual({ state: "healthy" });
  });
});

describe("the jam alert reads the same verdict", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => void (await close?.()));

  async function setup(view: { line: unknown }) {
    const { db, close: c } = await openPglite();
    close = c;
    const [co] = await db.insert(companies).values({ name: "Co", ticketPrefix: "X" } as never).returning({ id: companies.id });
    const sent: Array<{ level: string; title: string; body: string }> = [];
    let t = NOW.getTime();
    const service = mergeJamService(db, {
      view: async () => ({ running: [], waiting: [], recent: [], ...view }) as never,
      notify: async (n) => {
        sent.push(n);
        return { id: `n${sent.length}`, level: n.level };
      },
      now: () => new Date(t),
    });
    return { service, sent, advance: (ms: number) => (t += ms), companyId: co!.id };
  }

  it("over capacity sends one calm feed note a day, never a flag or page", async () => {
    const slow = { state: "over_capacity", waiting: 17, etaMinutes: 255, lastLandedAt: ago(7), advice: null };
    const c = await setup({ line: slow });
    expect(await c.service.run()).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    await c.service.run();
    c.advance(23 * 3_600_000);
    await c.service.run();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ level: "note", title: "Merging, but slowly" });
    expect(c.sent[0]!.body).toContain("Merging, but slowly: 17 for Boss Man to merge, about 4 h 15 min to clear at the current rate, last landed 19:03 UTC.");
    c.advance(2 * 3_600_000);
    await c.service.run();
    expect(c.sent).toHaveLength(2);
    expect(c.sent.every((n) => n.level === "note")).toBe(true);
  });

  it("stuck flags the owner with the cause and the fix", async () => {
    const stuck = { state: "stuck", cause: "no_landing", title: "Nothing has merged for 1 h 40 min", reason: "3 tickets are waiting and none has landed in that time", fix: "The CEO looks at the line and gets it moving.", others: 2 };
    const c = await setup({ line: stuck });
    expect(await c.service.run()).toMatchObject({ alerted: 1 });
    expect(c.sent[0]).toMatchObject({ level: "flag", title: "Merges are stuck: Nothing has merged for 1 h 40 min" });
    expect(c.sent[0]!.body).toContain("Fix: The CEO looks at the line and gets it moving.");
    // R43: the banner's words for the same figure (mergeQueue.behindIt).
    expect(c.sent[0]!.body).toContain("2 more behind it.");
  });
});

describe("mergeLineHealth: a deliberate pause (R44)", () => {
  const pause = { reason: "a server update", since: ago(120), until: new Date(NOW.getTime() + 3_600_000).toISOString() };
  // The 08:52 case: work waiting for hours, nothing landing, 2 of 5 slots busy, new checks held on purpose.
  const stalled = () => input({ slots: 5, waiting: queue(21), recent: [merged(300, 1)], running: [{ what: "merge_check", overLimit: true, phase: "checking", minutes: 90, ref: "X-1", title: "t" }, { what: "merge_check", overLimit: false, phase: "checking", minutes: 5, ref: "X-2", title: "u" }] as never });

  it("without the pause the same line is stuck; with it the verdict is paused, with no stuck or slow state", () => {
    expect(mergeLineHealth(stalled(), { now: NOW }).state).toBe("stuck");
    const line = mergeLineHealth(stalled(), { now: NOW, pause });
    expect(line).toEqual({ state: "paused", ...pause, inUse: 2, slots: 5 });
    expect(pausedText(line as never, (iso) => (iso === pause.since ? "08:52" : "11:52"))).toBe("Paused for a server update since 08:52; new checks start once it is done, by 11:52 at the latest. 2 of 5 slots in use: new checks paused.");
  });

  it("the jam notifier raises nothing while paused", async () => {
    const { db, close } = await openPglite();
    const [co] = await db.insert(companies).values({ name: "Co", ticketPrefix: "X" } as never).returning({ id: companies.id });
    const sent: unknown[] = [];
    const service = mergeJamService(db, {
      view: async () => ({ running: [], waiting: [], recent: [], line: { state: "paused", ...pause, inUse: 2, slots: 5 } }) as never,
      notify: async (n) => (sent.push(n), { id: "n", level: n.level }),
      now: () => NOW,
    });
    expect(await service.run()).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(sent).toHaveLength(0);
    expect(co).toBeTruthy();
    await close();
  });
});

// fixText words a held fix and its state. The problem kinds (check_too_long, gate_fault, empty_seat, no_landing,
// fix_stalled) are worded in mergeLineHealth's own title/reason above, not here, so they have no fixText case.
describe("fixText", () => {
  const fix = (extra: Record<string, unknown> = {}) => ({ ticketId: "f", ref: "X-9", title: "Fix main", stateText: "in review", ownerUpdate: false, stalled: null, ...extra }) as never;

  it("names the fix by its ref and words its state", () => {
    expect(fixText(fix())).toBe("X-9 (in review)");
    for (const [stateText, expected] of [
      ["merged, waiting for the CEO to mark it live", "X-9 (merged, waiting for the CEO to mark it live)"],
      ["merge check running, 12 min", "X-9 (merge check running, 12 min)"],
      ["waiting for GitHub CI, 20 min", "X-9 (waiting for GitHub CI, 20 min)"],
      ["approved, waiting to land, 5 min", "X-9 (approved, waiting to land, 5 min)"],
      ["sent back for changes", "X-9 (sent back for changes)"],
      ["being fixed", "X-9 (being fixed)"],
      ["blocked", "X-9 (blocked)"],
      ["not started", "X-9 (not started)"],
      ["merged", "X-9 (merged)"],
    ] as const)
      expect(fixText(fix({ stateText }))).toBe(expected);
  });

  it("falls back to the quoted title while there is no ref", () => {
    expect(fixText(fix({ ref: null, title: "Fix main after the gate broke" }))).toBe('"Fix main after the gate broke" (in review)');
  });

  it("passes an unknown state through as given, so a new one is never swallowed", () => {
    expect(fixText(fix({ ref: null, title: "Fix", stateText: "parked for a new round" }))).toBe('"Fix" (parked for a new round)');
  });
});
