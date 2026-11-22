// BOS-1318: an agent's raise_decision card goes to the CEO first, and stays on the owner's queue only when it
// needs the owner (a fixed ownerOnly list, ownerMustDo or steps). These go through the real MCP tool, as an agent calls it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, companies, decisions, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { ceoAnswerRefusal, CEO_QUESTION_HANDOVER_MINUTES, OWNER_ONLY_KINDS, routeAgentCard } from "../src/services/decisions.js";
import { phoneApprovable } from "../src/services/phone-approve.js";
import { signedInOwner } from "./helpers/owner-session.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  let clock = new Date();
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => clock });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const companyId = co.company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Developer" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const [ticket] = await db.insert(tickets).values({ companyId, projectId: project.id, title: "Export the designs", systemState: "in_progress", assigneeAgentId: dev.id }).returning();
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));
  await db.delete(wakes);
  return { ...built, db, close, req, companyId, dev, ceo: ceo!, ticket: ticket!, mcp, advance };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const idOf = (t: string) => /Decision ([0-9a-f-]{36})/.exec(t)?.[1]!;
const row = async (id: string) => (await ctx.db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
let n = 0;
async function ask(as: string, args: Record<string, unknown> = {}) {
  const c = await ctx.mcp(as);
  return c.callTool({ name: "raise_decision", arguments: { question: `Housekeeping question ${++n}?`, options: ["Close it", "Keep it open"], recommended: "Close it", triedFirst: "Read the ticket and its branch; nothing needs the owner", ...args } });
}
const ctxOf = (d: { context: unknown }) => d.context as { ladder?: { rung: string; minutes?: number; ticketId: string | null }; ownerOnly?: string; triedFirst?: string };

describe("where a raise_decision card goes (BOS-1318)", () => {
  it("a plain team question goes to the CEO's rung with 60 minutes, and the CEO is woken", async () => {
    const r = await ask(ctx.dev.id, { blocksTicketId: ctx.ticket.id });
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toMatch(/went to the CEO first/);
    const d = await row(idOf(textOf(r)));
    expect(d.tier).toBe("ceo");
    expect(ctxOf(d).ladder).toMatchObject({ rung: "ceo", minutes: CEO_QUESTION_HANDOVER_MINUTES, ticketId: ctx.ticket.id });
    expect(CEO_QUESTION_HANDOVER_MINUTES).toBe(60);
    const woken = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    expect(woken.some((w) => (w.note ?? "").includes(d.id))).toBe(true);
  });

  it.each(OWNER_ONLY_KINDS.filter((k) => k !== "owner_choice"))("ownerOnly %s stays on the owner's queue, with no ladder", async (kind) => {
    const r = await ask(ctx.dev.id, { ownerOnly: kind });
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toMatch(/in the owner's queue/);
    const d = await row(idOf(textOf(r)));
    expect(d.tier).toBe("owner");
    expect(ctxOf(d).ladder).toBeUndefined();
    expect(ctxOf(d).ownerOnly).toBe(kind);
    expect((await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id))).length).toBe(0);
  });

  it("owner_choice needs a one-line reason, and keeps it", async () => {
    const bad = await ask(ctx.dev.id, { ownerOnly: "owner_choice" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/ownerOnlyWhy/);
    const ok = await ask(ctx.dev.id, { ownerOnly: "owner_choice", ownerOnlyWhy: "Product direction the owner kept for themselves" });
    const d = await row(idOf(textOf(ok)));
    expect(d.tier).toBe("owner");
    expect((d.context as { ownerOnlyWhy?: string }).ownerOnlyWhy).toBe("Product direction the owner kept for themselves");
  });

  it("ownerMustDo, or steps, keep the card with the owner without any ownerOnly", async () => {
    const a = await row(idOf(textOf(await ask(ctx.dev.id, { ownerMustDo: true, why: "The runners get the new image.", minutes: 3, steps: ["Open Settings → Server and runner → Updates and press Build and update runners.", "Undo: nothing to undo in Settings → Server and runner → Updates; the button only builds a new image."] }))));
    expect(a.tier).toBe("owner");
    expect(ctxOf(a).ladder).toBeUndefined();
  });

  it("a card raised by the CEO stays with the owner (the CEO can't answer its own)", async () => {
    const d = await row(idOf(textOf(await ask(ctx.ceo.id))));
    expect(d.tier).toBe("owner");
    expect(ctxOf(d).ladder).toBeUndefined();
  });

  it("goes to the owner when the CEO is paused or the company is paused", async () => {
    await ctx.db.update(agents).set({ paused: true }).where(eq(agents.id, ctx.ceo.id));
    expect((await row(idOf(textOf(await ask(ctx.dev.id))))).tier).toBe("owner");
    await ctx.db.update(agents).set({ paused: false }).where(eq(agents.id, ctx.ceo.id));
    await ctx.db.update(companies).set({ paused: true }).where(eq(companies.id, ctx.companyId));
    expect((await row(idOf(textOf(await ask(ctx.dev.id))))).tier).toBe("owner");
  });

  it("routeAgentCard: setsUp, an after-merge check, no raiser and no CEO are the owner's; only a plain card from a worker with a CEO goes to the CEO", () => {
    const base = { raiserRole: "engineer", ceoAvailable: true };
    expect(routeAgentCard(base).tier).toBe("ceo");
    expect(routeAgentCard({ ...base, setsUp: "penpot" }).tier).toBe("owner");
    expect(routeAgentCard({ ...base, criterionIndexes: [0] }).tier).toBe("owner");
    expect(routeAgentCard({ ...base, raiserRole: null }).tier).toBe("owner");
    expect(routeAgentCard({ ...base, ceoAvailable: false }).tier).toBe("owner");
    expect(routeAgentCard({ ...base, steps: ["do it"] }).tier).toBe("owner");
    for (const k of OWNER_ONLY_KINDS) expect(routeAgentCard({ ...base, ownerOnly: k }).tier).toBe("owner");
  });
});

describe("the CEO settles a team question (BOS-1318)", () => {
  it("answers with a note; the raiser is woken with the answer; a note is required", async () => {
    const d = await row(idOf(textOf(await ask(ctx.dev.id, { blocksTicketId: ctx.ticket.id }))));
    const ceo = await ctx.mcp(ctx.ceo.id);
    const noNote = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Close it" } });
    expect(noNote.isError).toBe(true);
    expect((await row(d.id)).status).toBe("open");
    const ok = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: d.id, answer: "Close it", note: "Its work is merged, nothing is left." } });
    expect(ok.isError).not.toBe(true);
    const after = await row(d.id);
    expect(after.status).toBe("answered");
    expect(after.answer).toBe("Close it");
    const w = await ctx.db.select().from(wakes).where(and(eq(wakes.agentId, ctx.dev.id), eq(wakes.reason, "decision answered")));
    expect(w.length).toBe(1);
    expect(w[0]!.note).toContain("Close it");
  });

  it("the server refuses a CEO answer on a card marked owner-only or with steps, even on the CEO's tier", () => {
    const card = (context: object) => ({ kind: "question", tier: "ceo", options: ["A", "B"], context: { type: "question", ...context } });
    expect(ceoAnswerRefusal(card({}), "A")).toBeNull();
    for (const k of OWNER_ONLY_KINDS) expect(ceoAnswerRefusal(card({ ownerOnly: k }), "A")).toMatch(/owner's alone/);
    expect(ceoAnswerRefusal(card({ ownerMustDo: true }), "A")).toMatch(/owner's alone/);
    expect(ceoAnswerRefusal(card({ steps: ["x"] }), "A")).toMatch(/owner/);
  });

  it("escalate sends it to the owner at once", async () => {
    const d = await row(idOf(textOf(await ask(ctx.dev.id))));
    await ctx.alerts.escalate(ctx.companyId, ctx.ceo.id, { alertId: d.id, triedFirst: "Read it; it is a product direction call only the owner makes." });
    const after = await row(d.id);
    expect(after.tier).toBe("owner");
    expect(ctxOf(after).ladder?.rung).toBe("owner");
  });
});

