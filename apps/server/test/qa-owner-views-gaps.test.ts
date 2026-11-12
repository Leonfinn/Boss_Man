// QA gap tests for three owner-facing changes that merged on 11 Nov: the Merge queue "Queued checks" list (BOS-1174),
// a CEO-reissued after-merge card keeping its criterion link and needing a new option map (BOS-1155), and the open
// card links behind the Board's "Answer in Decisions" button and the ticket page's list (BOS-1159).
// Map of what the authors' tests cover and what these add: wiki "QA map: BOS-1174, BOS-1155, BOS-1159".
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, ticketDependencies, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { checkQueue } from "../src/services/check-queue.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" } as never);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json() as { id: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const ticket = async (patch: Record<string, unknown> = {}) =>
    (await db.insert(tickets).values({ companyId: company.id, projectId: project.id, title: "Rate limiting", systemState: "in_progress", assigneeAgentId: worker.id, ...patch } as never).returning())[0]!;
  return { ...built, db, close, req, company, ceo, project, worker, mcp, clients, ticket, queue: checkQueue(db) };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type Rows = { running: number; slots: number; rows: Array<{ title: string; kind: string; state: string; position: number | null; heldBy: string | null }> };
const listed = async (c: Setup, companyId = c.company.id) => (await c.req("GET", `/api/companies/${companyId}/check-queue`)).json() as Rows;
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

describe("Queued checks list (BOS-1174)", () => {
  const enq = (c: Setup, ticketId: string, tree: string, kind: "merge" | "pre_review" = "pre_review", extra: Record<string, unknown> = {}) =>
    c.queue.enqueue({ companyId: c.company.id, projectId: c.project.id, ticketId, kind, scope: "quick", commit: `c-${tree}`, tree, requestedBy: c.ceo.id, ...extra });

  it("a check that finishes leaves the list, and the next one in line is shown as waiting no longer", async () => {
    const c = (ctx = await setup());
    const [a, b] = [(await c.ticket({ title: "First" })).id, (await c.ticket({ title: "Second" })).id];
    const first = await enq(c, a, "t1");
    await c.queue.claimNext(null);
    await enq(c, b, "t2");
    expect((await listed(c)).rows.map((r) => [r.title, r.state, r.position])).toEqual([["First", "running", null], ["Second", "waiting", 1]]);
    await c.queue.complete(first.job.id, { runnerId: null, commit: "c-t1", exitCode: 0, logTail: "ok" });
    const after = await listed(c);
    expect(after.running).toBe(0);
    // The finished one is gone; the waiting one is now first in line (and nothing holds it, the slot is free).
    expect(after.rows.map((r) => [r.title, r.state, r.position])).toEqual([["Second", "waiting", 1]]);
    expect(after.rows[0]!.heldBy).toBeNull();
  });

  it("a cancelled check leaves the list too", async () => {
    const c = (ctx = await setup());
    const a = await enq(c, (await c.ticket({ title: "Only" })).id, "t1");
    expect((await listed(c)).rows).toHaveLength(1);
    await c.queue.cancel(a.job.id, "test");
    expect((await listed(c)).rows).toEqual([]);
  });

  it("lists only the asked company's checks", async () => {
    const c = (ctx = await setup());
    await enq(c, (await c.ticket({ title: "Mine" })).id, "t1");
    const other = (await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    expect((await listed(c, other.company.id)).rows).toEqual([]);
    expect((await listed(c)).rows.map((r) => r.title)).toEqual(["Mine"]);
  });

  it("with two slots and one running, the waiting check is not said to be held by a busy slot", async () => {
    const c = (ctx = await setup());
    await c.queue.setSlots(2);
    await enq(c, (await c.ticket({ title: "Running" })).id, "t1");
    await c.queue.claimNext(null);
    await enq(c, (await c.ticket({ title: "Waiting" })).id, "t2");
    const r = await listed(c);
    expect(r.slots).toBe(2);
    expect(r.rows.find((x) => x.title === "Waiting")!.heldBy).toBeNull();
    // and with both slots busy the reason names the count
    await c.queue.claimNext(null);
    await enq(c, (await c.ticket({ title: "Third" })).id, "t3");
    expect((await listed(c)).rows.find((x) => x.title === "Third")!.heldBy).toBe("all 2 check slots are busy");
  });

  it("a merge check waits at the end of the list with the red-main reason while main is red", async () => {
    const c = (ctx = await setup());
    await c.queue.setMainState(c.project.id, "red", "deadbeef");
    await enq(c, (await c.ticket({ title: "Quick one" })).id, "t1");
    await enq(c, (await c.ticket({ title: "Merge one" })).id, "t2", "merge");
    const rows = (await listed(c)).rows;
    const merge = rows.find((x) => x.title === "Merge one")!;
    expect(merge.kind).toBe("merge");
    expect(merge.position).toBeNull();
    expect(merge.heldBy).toMatch(/main is red/);
    expect(rows[rows.length - 1]).toBe(merge);
  });
});

describe("a CEO-reissued after-merge card (BOS-1155)", () => {
  const LIVE = { text: "Answers from the owner's Tailscale name on a real host", after: "merge" as const };
  const ASK = "Does the host answer?";
  /** A card linked to criterion 2, open and with the CEO's advice asked, holding the ticket. */
  async function linkedCard(c: Setup) {
    const t = await c.ticket({ acceptanceCriteria: ["Health check returns 200", LIVE], mergeCommit: "f".repeat(40), stateNote: "Health check returns 200 pass" });
    const [d] = await c.db
      .insert(decisions)
      .values({ companyId: c.company.id, kind: "question", question: ASK, options: ["Yes it answers", "No it does not"], recommendedOption: "Yes it answers", context: { type: "question", criterionIndexes: [1], optionVerdicts: { "Yes it answers": "pass", "No it does not": "fail" } }, raisedByAgentId: c.worker.id } as never)
      .returning();
    await c.db.insert(ticketDependencies).values({ blockedTicketId: t.id, blockerDecisionId: d!.id });
    expect((await c.req("POST", `/api/decisions/${d!.id}/ask-advice`, { note: "What does yes mean?" })).statusCode).toBe(200);
    return { t, d: d! };
  }
  const reissue = { outcome: "reissue", question: "Does the live host answer on its Tailscale name?", options: ["Answers fine", "Does not answer", "Cannot tell yet"], recommended: "Answers fine", triedFirst: "Read the card and the ticket; only the owner can reach their own host." };

  it("is refused without an option map, and the original card is left open", async () => {
    const c = (ctx = await setup());
    const { d } = await linkedCard(c);
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/optionVerdicts/);
    expect((await c.db.select().from(decisions).where(eq(decisions.id, d.id)))[0]!.status).toBe("open");
  });

  it("is refused when the map misses an option", async () => {
    const c = (ctx = await setup());
    const { d } = await linkedCard(c);
    const ceo = await c.mcp(c.ceo.id);
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue, optionVerdicts: { "Answers fine": "pass", "Does not answer": "fail" } } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/Cannot tell yet/);
  });

  it("keeps the criterion link, stores the new map, moves the ticket's hold, and its answer records the verdict", async () => {
    const c = (ctx = await setup());
    const { t, d } = await linkedCard(c);
    const ceo = await c.mcp(c.ceo.id);
    const map = { "Answers fine": "pass", "Does not answer": "fail", "Cannot tell yet": "none" };
    const r = await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue, optionVerdicts: map } });
    expect((r as { isError?: boolean }).isError).not.toBe(true);
    const all = await c.db.select().from(decisions);
    const fresh = all.find((x) => x.id !== d.id && x.question === reissue.question)!;
    expect(fresh.context).toMatchObject({ criterionIndexes: [1], optionVerdicts: map });
    expect(all.find((x) => x.id === d.id)!.status).toBe("withdrawn");
    const deps = await c.db.select().from(ticketDependencies).where(eq(ticketDependencies.blockedTicketId, t.id));
    expect(deps.map((x) => x.blockerDecisionId)).toEqual([fresh.id]);
    // "Cannot tell yet" is mapped to none: nothing recorded. The pass wording is the map's, not the words' own.
    await c.decisions.answer(fresh.id, "Cannot tell yet");
    const [afterNone] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(afterNone!.stateNote).toBe("Health check returns 200 pass");
  });

  // The mapped options on the reissued card are what record a verdict: pass and fail land on criterion 2 (index 1) of the ticket's note.
  for (const [option, verdict] of [["Answers fine", "pass"], ["Does not answer", "fail"]] as const) {
    it(`answering the reissued card with "${option}" records criterion 2 as ${verdict}`, async () => {
      const c = (ctx = await setup());
      const { t, d } = await linkedCard(c);
      const ceo = await c.mcp(c.ceo.id);
      const map = { "Answers fine": "pass", "Does not answer": "fail", "Cannot tell yet": "none" };
      await ceo.callTool({ name: "decisions", arguments: { action: "advise", id: d.id, ...reissue, optionVerdicts: map } });
      const fresh = (await c.db.select().from(decisions)).find((x) => x.id !== d.id && x.question === reissue.question)!;
      await c.decisions.answer(fresh.id, option);
      const [after] = await c.db.select().from(tickets).where(eq(tickets.id, t.id));
      expect(after!.stateNote).toMatch(new RegExp(`\\b2 ${verdict}\\b`));
    });
  }
});

