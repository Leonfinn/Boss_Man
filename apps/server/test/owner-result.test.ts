// BOS-2555: when the owner answers a card that asked them for information (a log, a screenshot, a value), the result and the
// next step reach them where they are (a chat line and a feed flag), without them asking; and if no result comes within 30
// minutes, the CEO is woken to post it.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, notifications, ownerChatMessages, runs, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { infoAskOf, INFO_ASK_MINUTES, noteResultReported, ownContentOf } from "../src/services/owner-result.js";
import { notificationsService } from "../src/services/notifications.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Dougal" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const ticket = (title: string) => db.insert(tickets).values({ companyId: company.id, projectId: project.id, title, systemState: "in_progress", assigneeAgentId: dev.id, stateNote: "Working on it.", stateNoteAt: new Date() }).returning().then((r) => r[0]!);
  const card = async (t: { id: string }, question: string) =>
    (
      await db
        .insert(decisions)
        .values({ companyId: company.id, kind: "question", question, options: ["Sent it"], recommendedOption: "Sent it", raisedByAgentId: dev.id, tier: "owner", context: { type: "question", ticketId: t.id } })
        .returning()
    )[0]!;
  const chatLines = async () => (await req("GET", `/api/companies/${company.id}/chat`)).json().items as Array<{ role: string; text: string }>;
  const flags = () => db.select().from(notifications).where(eq(notifications.companyId, company.id));
  /** The owner's feed, as the server's own notify would send it (no phone, no fetch). */
  const notify = (n: { companyId: string | null; agentId?: string | null; level: "note" | "flag" | "page" | "ask"; title: string; body?: string | null; link: string }) => notificationsService(db, { reveal: () => Promise.resolve(null) }).notify(n);
  const dueCount = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0]!.infoAskDueAt;
  return { ...built, db, req, company, ceo, dev, project, sent, ticket, card, chatLines, flags, notify, dueCount };
}

describe("which cards ask the owner for information", () => {
  const base = { kind: "question" as const, context: { type: "question" } };
  it("a pasted log, a screenshot or a value is one", () => {
    expect(infoAskOf({ ...base, question: "Please paste the deploy log from the failed update." })).not.toBeNull();
    expect(infoAskOf({ ...base, question: "Can you send me a screenshot of the Settings page?" })).not.toBeNull();
    expect(infoAskOf({ ...base, question: "What does the terminal show when you run it?" })).not.toBeNull();
    expect(infoAskOf({ ...base, question: "Reply with the commit hash you see on the Updates page." })).not.toBeNull();
  });
  it("an approval, a choice, or a card with steps for the owner is not", () => {
    expect(infoAskOf({ ...base, question: "Shall I deploy the fix now?" })).toBeNull();
    expect(infoAskOf({ ...base, question: "Which do you prefer: blue or green?" })).toBeNull();
    expect(infoAskOf({ ...base, question: "Please send me a screenshot", context: { type: "question", ownerMustDo: true, steps: ["Open the app"] } })).toBeNull();
    expect(infoAskOf({ ...base, kind: "permission", question: "Please paste the log" })).toBeNull();
  });
  it("a plain question about what the product does is not a request for information", () => {
    expect(infoAskOf({ ...base, question: "What do you show on the dashboard?" })).toBeNull();
    expect(infoAskOf({ ...base, question: "What should the settings page say?" })).toBeNull();
  });
});

