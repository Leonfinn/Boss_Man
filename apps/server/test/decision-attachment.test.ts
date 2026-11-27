// BOS-2742: a card option that promises a screenshot ("Done, screenshot of the result attached", Boss Man's own
// "My screen looks different (I'll attach a screenshot)") is only taken with an image attached, and the agent's
// wake lists the image ids. On 26 Nov (BOS-2597) and 16 Nov (BOS-1574) the owner pressed such an option, the card
// closed at once, and no picture ever reached it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { raiseOwnerTodo } from "../src/services/decisions.js";
import { phoneApprovable } from "../src/services/phone-approve.js";
import { SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DONE_SHOT = "Done, screenshot of the result attached";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "Shot Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Submit the sitemap", assigneeAgentId: worker.id })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const upload = async (companyId: string, ticketId?: string) => (await req("POST", `/api/companies/${companyId}/images`, { data: PNG, name: "live-test.png", ...(ticketId ? { ticketId } : {}) })).json() as { id: string; markdown: string };
  const answer = (id: string, body: Record<string, unknown>) => req("POST", `/api/decisions/${id}/answer`, body);
  const card = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
  return { ...built, db, close, req, company, worker, ticket, mcp, clients, upload, answer, card };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("an option that promises a screenshot (BOS-2742)", () => {
  it("is refused with nothing attached, and the card stays open", async () => {
    const c = (ctx = await setup());
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Run Google's live test on the sitemap.", options: [DONE_SHOT, "It failed"], recommended: DONE_SHOT, attachOptions: [DONE_SHOT], blocksTicketId: c.ticket.id, triedFirst: "Only the owner can sign in to Search Console." });
    const r = await c.answer(d.id, { answer: DONE_SHOT });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/^Attach the screenshot first/);
    expect((await c.card(d.id)).status).toBe("open");
    // A note with no picture is not enough either, nor a link to an image that doesn't exist.
    expect((await c.answer(d.id, { answer: DONE_SHOT, note: "It passed" })).statusCode).toBe(422);
    expect((await c.answer(d.id, { answer: DONE_SHOT, note: `![x](/api/ticket-images/${randomUUID()})` })).statusCode).toBe(422);
    // Another option is answered as before.
    expect((await c.answer(d.id, { answer: "It failed" })).statusCode).toBe(200);
  });

  it("refuses an image from another company", async () => {
    const c = (ctx = await setup());
    const { company: other } = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    const foreign = await c.upload(other.id);
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Run the live test.", options: [DONE_SHOT, "It failed"], recommended: DONE_SHOT, attachOptions: [DONE_SHOT], blocksTicketId: c.ticket.id, triedFirst: "Only the owner can sign in." });
    expect((await c.answer(d.id, { answer: DONE_SHOT, note: foreign.markdown })).statusCode).toBe(422);
  });

  it("is taken with the screenshot in the note, and the agent's wake lists the image id", async () => {
    const c = (ctx = await setup());
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Run Google's live test on the sitemap.", options: [DONE_SHOT, "It failed"], recommended: DONE_SHOT, attachOptions: [DONE_SHOT], blocksTicketId: c.ticket.id, triedFirst: "Only the owner can sign in to Search Console." });
    const shot = await c.upload(c.company.id, c.ticket.id);
    const r = await c.answer(d.id, { answer: DONE_SHOT, note: `Passed.\n${shot.markdown}` });
    expect(r.statusCode).toBe(200);
    expect((await c.card(d.id)).status).toBe("answered");
    // The image sits on the card's ticket.
    expect((await c.req("GET", `/api/tickets/${c.ticket.id}/images`)).json().map((i: { id: string }) => i.id)).toContain(shot.id);
    const woken = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "decision answered")));
    const note = woken.map((w) => w.note ?? "").join("\n");
    expect(note).toContain(shot.id);
    expect(note).toContain("open_attachment");
  });

  it("raise_decision refuses an option promising a screenshot that isn't flagged needsAttachment (DR-078)", async () => {
    const c = (ctx = await setup());
    const m = await c.mcp(c.worker.id);
    const r = await m.callTool({ name: "raise_decision", arguments: { question: "Run Google's live test on the sitemap.", options: [DONE_SHOT, "It failed"], recommended: DONE_SHOT, blocksTicketId: c.ticket.id, triedFirst: "Only the owner can sign in to Search Console." } });
    expect(textOf(r)).toMatch(/flag this option needsAttachment/);
    expect(await c.db.select().from(decisions).where(eq(decisions.companyId, c.company.id))).toEqual([]);
  });

  it("raise_decision needsAttachment flags an option whatever its words, and refuses one that isn't an option", async () => {
    const c = (ctx = await setup());
    const m = await c.mcp(c.worker.id);
    const base = { question: "Send me the error page from your phone.", options: ["Sent", "Not now"], recommended: "Sent", blocksTicketId: c.ticket.id, triedFirst: "I can't see the owner's phone; only they can." };
    const bad = await m.callTool({ name: "raise_decision", arguments: { ...base, needsAttachment: ["Sent it"] } });
    expect(textOf(bad)).toMatch(/needsAttachment names "Sent it"/);
    await m.callTool({ name: "raise_decision", arguments: { ...base, needsAttachment: ["Sent"] } });
    const [row] = await c.db.select().from(decisions).where(and(eq(decisions.companyId, c.company.id), eq(decisions.question, base.question)));
    expect((row!.context as { attachOptions?: string[] }).attachOptions).toEqual(["Sent"]);
    expect((await c.answer(row!.id, { answer: "Sent" })).statusCode).toBe(422);
    const shot = await c.upload(c.company.id, c.ticket.id);
    expect((await c.answer(row!.id, { answer: "Sent", note: shot.markdown })).statusCode).toBe(200);
  });

  it("Boss Man's own 'My screen looks different' option on an outside-site to-do is flagged and refused without a picture", async () => {
    const c = (ctx = await setup());
    const steps = [`On GitHub, open the repo's page. You should see a "Settings" tab under the repo's name. Click Settings. (not seen: https://docs.github.com/en/repositories, 2026-11-24)`];
    const row = await raiseOwnerTodo(c.db, { companyId: c.company.id, question: "Add a collaborator.", key: "owner-todo:test:bos-2742", steps, ofDecisionId: "system", facts: {} });
    expect(row).not.toBeNull();
    const todo = await c.card(row!.id);
    expect((todo.context as { attachOptions?: string[] }).attachOptions).toEqual([SCREEN_DIFFERENT_OPTION]);
    expect((await c.answer(row!.id, { answer: SCREEN_DIFFERENT_OPTION })).statusCode).toBe(422);
    const shot = await c.upload(c.company.id);
    expect((await c.answer(row!.id, { answer: SCREEN_DIFFERENT_OPTION, note: shot.markdown })).statusCode).toBe(200);
  });

  it("a card whose recommended option needs a screenshot gets no phone Approve", async () => {
    const card = { kind: "question", context: { type: "question", approveSummary: "Mark the live test done" }, options: [DONE_SHOT, "It failed"], recommendedOption: DONE_SHOT, raisedByAgentId: randomUUID(), status: "open", tier: "owner", forAgentId: null, staleAt: null, recheckStage: null } as unknown as Parameters<typeof phoneApprovable>[0];
    expect(phoneApprovable(card, false)).toBe(false);
    expect(phoneApprovable({ ...card, options: ["Done", "It failed"], recommendedOption: "Done" }, false)).toBe(true);
  });
});
