import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ownerRepliesService } from "../src/services/owner-replies.js";
import type { RunnerCommand } from "@boss-man/shared";
import { DEFAULT_WATCHDOG } from "@boss-man/shared";
import { agents, companies, decisions, ownerReplies, runs, tickets, wakes } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
/** The setup for the current test; every test sets it in beforeEach, so the helpers can rely on it. */
const c = () => ctx!;

afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  let clock = new Date("2026-11-04T09:00:00Z");
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.role, "ceo")));
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  // The Scrum Master is a plain agent given the duty through Settings (as the owner does it); the
  // watchdog itself can stay off, since the stand-in ask does not need it.
  const sm = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Scrum Master" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  // A busy Scrum Master must not delay the ask, so the watchdog may stay off (a stalled-run alert
  // is the duty's; a message ask is not). The duty is what makes them the stand-in.
  expect((await req("PATCH", `/api/companies/${company.id}/watchdog`, { scrumMasterAgentId: sm.id })).statusCode).toBe(200);
  const ticket = (title: string, extra: { assigneeAgentId?: string } = {}) => db.insert(tickets).values({ companyId: company.id, projectId: project.id, title, systemState: "in_progress", assigneeAgentId: worker.id, ...extra }).returning().then((r) => r[0]!);
  const started = async (agentId: string) => (await db.insert(runs).values({ companyId: company.id, agentId, startedAt: clock, lastEventAt: clock }).returning())[0]!;
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  const open = async (ticketId: string) => db.select().from(ownerReplies).where(and(eq(ownerReplies.ticketId, ticketId), isNull(ownerReplies.clearedAt)));
  /**
   * Moves the test clock to just past the message's age. The marker's timestamp is the database's
   * (BOS-313), so a bare advance would put the test clock behind it; this waits for the row and
   * then moves past it.
   */
  const age = async (ticketId: string, minutes: number) => {
    const rows = await db.select({ at: ownerReplies.createdAt }).from(ownerReplies).where(eq(ownerReplies.ticketId, ticketId));
    const newest = Math.max(...rows.map((r) => r.at.getTime()));
    // After the first message, later ones are stored at the database's time (BOS-313), so move
    // past that too, or a message written just now would be aged by a clock still behind it.
    clock = new Date(Math.max(clock.getTime(), newest) + minutes * 60_000);
  };
  const state = async (ticketId: string) => (await req("GET", `/api/tickets/${ticketId}/messages`)).json().items as Array<{ author: string; text: string; replyState: string | null; replyReminders: number | null; replyClearedAt: string | null }>;
  return { ...built, db, close, req, company, ceo: ceo!, worker, sm, ticket, started, advance, age, open, state, sent, now: () => clock };
}

beforeEach(async () => {
  ctx = await setup();
});

/** A run is live on the ticket and took the owner's message into it. */
async function liveRunWithOwnerMessage() {
  const t = await c().ticket("Fix the footer");
  const run = await c().started(c().worker.id);
  await c().db.update(runs).set({ ticketId: t.id }).where(eq(runs.id, run.id));
  const sent = await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Use the brand blue" });
  expect(sent.json()).toMatchObject({ delivery: "live", runId: run.id });
  return { t, runId: run.id };
}

const wakesFor = (agentId: string, ticketId: string) => c().db.select().from(wakes).where(and(eq(wakes.agentId, agentId), eq(wakes.ticketId, ticketId)));