describe("open cards behind Answer in Decisions (BOS-1159)", () => {
  async function blocked(c: Setup) {
    const t = await c.ticket({ title: "Close the loop" });
    const d = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Press Build and update runners?", options: ["Done", "Not yet"], recommended: "Done", blocksTicketId: t.id });
    return { t, d };
  }
  const links = async (c: Setup, id: string) => (await c.req("GET", `/api/tickets/${id}/links`)).json() as { waitsOn: Array<{ kind: string; id: string; open: boolean; link: string }> };
  const boardCard = async (c: Setup, id: string) =>
    ((await c.req("GET", `/api/projects/${c.project.id}/board`)).json().columns as Array<{ tickets: Array<{ id: string; ownerQuestionId: string | null; ownerQuestion: string | null }> }>).flatMap((x) => x.tickets).find((x) => x.id === id)!;

  it("the ticket's links name the card by its own address, open while it is unanswered", async () => {
    const c = (ctx = await setup());
    const { t, d } = await blocked(c);
    const w = (await links(c, t.id)).waitsOn.find((x) => x.kind === "decision")!;
    expect(w).toMatchObject({ id: d.id, open: true, link: `#/decisions/${d.id}` });
  });

  it("once answered the card is no longer open on the ticket, and the Board button stops naming it", async () => {
    const c = (ctx = await setup());
    const { t, d } = await blocked(c);
    expect((await boardCard(c, t.id)).ownerQuestionId).toBe(d.id);
    await c.decisions.answer(d.id, "Done");
    // The ticket page lists only open cards (the web filter is `kind === "decision" && open`). /links drops an answered card altogether
    // (the answer deletes the wait), so the list for that card is empty, not one entry with open: false.
    const w = (await links(c, t.id)).waitsOn.filter((x) => x.kind === "decision" && x.id === d.id);
    expect(w).toEqual([]);
    const b = await boardCard(c, t.id);
    expect(b.ownerQuestionId).toBeNull();
    expect(b.ownerQuestion).toBeNull();
  });

  it("two open cards on one ticket are both listed, each with its own address", async () => {
    const c = (ctx = await setup());
    const { t, d } = await blocked(c);
    const d2 = await c.decisions.raise({ companyId: c.company.id, agentId: c.worker.id, question: "Check the second thing?", options: ["Done", "Not yet"], recommended: "Done", blocksTicketId: t.id });
    const open = (await links(c, t.id)).waitsOn.filter((x) => x.kind === "decision" && x.open);
    expect(open.map((x) => x.link).sort()).toEqual([`#/decisions/${d.id}`, `#/decisions/${d2.id}`].sort());
  });
});