describe("BOS-2593: which answers carry the owner's own content", () => {
  const pic = "![shot](/api/ticket-images/0b7e3f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b)";
  const steps = { kind: "question" as const, raisedByAgentId: "a1", options: ["Done", "Not now"], context: { type: "question", ownerMustDo: true, steps: ["Open it", "Press Publish"] } };
  it("a picture, a note, or words beyond the buttons count, on a steps card too", () => {
    expect(ownContentOf(steps, `Done ${pic}`, { custom: true })).toContain("picture");
    expect(ownContentOf(steps, "Done", { note: `see ${pic}` })).toContain("picture");
    expect(ownContentOf(steps, "Done", { note: "step 4 showed an error" })).toContain("note");
    expect(ownContentOf(steps, "I think step 4 failed", { custom: true })).toContain("own words");
  });
  it("a button press, a blank note, or a typed copy of an option does not", () => {
    expect(ownContentOf(steps, "Done", {})).toBeNull();
    expect(ownContentOf(steps, "Done", { note: "  \n " })).toBeNull();
    expect(ownContentOf(steps, " Not now ", { custom: true })).toBeNull();
  });
  it("a permission card, a card Boss Man raised itself, or another card type is left out", () => {
    expect(ownContentOf({ ...steps, kind: "permission", context: { type: "permission" } }, "Allow", { note: "only this once" })).toBeNull();
    expect(ownContentOf({ ...steps, raisedByAgentId: null }, "Done", { note: "step 4 failed" })).toBeNull();
    expect(ownContentOf({ ...steps, context: { type: "rule_proposal" } }, "Add it", { note: "but narrower" })).toBeNull();
  });
});

