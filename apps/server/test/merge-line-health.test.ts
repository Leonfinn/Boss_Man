import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";
import { mergeJamService } from "../src/services/merge-jam.js";
import { mergeLineHealth, slowText, type HealthInput } from "../src/services/merge-line-health.js";

// BOS-1594: the one verdict on the merge line. Stuck (nothing landing, or a fault) pages; over capacity (landing, slowly) never does.

const NOW = new Date("2026-11-15T19:10:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const merged = (min: number, i = 0) => ({ ticketId: `t${i}`, ref: `X-${i}`, title: "t", result: "merged" as const, detail: "merged as abc1234", at: ago(min) });
const row = (extra: Record<string, unknown> = {}) =>
  ({ ticketId: "w", ref: "X-1", title: "One", minutes: 90, state: "waiting_for_check_capacity", label: "waiting for a check slot", stuck: true, next: "Boss Man starts it as soon as a slot frees.", actor: "system", decisionId: null, ...extra }) as never;
const input = (extra: Partial<HealthInput> = {}): HealthInput => ({ running: [], waiting: [], recent: [], slots: 3, ...extra });
const queue = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => row({ ticketId: `w${i}`, ref: `X-${i + 10}`, minutes: 120 + i, ...extra }));

describe("mergeLineHealth", () => {
  it("17 tickets behind 3 slots, landing every 20 minutes: over capacity, not stuck (the 15 Nov case)", () => {
    const line = mergeLineHealth(input({ waiting: queue(17), recent: [merged(7, 1), merged(27, 2), merged(47, 3), merged(67, 4)] }), { now: NOW });
    expect(line).toEqual({ state: "over_capacity", waiting: 17, etaMinutes: 340, lastLandedAt: ago(7), advice: null });
    expect(slowText(line as never, () => "19:03")).toBe("Merging, but slowly: 17 merge checks waiting, about 5 h 40 min to clear at the current rate, last landed 19:03.");
  });

  it("names a check worker only when none is connected", () => {
    const base = input({ waiting: queue(5), recent: [merged(7, 1), merged(27, 2)] });
    expect(mergeLineHealth(base, { now: NOW, workerReady: false })).toMatchObject({ state: "over_capacity", advice: expect.stringContaining("check worker") });
    expect(mergeLineHealth(base, { now: NOW, workerReady: true })).toMatchObject({ state: "over_capacity", advice: null });
    expect(mergeLineHealth(base, { now: NOW })).toMatchObject({ state: "over_capacity", advice: null });
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
    expect(c.sent[0]!.body).toContain("Merging, but slowly: 17 merge checks waiting, about 4 h 15 min to clear at the current rate, last landed 19:03 UTC.");
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
    expect(c.sent[0]!.body).toContain("2 other pieces of work are waiting behind it.");
  });
});