describe("an owner's message on a ticket waits for an answer (BOS-425)", () => {
  it("shows on the ticket that the message reached the running agent", async () => {
    const { t } = await liveRunWithOwnerMessage();
    expect((await c().state(t.id))[0]).toMatchObject({ author: "owner", replyState: "delivered", replyReminders: 0, replyClearedAt: null });
  });

  it("re-wakes the agent once when the run that took it live ends without a reply", async () => {
    const { t, runId } = await liveRunWithOwnerMessage();
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, runId));
    await c().db.delete(wakes);
    await c().ownerReplies.afterRunEnded(runId);
    expect(await wakesFor(c().worker.id, t.id)).toEqual([expect.objectContaining({ reason: "message", priority: 4, status: "queued" })]);
    // A second report of the same end (a retried event) wakes nobody twice.
    await c().ownerReplies.afterRunEnded(runId);
    expect(await wakesFor(c().worker.id, t.id)).toHaveLength(1);
    expect((await c().state(t.id))[0]!.replyReminders).toBe(1);
  });

  it("BOS-2632: a re-wake that fails is logged and its claim handed back, so it is sent later, once", async () => {
    const { t, runId } = await liveRunWithOwnerMessage();
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, runId));
    await c().db.delete(wakes);
    const logs: string[] = [];
    const failing = ownerRepliesService(c().db, {
      notify: async () => {
        throw new Error("wake insert failed");
      },
      alert: async () => null,
      now: c().now,
      log: (m) => logs.push(m),
    });
    expect(await failing.afterRunEnded(runId)).toBe(0);
    expect(logs.join("\n")).toContain("wake insert failed");
    expect((await c().state(t.id))[0]!.replyReminders).toBe(0);
    // The claim is free again: the next try (here the same end reported again; otherwise the five-minute sweep) wakes, once.
    expect(await c().ownerReplies.afterRunEnded(runId)).toBe(1);
    expect(await c().ownerReplies.afterRunEnded(runId)).toBe(0);
    expect(await wakesFor(c().worker.id, t.id)).toEqual([expect.objectContaining({ reason: "message", priority: 4 })]);
  });

  it("counts a run's closing message as the answer, so it is not re-woken for silence", async () => {
    const { t, runId } = await liveRunWithOwnerMessage();
    await c().db.delete(wakes);
    await c().ticketChat.onAgentMessage(runId, "Brand blue it is, the footer is done.");
    expect(await c().open(t.id)).toEqual([]);
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, runId));
    await c().ownerReplies.afterRunEnded(runId);
    expect(await wakesFor(c().worker.id, t.id)).toEqual([]);
  });

  it("clears the marker as soon as the agent replies, and does not re-wake it later", async () => {
    const { t, runId } = await liveRunWithOwnerMessage();
    await c().db.delete(wakes);
    await c().ticketChat.agentSays({ companyId: c().company.id, ticketId: t.id, agentId: c().worker.id, runId, text: "Brand blue it is. Details: changed the footer." });
    expect(await c().open(t.id)).toEqual([]);
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, runId));
    await c().ownerReplies.afterRunEnded(runId);
    expect(await wakesFor(c().worker.id, t.id)).toEqual([]);
  });

  it("wakes the target again at five minutes when nothing runs on the ticket, but never over a live run", async () => {
    const t = await c().ticket("Busy ticket");
    const first = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: t.id }).where(eq(runs.id, first.id));
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Use the brand blue" });
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, first.id));
    await c().db.delete(wakes);
    await c().age(t.id, 6);
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 1 });
    expect(await wakesFor(c().worker.id, t.id)).toEqual([expect.objectContaining({ reason: "woken by owner", priority: 3 })]);
    // A second sweep on the same message asks nobody again.
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 0 });

    // A live run on the ticket holds the five-minute re-wake back (the ten-minute ask, which is
    // not here yet at six minutes, is covered on its own below).
    const t2 = await c().ticket("Working ticket");
    const live = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: t2.id }).where(eq(runs.id, live.id));
    await c().req("POST", `/api/tickets/${t2.id}/messages`, { text: "One more thing" });
    await c().age(t2.id, 6);
    const pass = await c().ownerReplies.sweep();
    expect((await wakesFor(c().worker.id, t2.id)).filter((w) => w.reason === "woken by owner")).toEqual([]);
    expect(pass.rewoken).toBe(0);
  });

  it("shows a message to an agent busy on another ticket as queued behind that work", async () => {
    const t = await c().ticket("Waiting ticket");
    // The target is in a live run on a different ticket, so no slot on this one is free.
    const [other] = await c().db.insert(tickets).values({ companyId: c().company.id, projectId: (await c().db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, t.id)))[0]!.projectId, title: "Other work", systemState: "in_progress", assigneeAgentId: c().worker.id }).returning();
    const run = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: other!.id }).where(eq(runs.id, run.id));
    const sent = await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "When you have a moment" });
    expect(sent.json()).toMatchObject({ delivery: "queued" });
    expect((await c().state(t.id))[0]).toMatchObject({ author: "owner", replyState: "queued", replyReminders: 0, replyClearedAt: null });
  });

  it("has the CEO answer for a busy assignee after ten minutes, saying who has the ticket", async () => {
    const t = await c().ticket("Busy ticket");
    const run = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: t.id }).where(eq(runs.id, run.id));
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "How is the footer coming along?" });
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, run.id));
    await c().db.delete(wakes);
    // Another ticket has the agent busy: nothing runs on this one during the message's ten minutes.
    const elsewhere = await c().started(c().worker.id);
    expect(elsewhere.id).toBeDefined();
    // The five-minute pass offers the re-wake, which is still waiting behind the agent's other work.
    await c().age(t.id, 6);
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 1, standIns: 0 });
    await c().age(t.id, 5);
    expect(await c().ownerReplies.sweep()).toMatchObject({ standIns: 1 });
    const ask = (await c().db.select().from(wakes).where(eq(wakes.agentId, c().ceo.id))).find((w) => w.note?.includes("The owner wrote on"));
    expect(ask, "the CEO is asked to answer for the assignee").toBeDefined();
    expect(ask!.note).toContain("holds the ticket");
    expect(ask!.note).toContain("when they will get to it");
    // The ticket shows its state, and no card went to the owner.
    expect((await c().state(t.id))[0]).toMatchObject({ replyState: "delivered", replyReminders: 2, replyClearedAt: null });
    expect(await c().db.select().from(ownerReplies).where(eq(ownerReplies.ticketId, t.id))).toEqual([expect.objectContaining({ reminders: 2, standInAgentId: c().ceo.id })]);
  });

  it("still asks the CEO at ten minutes when the assignee is paused or retired", async () => {
    const t = await c().ticket("Paused agent");
    await c().db.delete(wakes);
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Are you getting to this?" });
    await c().db.update(agents).set({ paused: true }).where(eq(agents.id, c().worker.id));
    // Ten minutes pass in one go; the 5-minute re-wake is skipped for a paused agent, but it must
    // not stop the 10-minute ask.
    await c().age(t.id, 11);
    expect(await c().ownerReplies.sweep()).toMatchObject({ standIns: 1 });
    expect(await c().db.select().from(ownerReplies).where(eq(ownerReplies.ticketId, t.id))).toEqual([expect.objectContaining({ reminders: 2, standInAgentId: c().ceo.id })]);
    expect((await c().state(t.id))[0]).toMatchObject({ replyReminders: 2 });
  });

  it("still asks the CEO at ten minutes when the five-minute re-wake was never sent (a live run)", async () => {
    const t = await c().ticket("Silent live run");
    const run = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: t.id }).where(eq(runs.id, run.id));
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Use the brand blue" });
    await c().db.delete(wakes);
    // The run is still live past ten minutes: no 5-minute re-wake (a working run isn't interrupted),
    // but the ask must go out, with reminders staying 0 until it does.
    await c().age(t.id, 11);
    expect((await c().open(t.id))[0]).toMatchObject({ reminders: 0 });
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 0, standIns: 1 });
    expect((await c().state(t.id))[0]).toMatchObject({ replyReminders: 2 });
  });

  it("asks the CEO to answer when the CEO holds the ticket, and the ask never goes to the owner", async () => {
    const t = await c().ticket("Ask the CEO");
    // With the watchdog off the Scrum Master's rung skips (BOS-762 turns it on by default; this test
    // is about the ask reaching the CEO, not the watchdog), so the stand-in ask starts climbing.
    await c().db.update(companies).set({ watchdog: { ...DEFAULT_WATCHDOG, enabled: false } }).where(eq(companies.id, c().company.id));
    await c().db.delete(wakes);
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Is this worth doing?", agentId: c().ceo.id });
    // Ten minutes pass in one go: the re-wake and the ask are both due in the same sweep, each on
    // its own age check, so the ask never waits on the re-wake.
    await c().age(t.id, 11);
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 1, standIns: 1 });
    // The ask starts on the Scrum Master's rung (the CEO's own rung would refuse itself), and with the
    // watchdog off that rung skips, so the ladder climbs to the CEO: never the owner, who would have to
    // answer for the CEO.
    const card = (await c().db.select().from(decisions).where(eq(decisions.dedupeKey, `owner-reply:${(await c().open(t.id))[0]!.id}`)))[0];
    expect(card, "the ask is a card").toBeDefined();
    expect(card!.question).toContain("holds the ticket");
    expect(card!.question).toContain("when they will get to it");
    expect(card!.tier).toBe("ceo");
    expect((card!.context as { ladder: { rung: string } }).ladder.rung).toBe("ceo");
  });

  it("takes the CEO's answer as the answer even though the message was for someone else", async () => {
    const t = await c().ticket("Busy ticket");
    const run = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: t.id }).where(eq(runs.id, run.id));
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "How is the footer coming along?" });
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, run.id));
    await c().db.delete(wakes);
    const elsewhere = await c().started(c().worker.id);
    await c().age(t.id, 6);
    await c().ownerReplies.sweep();
    await c().age(t.id, 5);
    await c().ownerReplies.sweep();
    // The stand-in posts through its own run; the marker is what is checked here.
    await c().ticketChat.agentSays({ companyId: c().company.id, ticketId: t.id, agentId: c().ceo.id, runId: elsewhere.id, text: "Engineer has it and will look after their current task. Details: answered for them." });
    expect(await c().open(t.id)).toEqual([]);
    expect((await c().state(t.id))[0]).toMatchObject({ replyReminders: 2 });
  });
  it("words a 90-minute wait as \"90 minutes\", never \"1 hours\" (BOS-887)", async () => {
    const t = await c().ticket("Checkout error states");
    // A live run takes the message, then ends; no sweep runs yet, so the first sweep sees the message 90 minutes old.
    const run = await c().started(c().worker.id);
    await c().db.update(runs).set({ ticketId: t.id }).where(eq(runs.id, run.id));
    await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Any update on the checkout copy?" });
    await c().db.update(runs).set({ endedAt: c().now() }).where(eq(runs.id, run.id));
    await c().db.delete(wakes);
    await c().age(t.id, 90);
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 1 });
    const note = (await wakesFor(c().worker.id, t.id)).find((w) => w.reason === "woken by owner")?.note;
    expect(note, "the agent is told how long the message has waited").toContain("90 minutes");
    expect(note).not.toContain("1 hours");
  });

  it("keeps a message to an unassigned ticket as a note: nobody is chased", async () => {
    const t = await c().ticket("Nobody on it", { assigneeAgentId: undefined });
    await c().db.delete(wakes);
    const sent = await c().req("POST", `/api/tickets/${t.id}/messages`, { text: "Is this still needed?" });
    expect(sent.json()).toMatchObject({ delivery: "unassigned" });
    c().advance(11);
    expect(await c().ownerReplies.sweep()).toMatchObject({ rewoken: 0, standIns: 0 });
    expect(await c().db.select().from(wakes)).toEqual([]);
  });
});