describe("BOS-2555: an information answer reaches the owner", () => {
  it("puts a line and a flag in front of them at the answer, and wakes the raiser to report back", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    const res = await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it", note: "Full log pasted" });
    expect(res.statusCode).toBe(200);
    const lines = (await c.chatLines()).filter((l) => l.role === "system");
    expect(lines.some((l) => l.text.includes("your answer to") && l.text.includes("Dougal"))).toBe(true);
    expect((await c.flags()).some((n) => n.level === "flag" && n.title.includes("Dougal"))).toBe(true);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.infoAskWhy).not.toBeNull();
    expect(after!.infoAskDueAt).not.toBeNull();
    const w = await c.db.select().from(wakes).where(eq(wakes.agentId, c.dev.id));
    expect(w.some((x) => x.reason === "decision answered" && x.note?.includes("report back"))).toBe(true);
  });

  it("a normal question card does not schedule a result", async () => {
    const c = await setup();
    const t = await c.ticket("Pick a colour");
    const d = await c.card(t, "Which colour do you prefer: blue or green?");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    expect(await c.dueCount(d.id)).toBeNull();
    expect((await c.chatLines()).filter((l) => l.text.includes("your answer to"))).toEqual([]);
  });

  // BOS-2593 (DR-076 B): the 25 Nov case. A release steps card answered "I think step 4 failed" with a screenshot got nothing back.
  it("a steps card answered in the owner's own words with a picture starts the loop: line, flag, deadline and report-back note", async () => {
    const c = await setup();
    const t = await c.ticket("Release beta.2");
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Release beta.2: follow the steps, then press Done.", options: ["Done", "Not now"], recommendedOption: "Done", raisedByAgentId: c.dev.id, tier: "owner", context: { type: "question", ticketId: t.id, ownerMustDo: true, steps: ["Open the Releases page", "Press Publish", "Wait for the build", "Check the download works"] } })
      .returning();
    const answer = "I think step 4 failed ![screenshot](/api/ticket-images/0b7e3f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b)";
    const res = await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer, custom: true });
    expect(res.statusCode).toBe(200);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d!.id));
    expect(after!.infoAskWhy).toContain("picture");
    expect(after!.infoAskDueAt).not.toBeNull();
    expect((await c.chatLines()).some((l) => l.role === "system" && l.text.includes("your answer to") && l.text.includes("Dougal"))).toBe(true);
    expect((await c.flags()).some((n) => n.level === "flag" && n.title.includes("Dougal"))).toBe(true);
    const w = await c.db.select().from(wakes).where(eq(wakes.agentId, c.dev.id));
    expect(w.some((x) => x.reason === "decision answered" && x.note?.includes("report back") && x.note.includes("open_attachment"))).toBe(true);
  });

  it("a note on an ordinary card starts the loop; a plain button press does not", async () => {
    const c = await setup();
    const t = await c.ticket("Pick a colour");
    const noted = await c.card(t, "Which colour do you prefer: blue or green?");
    await c.req("POST", `/api/decisions/${noted.id}/answer`, { answer: "Sent it", note: "Blue, but the header looked broken on my phone" });
    expect(await c.dueCount(noted.id)).not.toBeNull();
    const plain = await c.card(t, "Shall I deploy the fix now?");
    await c.req("POST", `/api/decisions/${plain.id}/answer`, { answer: "Sent it", note: "   " });
    expect(await c.dueCount(plain.id)).toBeNull();
  });

  it("the raiser's status-only reply on the ticket is posted into the owner's chat, and the deadline clears", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    expect(await c.dueCount(d.id)).not.toBeNull();
    const posted = await noteResultReported(c.db, { companyId: c.company.id, ticketId: t.id, agentId: c.dev.id, text: "The deploy failed because the runner image pin was stale; redeploying now, nothing for you to do." }, { notify: c.notify });
    expect(posted).toBe(true);
    const chat = await c.chatLines();
    expect(chat.some((l) => l.text.includes("Dougal checked what you sent") && l.text.includes("nothing for you to do"))).toBe(true);
    expect(await c.dueCount(d.id)).toBeNull();
    // A second reply for the same card does not post a second result: the deadline is already cleared, so it posts nothing.
    const lines = (await c.chatLines()).length;
    await noteResultReported(c.db, { companyId: c.company.id, ticketId: t.id, agentId: c.dev.id, text: "again" }, { notify: c.notify });
    expect((await c.chatLines()).length).toBe(lines);
  });

  it("after 30 minutes with no result, the CEO is woken and the owner is told who is on it", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    await c.db.update(decisions).set({ infoAskDueAt: new Date(Date.now() - 60_000) }).where(eq(decisions.id, d.id));
    const before = (await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).map((w) => w.id);
    await c.sweeps.run();
    const ceoWakes = (await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).filter((w) => !before.includes(w.id));
    expect(ceoWakes.some((w) => w.reason === "a result for the owner" && w.ticketId === t.id && (w.note ?? "").includes("Post the result"))).toBe(true);
    const chat = await c.chatLines();
    expect(chat.some((l) => l.text.includes("hasn't reported the result") && l.text.includes("asked"))).toBe(true);
    expect((await c.flags()).some((n) => n.level === "flag" && n.title.includes("No result yet"))).toBe(true);
    expect(await c.dueCount(d.id)).toBeNull();
    // A second sweep asks nobody again.
    const ids = (await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).length;
    await c.sweeps.run();
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).length).toBe(ids);
  });

  it("no CEO wake when the result was posted in time, and none for a card still inside its window", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    await noteResultReported(c.db, { companyId: c.company.id, ticketId: t.id, agentId: c.dev.id, text: "The fix is a redeploy; nothing for you to do." }, { notify: c.notify });
    await c.sweeps.run();
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).some((w) => w.reason === "a result for the owner")).toBe(false);
    const t2 = await c.ticket("Second failure");
    const d2 = await c.card(t2, "Paste the second log too.");
    await c.req("POST", `/api/decisions/${d2.id}/answer`, { answer: "Sent it" });
    expect(INFO_ASK_MINUTES).toBe(30);
    await c.sweeps.run();
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).some((w) => w.reason === "a result for the owner" && w.ticketId === t2.id)).toBe(false);
  });

  it("a result said only in the owner's chat clears the deadline, so nobody is woken", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    // The raiser says the result in the owner's chat instead of on the ticket (the note allows either).
    await c.db.insert(ownerChatMessages).values({ companyId: c.company.id, agentId: c.dev.id, role: "assistant", text: `Your answer showed a stale runner image. The result: it was rebuilt and the update went through, nothing to do. (ticket ${t.title})` });
    await c.db.update(decisions).set({ infoAskDueAt: new Date(Date.now() - 60_000) }).where(eq(decisions.id, d.id));
    await c.sweeps.run();
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).some((w) => w.reason === "a result for the owner")).toBe(false);
    expect(await c.dueCount(d.id)).toBeNull();
  });

  it("an interim 'checking now' reply clears nothing: the deadline stays, and the CEO is still woken", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    const posted = await noteResultReported(c.db, { companyId: c.company.id, ticketId: t.id, agentId: c.dev.id, text: "Thanks, checking now, back shortly." }, { notify: c.notify });
    expect(posted).toBe(false);
    expect(await c.dueCount(d.id)).not.toBeNull();
    expect((await c.chatLines()).some((l) => l.text.includes("Dougal checked what you sent"))).toBe(false);
    await c.db.update(decisions).set({ infoAskDueAt: new Date(Date.now() - 60_000) }).where(eq(decisions.id, d.id));
    await c.sweeps.run();
    expect((await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).some((w) => w.reason === "a result for the owner")).toBe(true);
  });

  it("a card with no ticket of its own still wakes the CEO, with no dead ticket link, and a reply on a ticket fills it", async () => {
    const c = await setup();
    // A card raised about no ticket at all (context has no ticketId).
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: "Please paste the error you see on the login page.", options: ["Sent it"], recommendedOption: "Sent it", raisedByAgentId: c.dev.id, tier: "owner", context: { type: "question" } })
      .returning();
    await c.req("POST", `/api/decisions/${d!.id}/answer`, { answer: "Sent it" });
    await c.db.update(decisions).set({ infoAskDueAt: new Date(Date.now() - 60_000) }).where(eq(decisions.id, d!.id));
    await c.sweeps.run();
    const wake = (await c.db.select().from(wakes).where(eq(wakes.agentId, c.ceo.id))).find((w) => w.reason === "a result for the owner");
    expect(wake).toBeTruthy();
    expect(wake!.ticketId ?? null).toBeNull();
    expect(wake!.note ?? "").not.toContain("#/tickets/undefined");
    expect(wake!.note ?? "").toContain("Post the result");
  });

  it("with no CEO, the deadline is kept rather than the result lost silently", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    await c.db.update(agents).set({ role: "manager" }).where(eq(agents.id, c.ceo.id));
    await c.db.update(decisions).set({ infoAskDueAt: new Date(Date.now() - 60_000) }).where(eq(decisions.id, d.id));
    await c.sweeps.run();
    expect(await c.dueCount(d.id)).not.toBeNull();
  });
});