describe("which cards the owner can see (R39)", () => {
  const ceoCall = async (args: Record<string, unknown>) => (await ctx.mcp(ctx.ceo.id)).callTool({ name: "decisions", arguments: args });

  it("the raise reply and the CEO's wake say how to reach the owner when the card landed CEO-first", async () => {
    const r = await ask(ctx.dev.id);
    expect(textOf(r)).toMatch(/steps or ownerOnly/);
    const d = await row(idOf(textOf(r)));
    const woken = await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id));
    expect(woken.some((w) => (w.note ?? "").includes(d.id) && /steps or ownerOnly/.test(w.note ?? ""))).toBe(true);
    // A card that is the owner's already gets no hint.
    expect(textOf(await ask(ctx.dev.id, { ownerOnly: "secret" }))).not.toMatch(/steps or ownerOnly/);
  });

  it("the CEO's list says Owner sees it: no for a CEO-rung card and yes for an owner one; view owner is exactly the owner's queue", async () => {
    const teamId = idOf(textOf(await ask(ctx.dev.id)));
    // A second agent: one agent's new card closes its earlier open one.
    const other = (await ctx.req("POST", `/api/companies/${ctx.companyId}/agents`, { name: "Designer" })).json() as { id: string };
    const ownerId = idOf(textOf(await ask(other.id, { ownerOnly: "secret" })));
    const all = textOf(await ceoCall({ action: "list" }));
    const block = (id: string) => all.split("\n\n").find((b) => b.startsWith(id))!;
    expect(block(teamId)).toMatch(/Owner sees it: no, with you since \d\d:\d\d UTC; reaches the owner at \d\d:\d\d UTC/);
    expect(block(ownerId)).toMatch(/Owner sees it: yes/);
    const ownerList = textOf(await ceoCall({ action: "list", view: "owner" }));
    expect(ownerList).toContain(ownerId);
    expect(ownerList).not.toContain(teamId);
    const queue = await ctx.decisions.queue({ companyId: ctx.companyId });
    expect(queue.map((q) => q.id)).toEqual([...ownerList.matchAll(/^([0-9a-f-]{36}):/gm)].map((m) => m[1]));
  });

  it("escalate works on a team question and its errors say card", async () => {
    const teamId = idOf(textOf(await ask(ctx.dev.id)));
    const bad = await ceoCall({ action: "escalate", id: randomUUID(), triedFirst: "Read it first." });
    expect(textOf(bad)).toMatch(/No open card/);
    const r = await ceoCall({ action: "escalate", id: teamId, triedFirst: "Read it; only the owner can do this." });
    expect(r.isError).not.toBe(true);
    expect((await row(teamId)).tier).toBe("owner");
    const own = await (await ctx.mcp(ctx.dev.id)).callTool({ name: "decisions", arguments: { action: "escalate", id: teamId, triedFirst: "x" } });
    expect(textOf(own)).toMatch(/passes cards to the owner/);
  });
});

