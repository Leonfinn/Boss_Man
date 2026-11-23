// BOS-2195: the daily summary's three top lines, and the optional weekly email (off by default, once a week, kept across restarts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies, costEvents, decisions, fundingSources, projects, tickets } from "../src/db/schema.js";
import { buildSummary } from "../src/services/watchdog-summary.js";
import { dayFacts, dayLines, weeklySummaryService, weeklyText } from "../src/services/weekly-summary.js";

const H = 3_600_000;
const NOW = new Date("2026-11-23T09:00:00Z"); // a Monday
let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;
let projectId: string;
let sourceId: string;
beforeAll(async () => {
  ({ db, close } = await openPglite());
  companyId = (await db.insert(companies).values({ name: "Co" }).returning())[0]!.id;
  projectId = (await db.insert(projects).values({ companyId, name: "Dev" }).returning())[0]!.id;
  sourceId = (await db.insert(fundingSources).values({ name: "src", kind: "api_payg", provider: "anthropic" }).returning())[0]!.id;
});
afterAll(async () => close());

describe("dayLines", () => {
  it("leaves out a line with nothing to say, and caps titles at 5", () => {
    expect(dayLines({ merged: [], spentMicros: 0, avgMicros: 0, waiting: 0, oldestWaitingMs: null })).toEqual([]);
    const lines = dayLines({ merged: ["a", "b", "c", "d", "e", "f", "g"], spentMicros: 12_340_000, avgMicros: 8_000_000, waiting: 2, oldestWaitingMs: 5 * H });
    expect(lines).toEqual(['Merged yesterday: 7 tickets ("a", "b", "c", "d", "e" and 2 more)', "Spent yesterday: $12.34 (7-day average $8.00)", "Waiting for you: 2 cards, oldest 5 hours"]);
  });
  it("go on top; a day with only them still sends, a day with nothing still doesn't", () => {
    const base = { now: NOW, caught: 0, fixed: 0, actions: {}, open: [], decisions: [] };
    expect(buildSummary(base)).toBeNull();
    const s = buildSummary({ ...base, dayLines: ["Spent yesterday: $1.00 (7-day average $1.00)"] });
    expect(s!.body.startsWith("Spent yesterday")).toBe(true);
  });
});

describe("dayFacts reads merges, spend and waiting cards", () => {
  it("counts only the last 24 hours, averages the 7 days before, and sees open owner cards", async () => {
    await db.insert(tickets).values([
      { companyId, projectId, title: "Fresh", number: 1, systemState: "done", mergedAt: new Date(NOW.getTime() - 3 * H) },
      { companyId, projectId, title: "Old", number: 2, systemState: "done", mergedAt: new Date(NOW.getTime() - 30 * H) },
    ]);
    await db.insert(costEvents).values([
      { fundingSourceId: sourceId, companyId, costMicros: 3_000_000, occurredAt: new Date(NOW.getTime() - 2 * H) },
      { fundingSourceId: sourceId, companyId, costMicros: 14_000_000, occurredAt: new Date(NOW.getTime() - 48 * H) },
    ]);
    await db.insert(decisions).values({ companyId, kind: "question", question: "Q?", recommendedOption: "a", createdAt: new Date(NOW.getTime() - 5 * H) });
    const f = await dayFacts(db, companyId, NOW);
    expect(f.merged).toEqual(["Fresh"]);
    expect(f.spentMicros).toBe(3_000_000);
    expect(f.avgMicros).toBe(2_000_000);
    expect(f.waiting).toBe(1);
    expect(Math.round((f.oldestWaitingMs ?? 0) / H)).toBe(5);
  });
});