describe("BOS-2555: the record it keeps", () => {
  it("the answer line and the deadline are kept per card, so one card never borrows another's result", async () => {
    const c = await setup();
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    const lines = await c.db.select().from(ownerChatMessages).where(eq(ownerChatMessages.infoAskCardId, d.id));
    expect(lines.length).toBe(1);
    expect(lines[0]!.role).toBe("system");
  });

  it("the raiser's ticket_reply with notAnAsk on the card's ticket posts the result into the owner's chat (the MCP route)", async () => {
    const c = await setup();
    await c.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `127.0.0.1:${(c.app.server.address() as { port: number }).port}`;
    const t = await c.ticket("Find the deploy failure");
    const d = await c.card(t, "Please paste the deploy log from the failed update.");
    await c.req("POST", `/api/decisions/${d.id}/answer`, { answer: "Sent it" });
    const runId = (await c.db.insert(runs).values({ companyId: c.company.id, agentId: c.dev.id, ticketId: t.id, model: "m", startedAt: new Date() }).returning())[0]!.id;
    const token = await issueRunToken(c.db, { companyId: c.company.id, agentId: c.dev.id, runId });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const r = await client.callTool({ name: "ticket_reply", arguments: { ticketId: t.id, text: "The deploy log shows a stale runner image; redeploying now, nothing for you to do.", notAnAsk: true } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    await client.close();
    const chatIn = (await c.req("GET", `/api/companies/${c.company.id}/chat?agentId=${c.ceo.id}`)).json().items as Array<{ role: string; text: string }>;
    expect(chatIn.some((l) => l.text.includes("Dougal checked what you sent") && l.text.includes("nothing for you to do"))).toBe(true);
    expect(await c.dueCount(d.id)).toBeNull();
  });
});
