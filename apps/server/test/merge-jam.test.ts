import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions, notifications, reviewRequests, settings, ticketDependencies, tickets } from "../src/db/schema.js";
import { carriedNoteText, carriedTitles, waitedText } from "../src/services/merge-queue.js";
import { JAM_REMINDER_MS, mergeJamService } from "../src/services/merge-jam.js";

const HOUR = 3_600_000;

// The jam sweep's own view, driven by a fake screen so a running merge check can be simulated without a runner.
function fakeService(db: never, view: { current: unknown }, clock: () => Date) {
  const sent: Array<{ companyId: string; level: string; title: string; body: string; link: string; id: string }> = [];
  let n = 0;
  const service = mergeJamService(db, {
    view: async () => view.current as never,
    notify: async (input) => {
      const row = { ...input, id: `n${++n}` };
      sent.push(row);
      // The fake keeps the asked-for level: no quiet hours or cap here, so delivered is as asked.
      return { id: row.id, level: row.level };
    },
    now: clock,
  });
  return { service, sent };
}
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
  // Put the owner in quiet hours around the test's noon clock, so a flag is held back to a feed note.
  const quietNow = async (on = true) => built.notes.setSettings({ ...(await built.notes.getSettings()), quietHours: on ? { start: "11:00", end: "13:00", timeZone: "UTC" } : null });
  return { ...built, db, close, req, company, project, ticket, approve, waitingSince, sweep, advance, clock, allNotes, quietNow };
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

  it("reads a carried title with quotes and an apostrophe in full, from the titles kept apart from the sentence (BOS-819)", async () => {
    // The note the gate writes now: the owner's sentence first, then the titles exactly as they are.
    const withQuotes = [`Fix the "login" bug`, `Don't touch the owner's settings`];
    const note = `Waiting: its branch also carries unapproved work from "Fix the "login" bug", "Don't touch the owner's settings" (medium risk), which must merge first.\n${JSON.stringify(withQuotes)}`;
    expect(carriedTitles(note)).toEqual(withQuotes);
    expect(carriedNoteText(note)).toBe('Waiting: its branch also carries unapproved work from "Fix the "login" bug", "Don\'t touch the owner\'s settings" (medium risk), which must merge first.');
    // A note from before the titles were kept apart is still read, best effort, and its prose is kept whole.
    const old = 'Waiting: its branch also carries unapproved work from "Ship the API" (medium risk), which must merge first.';
    expect(carriedTitles(old)).toEqual(["Ship the API"]);
    expect(carriedNoteText(old)).toBe(old);
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

  it("shows the full title of a carried ticket whose title has a double quote and an apostrophe (BOS-819)", async () => {
    const c = (ctx = await setup());
    const title = `Fix the "login" bug and don't break the owner's links`;
    const carried = await c.ticket(title);
    const held = await c.waitingSince("Build the page", 65);
    // The note the gate writes now keeps the titles on their own last line, exactly as they are.
    await c.db.update(tickets).set({ pullRequestNote: `Waiting: its branch also carries unapproved work from "${title}" (medium risk), which must merge first.\n${JSON.stringify([title])}` }).where(eq(tickets.id, held.id));
    const data = (await c.req("GET", `/api/companies/${c.company.id}/merge-queue`)).json() as { waiting: Array<{ ticketId: string; title: string; carried?: Array<{ ticketId: string | null; ref: string | null; title: string }> }> };
    const row = data.waiting.find((r) => r.ticketId === held.id)!;
    const [hold] = row.carried ?? [];
    expect(hold).toMatchObject({ ticketId: carried.id, title });
    expect(hold!.ref).toMatch(/-[\d]+$/);
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

  it("sends no all-clear for a jam whose first flag was held back by quiet hours (BOS-819)", async () => {
    const c = (ctx = await setup());
    // Quiet hours make the first alert a plain feed note: the owner was never told above the feed.
    await c.quietNow();
    const t = await c.waitingSince("Stuck behind a slot", 65);
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 1, reminded: 0, cleared: 0 });
    let sent = await c.allNotes();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requested: "flag", level: "note", demotedBy: "quiet hours" });
    // The jam clears before anything louder reached the owner: no "Merges are moving again" for a jam they never heard of.
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 1 });
    sent = await c.allNotes();
    expect(sent.map((n) => n.title)).not.toContain("Merges are moving again");
    // The episode is gone, so a new jam starts afresh.
    expect(await c.db.select().from(settings).where(eq(settings.key, `merge_jam:${c.company.id}`))).toHaveLength(0);
  });

  it("still sends the one all-clear when the jam cleared after the reminder reached the owner (BOS-819)", async () => {
    const c = (ctx = await setup());
    // Quiet hours hold the first flag back, but an hour later the reminder is a page: quiet hours only lower it a step, to a flag.
    await c.quietNow();
    const t = await c.waitingSince("Stuck behind a slot", 65);
    await c.sweep();
    c.advance(JAM_REMINDER_MS);
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 1, cleared: 0 });
    const reminded = (await c.allNotes())[0]!;
    expect(reminded).toMatchObject({ requested: "page", title: "Merges are still stuck" });
    expect(["flag", "page", "ask"]).toContain(reminded.level);
    // Now the owner has been told, so the all-clear goes.
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, t.id));
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 1 });
    expect((await c.allNotes())[0]).toMatchObject({ level: "note", title: "Merges are moving again" });
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

  it("alerts a long merge check once, pages once an hour later, and never a third time", async () => {
    const c = (ctx = await setup());
    let t = c.clock().getTime();
    const view = {
      current: {
        companyId: c.company.id,
        mode: "server",
        slots: 1,
        recent: [],
        waitingCount: 0,
        running: [{ ticketId: "x", ref: "BOS-9", title: "The big merge", phase: "checking", startedAt: new Date(t - 65 * 60_000).toISOString(), startedBy: "you", minutes: 65, what: "merge_check", slot: 1, overLimit: true }],
        waiting: [],
      },
    };
    const clock = () => new Date(t);
    const { service, sent } = fakeService(c.db as never, view, clock);
    expect(await service.run()).toEqual({ alerted: 1, reminded: 0, cleared: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ level: "flag", link: `#/merge-queue/${c.company.id}` });
    expect(sent[0]!.title).toContain("BOS-9");
    expect(sent[0]!.title).toContain("1 h 5 min");
    // Still running an hour on: one page, then silence however long it runs.
    t += JAM_REMINDER_MS;
    expect(await service.run()).toEqual({ alerted: 0, reminded: 1, cleared: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ level: "page", title: "Merges are still stuck" });
    t += 4 * HOUR;
    expect(await service.run()).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(sent).toHaveLength(2);
  });

  it("counts no jam for work held on a sign-off, a card or an agent fix", async () => {
    const c = (ctx = await setup());
    const t = c.clock().getTime();
    const row = (over: Record<string, unknown>) => ({ ticketId: "y", ref: "BOS-10", title: "Held work", minutes: 90, risk: "medium", urgent: false, failedCheck: false, state: "waiting_for_sign_off", label: "waiting for your sign-off", stuck: true, next: null, actor: "owner", decisionId: "d1", ...over });
    const view = {
      current: {
        companyId: c.company.id,
        mode: "server",
        slots: 1,
        recent: [],
        waitingCount: 3,
        running: [],
        waiting: [
          row({}),
          row({ actor: "ceo", state: "waiting_for_decision", decisionId: "d2" }),
          row({ actor: "agent", state: "check_failed_retrying", decisionId: null }),
        ],
      },
    };
    const { service, sent } = fakeService(c.db as never, view, () => new Date(t));
    expect(await service.run()).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(sent).toHaveLength(0);
  });

  it("raises nothing for a paused company", async () => {
    const c = (ctx = await setup());
    await c.waitingSince("Stuck in a paused company", 65);
    await c.db.update(companies).set({ paused: true }).where(eq(companies.id, c.company.id));
    expect((await c.sweep()).mergeJam).toEqual({ alerted: 0, reminded: 0, cleared: 0 });
    expect(await c.allNotes()).toHaveLength(0);
  });

  it("tells the CEO once about a card holding an approved merge that names a done ticket (BOS-1078)", async () => {
    const c = (ctx = await setup());
    const t = await c.waitingSince("Held by an old card", 5);
    const done = await c.ticket("What the card asked for");
    await c.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, done.id));
    const [co] = await c.db.select({ prefix: companies.ticketPrefix }).from(companies).where(eq(companies.id, c.company.id));
    const card = await c.decisions.raise({ companyId: c.company.id, agentId: null, question: `Wait for ${co!.prefix}-${done.number} first?`, options: ["Yes", "No"], recommended: "Yes", blocksTicketId: t.id, holdsMerge: true, triedFirst: "Checked the other ticket" });
    // A plain card naming the same done ticket holds nothing, so it isn't flagged.
    await c.decisions.raise({ companyId: c.company.id, agentId: null, question: `Is ${co!.prefix}-${done.number} live?`, options: ["Yes", "No"], recommended: "Yes", blocksTicketId: (await c.waitingSince("Not held", 5)).id, triedFirst: "Checked" });
    const told: Array<{ companyId: string; ticketId: string; note: string }> = [];
    const service = mergeJamService(c.db, { view: (id) => c.mergeQueue.get(id), notify: async () => null, tellCeo: async (input) => void told.push(input), now: c.clock });
    await service.run();
    await service.run();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ companyId: c.company.id, ticketId: t.id });
    expect(told[0]!.note).toContain(card.id);
    expect(told[0]!.note).toContain(`It names ${co!.prefix}-${done.number}, which is done now`);
  });
});
