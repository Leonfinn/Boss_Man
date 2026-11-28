// BOS-2854: notes the code appends under an agent's reply never come back to an agent in a prompt.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { ownerChatMessages, runners, ticketMessages, tickets } from "../src/db/schema.js";
import { doneInThisReply } from "../src/services/chat.js";
import { stripCodeNotes } from "../src/services/reply-notes.js";
import { missingPageNote } from "../src/services/wiki.js";
import { ownerTextReceiptRefusal } from "../src/services/host-fact-gate.js";
import { conversationLines } from "../src/services/ticket-chat.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});
type Start = Extract<RunnerCommand, { type: "run.start" }>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const sent: RunnerCommand[] = [];
  built.runners.connect(runner!.id, (c) => (sent.push(c), true));
  return { ...built, db, req, company, ceo, project, sent };
}

/** Each shape of note the code adds, built by the real function that adds it. */
async function realNotes(c: Awaited<ReturnType<typeof setup>>) {
  const made = (await doneInThisReply(c.db, "00000000-0000-4000-8000-000000000001", "Sent.")) as string;
  const wiki = (await missingPageNote(c.db, c.company.id, "See [[no-such-page-here]]")) as string;
  const receipt = `${ownerTextReceiptRefusal("Google accepted the sitemap.")}`.replace(/^Not sent\. /, "Boss Man check: ");
  const ticketLink = `Ticket link check: this ticket link is to a ticket this run didn't create or read: #/tickets/00000000-0000-4000-8000-000000000002. Check the id, or read the ticket with tickets. The text was saved as written.`;
  const youSaid = 'You said "Add SSO", 2026-11-01, about the SSO ticket, and keep it short.';
  return { made, wiki, receipt, ticketLink, youSaid };
}

describe("stripCodeNotes", () => {
  it("leaves a reply with no note alone and keeps its paragraphs", () => {
    expect(stripCodeNotes("First.\n\nSecond.")).toBe("First.\n\nSecond.");
  });

  it("removes each note shape the code adds, built by its real function, and keeps the reply", async () => {
    const c = await setup();
    const n = await realNotes(c);
    expect(n.made).toMatch(/^No changes made in this reply\./);
    expect(n.wiki).toMatch(/^Wiki link check: /);
    expect(n.receipt).toMatch(/^Boss Man check: /);
    for (const note of Object.values(n)) expect(stripCodeNotes(`I did it.\n\n${note}`)).toBe("I did it.");
    expect(stripCodeNotes(`I did it.\n\n${n.wiki}\n\n${n.made}\n\n${n.receipt}`)).toBe("I did it.");
    expect(stripCodeNotes("Done in this reply: made a ticket.\n\nShort answer.")).toBe("Short answer.");
  });
});

describe("replays", () => {
  it("the CEO's chat prompt shows its earlier replies without the notes under them", async () => {
    const c = await setup();
    const n = await realNotes(c);
    await c.db.insert(ownerChatMessages).values([
      { companyId: c.company.id, agentId: c.ceo.id, role: "owner", text: "Please tidy up." },
      { companyId: c.company.id, agentId: c.ceo.id, role: "assistant", text: `Tidied.\n\n${n.made}\n\n${n.wiki}\n\n${n.receipt}\n\n${n.ticketLink}\n\n${n.youSaid}` },
    ]);
    await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Thanks, anything else?" });
    await c.scheduler.tick();
    const prompt = c.sent.filter((x): x is Start => x.type === "run.start").filter((x) => x.agentId === c.ceo.id).at(-1)!.prompt;
    expect(prompt).toContain("You: Tidied.");
    for (const bit of ["Done in this reply", "No changes made in this reply", "Wiki link check", "Boss Man check", "Ticket link check", "You said"]) expect(prompt).not.toContain(bit);
  });

  it("a ticket's conversation gives an agent's earlier words back without the notes, and leaves the owner's words as typed", async () => {
    const c = await setup();
    const n = await realNotes(c);
    const [t] = await c.db.insert(tickets).values({ companyId: c.company.id, projectId: c.project.id, title: "T" }).returning({ id: tickets.id });
    await c.db.insert(ticketMessages).values([
      { companyId: c.company.id, ticketId: t!.id, author: "agent", agentId: c.ceo.id, text: `Looked into it.\n\n${n.made}\n\n${n.wiki}`, delivery: "end_of_run" },
      { companyId: c.company.id, ticketId: t!.id, author: "owner", text: "Done in this reply: I typed this myself." },
    ]);
    const talk = (await conversationLines(c.db, t!.id)).join("\n");
    expect(talk).toContain("Looked into it.");
    expect(talk).not.toContain("No changes made in this reply");
    expect(talk).not.toContain("Wiki link check");
    expect(talk).toContain("Owner: Done in this reply: I typed this myself.");
  });
});