describe("weekly email", () => {
  const make = (at: { t: Date }, sent: Array<{ to: string; subject: string; text: string }>, configured = true) =>
    weeklySummaryService(db, {
      send: async (m) => void sent.push(m),
      isConfigured: async () => configured,
      localDayHour: (t) => ({ day: ((t.getUTCDay() + 6) % 7) + 1, hour: t.getUTCHours() }),
      now: () => at.t,
    });

  it("is off by default, sends once on Monday after 8, not again, and not on other days or before 8", async () => {
    const at = { t: NOW };
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const w = make(at, sent);
    expect((await w.get(companyId)).enabled).toBe(false);
    expect(await w.run(companyId)).toBe(false);
    await expect(w.save(companyId, { enabled: true, to: null })).rejects.toThrow(/address/);
    await w.save(companyId, { enabled: true, to: "me@example.com" });
    at.t = new Date("2026-11-23T07:00:00Z");
    expect(await w.run(companyId)).toBe(false);
    at.t = new Date("2026-11-24T09:00:00Z");
    expect(await w.run(companyId)).toBe(false);
    at.t = NOW;
    expect(await w.run(companyId)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("me@example.com");
    expect(sent[0]!.text).toContain("Merged this week: 2 tickets");
    // A fresh service (a restart) reads the stored last-sent time.
    at.t = new Date(NOW.getTime() + 2 * H);
    expect(await make(at, sent).run(companyId)).toBe(false);
    at.t = new Date(NOW.getTime() + 7 * 24 * H);
    expect(await make(at, sent).run(companyId)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("sends nothing without email settings, and retries after a failed send", async () => {
    const at = { t: new Date("2026-11-30T09:00:00Z") };
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    expect(await make({ t: new Date("2026-12-07T09:00:00Z") }, sent, false).run(companyId)).toBe(false);
    const failing = weeklySummaryService(db, { send: async () => { throw new Error("down"); }, isConfigured: async () => true, localDayHour: () => ({ day: 1, hour: 9 }), now: () => new Date("2026-12-14T09:00:00Z") });
    expect(await failing.run(companyId)).toBe(false);
    expect(await make({ t: new Date("2026-12-14T09:30:00Z") }, sent).run(companyId)).toBe(true);
    void at;
  });

  it("send-now mails the summary any day, leaves lastSentAt alone, and reports a refusal", async () => {
    const [other] = await db.insert(companies).values({ name: "Other" }).returning();
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const tue = { t: new Date("2026-12-22T03:00:00Z") }; // a Tuesday, before 8
    const w = make(tue, sent);
    await expect(w.sendNow(other!.id)).rejects.toThrow(/Switch the weekly summary on/);
    await w.save(other!.id, { enabled: true, to: "me@example.com" });
    expect(await w.sendNow(other!.id)).toEqual({ to: "me@example.com" });
    expect(sent).toHaveLength(1);
    expect((await w.get(other!.id)).lastSentAt).toBeNull();
    // The Monday sweep still sends that week's email afterwards.
    expect(await make({ t: new Date("2026-12-28T09:00:00Z") }, sent).run(other!.id)).toBe(true);
    expect(sent).toHaveLength(2);
    await expect(make(tue, sent, false).sendNow(other!.id)).rejects.toThrow(/isn't set up/);
    const failing = weeklySummaryService(db, { send: async () => { throw new Error("down"); }, isConfigured: async () => true, localDayHour: () => ({ day: 2, hour: 3 }), now: () => tue.t });
    await expect(failing.sendNow(other!.id)).rejects.toThrow(/did not accept it: down/);
    expect(await w.companyExists(other!.id)).toBe(true);
    expect(await w.companyExists("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("groups merged tickets by feature and compares spend with the week before", () => {
    const w = weeklyText({ merged: [{ title: "A", feature: "Search" }, { title: "B", feature: "Search" }, { title: "C", feature: null }], spentMicros: 10_000_000, beforeMicros: 4_000_000, released: ["Search"], waiting: 0, oldestWaitingMs: null });
    expect(w.text).toContain("- Search: A; B");
    expect(w.text).toContain("- Other work: C");
    expect(w.text).toContain("Spent this week: $10.00 (the week before: $4.00, up $6.00)");
    expect(w.text).toContain("Features released: Search");
    expect(w.text).toContain("Cards still waiting for you: none");
    // Only counts, titles and dollars: no address, token or key.
    expect(w.text + w.subject).not.toMatch(/https?:\/\/|\d+\.\d+\.\d+\.\d+|token|password|secret|sk-/i);
  });
});

describe("in-app view (BOS-2390)", () => {
  it("gives the email's facts for this week and the 7 days before, without email set up", async () => {
    const [prior] = await db.insert(tickets).values({ companyId, projectId, title: "Ten days ago", number: 90, systemState: "done", mergedAt: new Date(NOW.getTime() - 10 * 24 * H) }).returning();
    await db.insert(costEvents).values({ fundingSourceId: sourceId, companyId, costMicros: 5_000_000, occurredAt: new Date(NOW.getTime() - 9 * 24 * H) });
    const w = weeklySummaryService(db, { send: async () => { throw new Error("no mail"); }, isConfigured: async () => false, localDayHour: () => ({ day: 1, hour: 9 }), now: () => NOW });
    const now = await w.view(companyId, "this");
    expect(now.merged.map((m) => m.title).sort()).toEqual(["Fresh", "Old"]);
    expect(now.merged.every((m) => !!m.id)).toBe(true);
    expect(now.spentMicros).toBe(17_000_000);
    expect(now.waiting).toBe(1);
    expect(now.text).toContain("Merged this week: 2 tickets");
    const last = await w.view(companyId, "last");
    expect(last.merged).toEqual([expect.objectContaining({ title: "Ten days ago", id: prior!.id })]);
    expect(last.spentMicros).toBe(5_000_000);
    expect(last.waiting).toBe(1);
    expect(last.text).toContain("Merged last week: 1 ticket");
  });
});
