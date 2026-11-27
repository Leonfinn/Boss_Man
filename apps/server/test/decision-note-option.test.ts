// BOS-2798: a card option that says its answer is in the note ("Done, output pasted in my note") is only taken with
// a note, and the raiser's wake carries that note whole. On 27 Nov (BOS-2775) the owner pressed such an option, the
// card closed at once with no note, and they had to paste the output into the CEO chat instead.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { phoneApprovable } from "../src/services/phone-approve.js";

const PASTED = "Done, output pasted in my note";

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
  const { company } = (await req("POST", "/api/companies", { name: "Note Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Read the disk usage", assigneeAgentId: worker.id })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const answer = (id: string, body: Record<string, unknown>) => req("POST", `/api/decisions/${id}/answer`, body);
  const card = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
  return { ...built, db, close, req, company, worker, ticket, mcp, clients, answer, card };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("an option that says the answer is in the note (BOS-2798)", () => {
  it("is refused with an empty note, and the card stays open", async () => {
    const c = (ctx = await setup());
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Run df -h on the host and paste the output.", options: [PASTED, "It failed"], recommended: PASTED, blocksTicketId: c.ticket.id, triedFirst: "Only the owner can reach the host shell." });
    for (const body of [{ answer: PASTED }, { answer: PASTED, note: "   \n " }]) {
      const r = await c.answer(d.id, body);
      expect(r.statusCode).toBe(422);
      expect(r.json().message).toMatch(/^Paste it in the note first/);
      expect((await c.card(d.id)).status).toBe("open");
    }
    // Another option is answered as before.
    expect((await c.answer(d.id, { answer: "It failed" })).statusCode).toBe(200);
  });

  it("is taken with a note, and the agent's wake carries a long pasted output whole", async () => {
    const c = (ctx = await setup());
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Run df -h on the host and paste the output.", options: [PASTED, "It failed"], recommended: PASTED, blocksTicketId: c.ticket.id, triedFirst: "Only the owner can reach the host shell." });
    // Longer than the old 2000-character cap, as command output often is; the last line must arrive too.
    const output = [...Array.from({ length: 120 }, (_, i) => `/dev/sda${i}  100G  42G  58G  42% /mnt/disk${i}`), "END-OF-OUTPUT"].join("\n");
    expect(output.length).toBeGreaterThan(2000);
    const r = await c.answer(d.id, { answer: PASTED, note: output });
    expect(r.statusCode).toBe(200);
    expect((await c.card(d.id)).status).toBe("answered");
    const woken = await c.db.select().from(wakes).where(and(eq(wakes.agentId, c.worker.id), eq(wakes.reason, "decision answered")));
    const note = woken.map((w) => w.note ?? "").join("\n");
    expect(note).toContain(output);
  });

  it("raise_decision needsNote flags an option whatever its words, and refuses one that isn't an option", async () => {
    const c = (ctx = await setup());
    const m = await c.mcp(c.worker.id);
    const base = { question: "Send me the version the host prints.", options: ["Sent", "Not now"], recommended: "Sent", blocksTicketId: c.ticket.id, triedFirst: "I can't reach the host; only the owner can." };
    const bad = await m.callTool({ name: "raise_decision", arguments: { ...base, needsNote: ["Sent it"] } });
    expect(textOf(bad)).toMatch(/needsNote names "Sent it"/);
    await m.callTool({ name: "raise_decision", arguments: { ...base, needsNote: ["Sent"] } });
    const [row] = await c.db.select().from(decisions).where(and(eq(decisions.companyId, c.company.id), eq(decisions.question, base.question)));
    expect((row!.context as { noteOptions?: string[] }).noteOptions).toEqual(["Sent"]);
    expect((await c.answer(row!.id, { answer: "Sent" })).statusCode).toBe(422);
    expect((await c.answer(row!.id, { answer: "Sent", note: "v1.2.3" })).statusCode).toBe(200);
  });

  it("a card whose recommended option needs a note gets no phone Approve", async () => {
    const card = { kind: "question", context: { type: "question", approveSummary: "Mark the check done" }, options: [PASTED, "It failed"], recommendedOption: PASTED, raisedByAgentId: randomUUID(), status: "open", tier: "owner", forAgentId: null, staleAt: null, recheckStage: null } as unknown as Parameters<typeof phoneApprovable>[0];
    expect(phoneApprovable(card, false)).toBe(false);
    // Flagged by needsNote, whatever its words.
    const flagged = { ...card, options: ["Sent", "Not now"], recommendedOption: "Sent", context: { type: "question", approveSummary: "Mark the check done", noteOptions: ["Sent"] } } as typeof card;
    expect(phoneApprovable(flagged, false)).toBe(false);
    expect(phoneApprovable({ ...card, options: ["Done", "It failed"], recommendedOption: "Done" }, false)).toBe(true);
  });
});
