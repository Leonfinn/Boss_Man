import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, notifications, reviewRequests, settings, ticketDependencies, tickets } from "../src/db/schema.js";
import { carriedTitles, waitedText } from "../src/services/merge-queue.js";
import { jammedRows, JAM_REMINDER_MS, mergeJamService } from "../src/services/merge-jam.js";

const HOUR = 3_600_000;
let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  let offset = 0;
  const clock = () => new Date(Date.parse("2026-11-08T12:00:00Z") + offset);
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const ticket = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string; number: number };
  const approve = (ticketId: string) => db.insert(reviewRequests).values({ ticketId, kind: "code", round: 1, status: "approved" });
  // An approved ticket in review that has waited `minutes`, ready to merge by itself.
  const waitingSince = async (title: string, minutes: number) => {
    const t = await ticket(title);
    await db.update(tickets).set({ systemState: "review", lastActivityAt: new Date(clock().getTime() - minutes * 60_000) }).where(eq(tickets.id, t.id));
    await approve(t.id);
    return t;
  };
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { mergeJam: { alerted: number; reminded: number; cleared: number } };
  const advance = (ms: number) => (offset += ms);
  // Every notification for the company, newest first.
  const allNotes = () => db.select().from(notifications).where(eq(notifications.companyId, company.id)).orderBy(desc(notifications.createdAt));
  return { ...built, db, close, req, company, project, ticket, approve, waitingSince, sweep, advance, clock, allNotes };
}

describe("merge line jam alert (BOS-766)", () => {
  it("names the carried tickets in the row, and reads a duration in plain words", async () => {
    expect(carriedTitles('Waiting: its branch also carries unapproved work from "A", "B" (medium risk), which must merge first.')).toEqual(["A", "B"]);
    expect(carriedTitles("Waiting: the check for other tickets' unmerged work didn't answer.")).toEqual([]);
    expect(carriedTitles(null)).toEqual([]);
    expect(waitedText(5)).toBe("5 min");
    expect(waitedText(70)).toBe("1 h 10 min");
    expect(waitedText(120)).toBe("2 h");
  });

  it("counts only long merge checks and stuck work Boss Man is meant to move", () => {
    const jam = jammedRows({
      running: [
        { what: "merge_check", overLimit: true } as never,
        { what: "agent_check", overLimit: true } as never,
        { what: "merge_check", overLimit: false } as never,
      ],
      waiting: [
        { stuck: true, actor: "system", decisionId: null } as never,
        { stuck: true, actor: "owner", decisionId: "d1" } as never,
        { stuck: true, actor: "agent", decisionId: null } as never,
        { stuck: false, actor: "system", decisionId: null } as never,
      ],
    });
    expect(jam.running).toHaveLength(1);
    expect(jam.waiting).toHaveLength(1);
  });

  it("shows approved work held by the carried-work guard as waiting for that ticket", async () => {
    const c = (ctx = await setup());
    const carried = await c.ticket("Ship the API");
    const held = await c.waitingSince("Build the page", 65);
    await c.db.update(tickets).set({ pullRequestNote: 'Waiting: its branch also carries unapproved work from "Ship the API" (medium risk), which must merge first.' }).where(eq(tickets.id, held.id));
    const data = (await c.req("GET", `/api/companies/${c.company.id}/merge-queue`)).json() as { waiting: Array<{ ticketId: string; state: string; label: string; next: string; stuck: boolean; carried?: Array<{ ref: string | null }> }> };
    const row = data.waiting.find((r) => r.ticketId === held.id)!;
    const carriedRef = row.carried?.[0]?.ref;
    expect(carriedRef).toMatch(/-[\d]+$/);
    expect(row.state).toBe("waiting_for_other_ticket");
    expect(row.label).toBe(`waiting for ${carriedRef} to merge first`);
    expect(row.next).toBe(`${carriedRef} has to be reviewed and merged first.`);
    expect(row.stuck).toBe(true);
  });

  it("sends one flag on the first sight of a jam, then one page an hour later, and never a third", async () => {
    const c = (ctx = await setup());
    const t = await c.waitingSince("Stuck behind a slot", 65);
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 1, reminded: 0, cleared: 0 });
    let sent = await c.allNotes();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ level: "flag", requested: "flag", link: `#/merge-queue/${c.company.id}` });
    expect(sent[0]!.title).toContain(`-${t.number}`);
    expect(sent[0]!.title).toContain("1 h 5 min");

    // A second pass while the jam is young, and after a restart, sends nothing.
    await c.sweep();
    expect(await c.allNotes()).toHaveLength(1);

    // An hour after the first alert: one page, and no more.
    c.advance(JAM_REMINDER_MS);
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 1, cleared: 0 });
    sent = await c.allNotes();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ level: "page", title: "Merges are still stuck" });
    c.advance(JAM_REMINDER_MS);
    await c.sweep();
    expect(await c.allNotes()).toHaveLength(2);
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
  });

  it("says merges are moving again and reads the jam alerts when the jam clears", async () => {
    const c = (ctx = await setup());
    const t = await c.waitingSince("Stuck behind a slot", 65);
    await c.sweep();
    // The line moves: the ticket merges, so nothing is jammed any more.
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 1 });
    const sent = await c.allNotes();
    expect(sent[0]).toMatchObject({ level: "note", title: "Merges are moving again" });
    expect(sent.slice(1).every((n) => n.readAt !== null)).toBe(true);
    // The all-clear went once; a following pass has nothing to say.
    await c.sweep();
    expect(await c.allNotes()).toHaveLength(2);
  });

  it("does not re-alert after a restart for the same jam, and starts a new episode once it has cleared", async () => {
    const c = (ctx = await setup());
    const t = await c.waitingSince("Stuck behind a slot", 65);
    await c.sweep();
    // The episode lives in settings, not memory: a fresh service on the same db (what a restart leaves)
    // finds it and sends nothing for the same jam.
    expect((await c.db.select().from(settings).where(eq(settings.key, `merge_jam:${c.company.id}`)))).toHaveLength(1);
    const restarted = mergeJamService(c.db, { view: (id) => c.mergeQueue.get(id), notify: (n) => c.notes.notify(n), now: c.clock });
    expect(await restarted.run()).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(await c.allNotes()).toHaveLength(1);

    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    await c.sweep();
    expect((await c.allNotes())[0]).toMatchObject({ title: "Merges are moving again" });
    // A new jam after the clear is a new episode: one fresh flag.
    await c.waitingSince("Jam again", 65);
    c.advance(JAM_REMINDER_MS);
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 1, reminded: 0, cleared: 0 });
    expect((await c.allNotes())[0]).toMatchObject({ level: "flag" });
  });

  it("leaves a jam a card already covers to the card", async () => {
    const c = (ctx = await setup());
    const t = await c.waitingSince("Waiting on a sign-off", 65);
    // An open sign-off card makes the row the card's: no jam alert (the card has its own notification).
    const [card] = await c.db.insert(decisions).values({ companyId: c.company.id, kind: "approval", question: "Sign this off?", options: ["Approve and merge"], recommendedOption: "Approve and merge", tier: "owner", dedupeKey: `risk-review:${t.id}`, context: { type: "risk_review", ticketId: t.id } }).returning({ id: decisions.id });
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: card!.id });
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(await c.allNotes()).toHaveLength(0);
  });

  it("raises nothing for a paused company", async () => {
    const c = (ctx = await setup());
    await c.waitingSince("Stuck in a paused company", 65);
    await c.db.update(companies).set({ paused: true }).where(eq(companies.id, c.company.id));
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(await c.allNotes()).toHaveLength(0);
  });
});