describe("the handover to the owner (BOS-1318)", () => {
  it("moves to the owner after 60 minutes, not before, marked as tried by the CEO first", async () => {
    const d = await row(idOf(textOf(await ask(ctx.dev.id, { triedFirst: "Looked at the ticket" }))));
    ctx.advance(59);
    expect((await ctx.alerts.sweep()).moved).toBe(0);
    expect((await row(d.id)).tier).toBe("ceo");
    ctx.advance(2);
    expect((await ctx.alerts.sweep()).moved).toBe(1);
    const after = await row(d.id);
    expect(after.tier).toBe("owner");
    expect(ctxOf(after).triedFirst).toContain("Looked at the ticket");
    expect(ctxOf(after).triedFirst).toContain("Tried by the CEO first");
  });

  it("Approve from the phone is never offered for a CEO-rung card, nor for one handed over to the owner", async () => {
    const d = await row(idOf(textOf(await ask(ctx.dev.id, { approveSummary: "Close the ticket" }))));
    expect(phoneApprovable(d, false)).toBe(false);
    ctx.advance(61);
    await ctx.alerts.sweep();
    const handed = await row(d.id);
    expect(handed.tier).toBe("owner");
    expect(phoneApprovable(handed, false)).toBe(false);
  });

  it("a card already open at deploy (owner tier, no ownerOnly, no ladder) stays with the owner, the sweep leaves it, the CEO can't settle it, the owner can", async () => {
    const [old] = await ctx.db.insert(decisions).values({
      companyId: ctx.companyId, kind: "question", tier: "owner", status: "open", question: "Old housekeeping question?", options: ["Yes", "No"], recommendedOption: "Yes",
      context: { type: "question" }, raisedByAgentId: ctx.dev.id,
    }).returning();
    ctx.advance(600);
    await ctx.alerts.sweep();
    const same = await row(old!.id);
    expect(same.tier).toBe("owner");
    expect(ctxOf(same).ladder).toBeUndefined();
    expect(ceoAnswerRefusal(same, "Yes")).toMatch(/owner/);
    await ctx.decisions.answer(old!.id, "Yes", {});
    expect((await row(old!.id)).status).toBe("answered");
  });

  it("the ladder records why the CEO has it", async () => {
    const d = await row(idOf(textOf(await ask(ctx.dev.id))));
    expect(ctxOf(d).ladder?.rung).toBe("ceo");
    const hops = (d.context as { ladder: { hops: Array<{ to: string; why: string }> } }).ladder.hops;
    expect(hops[0]).toMatchObject({ to: "ceo", why: "a team question goes to the CEO first" });
  });
});
