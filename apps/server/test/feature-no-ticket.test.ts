// A roadmap feature in Now, Next or In progress with no open ticket raises one CEO card, which closes
// by itself once a ticket is linked (BOS-595, from Brains' cock-ups review BOS-588 N6): a feature the
// owner expects to be delivered must not sit there with nothing working on it.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AlertKind } from "../src/services/alert-kinds.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, runs, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: Buffer.alloc(32, 7) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const feature = async (body: Record<string, unknown> = {}) => (await req("POST", `/api/companies/${company.id}/features`, { title: "Merge queue screen", ...body })).json() as { id: string; title: string };
  const ticket = async (body: Record<string, unknown>) => (await req("POST", `/api/projects/${project.id}/tickets`, { title: "A ticket", ...body })).json() as { id: string };
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { featuresWithoutTickets: number };
  // The feature card lands on the CEO's tier first; make the CEO unable to run so the ladder holds it
  // there for the test rather than waking a real one.
  const featureCards = () => db.select().from(decisions).where(eq(decisions.status, "open"));
  return { ...built, db, close, base, req, company, ceo, dev, project, feature, ticket, sweep, featureCards };
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
async function agentAs(agentId: string) {
  const runId = randomUUID();
  // A run token works only while its run row is live (BOS-513), so give the made-up run one.
  await ctx.db.insert(runs).values({ id: runId, companyId: ctx.company.id, agentId, startedAt: new Date() });
  const token = await issueRunToken(ctx.db, { companyId: ctx.company.id, agentId, runId });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}

/** The card for one feature, whatever rung it is on. One key per feature means duplicates can't hide. */
const cardFor = async (featureId: string) => {
  const rows = await ctx.db.select().from(decisions);
  return rows.filter((d) => (d.context as { featureId?: string }).featureId === featureId);
};

describe("a roadmap feature with no open ticket (BOS-595)", () => {
  it("a feature in Now raises exactly one CEO card, and running the sweep again adds no second one", async () => {
    const f = await ctx.feature({ status: "in_progress" });
    expect((await ctx.sweep()).featuresWithoutTickets).toBe(1);
    const cards = await cardFor(f.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "open", kind: "question", tier: "ceo" });
    expect((cards[0]!.context as { ladder: { rung: string; topRung: string; kind: AlertKind } }).ladder).toMatchObject({ rung: "ceo", topRung: "ceo", kind: "feature_no_ticket" });
    expect(cards[0]!.question).toContain("Merge queue screen");
    // Again: it is already raised, so no new card and no second item folded in.
    expect((await ctx.sweep()).featuresWithoutTickets).toBe(1);
    expect(await cardFor(f.id)).toHaveLength(1);
  });

  it("a feature pinned to Next or in the planned column raises one; Later, released and declined raise none", async () => {
    const nextPinned = await ctx.feature({ title: "Pinned next", status: "idea", horizon: "next" });
    const planned = await ctx.feature({ title: "Planned work", status: "planned" });
    const later = await ctx.feature({ title: "Some day", status: "idea" });
    const released = await ctx.feature({ title: "Shipped", status: "released" });
    const declined = await ctx.feature({ title: "Not this", status: "declined" });
    await ctx.sweep();
    expect(await cardFor(nextPinned.id)).toHaveLength(1);
    expect(await cardFor(planned.id)).toHaveLength(1);
    expect(await cardFor(later.id)).toHaveLength(0);
    expect(await cardFor(released.id)).toHaveLength(0);
    expect(await cardFor(declined.id)).toHaveLength(0);
  });

  it("a feature with an open ticket raises no card, and a done ticket does not count as being worked on", async () => {
    const worked = await ctx.feature({ title: "Being built", status: "in_progress" });
    await ctx.ticket({ title: "Build it", featureId: worked.id, state: "in_progress" });
    // A done ticket is not work in flight, whether or not the feature also moved on (a done ticket
    // in a feature with nothing else can even release the feature, which then needs no card).
    const finishedOnly = await ctx.feature({ title: "Already done", status: "planned" });
    const old = await ctx.ticket({ title: "Old attempt", featureId: finishedOnly.id, state: "ready" });
    await ctx.db.update(tickets).set({ systemState: "done" }).where(eq(tickets.id, old.id));
    await ctx.sweep();
    expect(await cardFor(worked.id)).toHaveLength(0);
    expect(await cardFor(finishedOnly.id)).toHaveLength(1);
  });

  it("the card closes by itself once a ticket is linked, with the reason on it, and the sweep leaves it closed", async () => {
    const f = await ctx.feature({ status: "in_progress" });
    await ctx.sweep();
    expect(await cardFor(f.id)).toHaveLength(1);
    await ctx.ticket({ title: "Build the queue", featureId: f.id, state: "ready" });
    await ctx.sweep();
    const [card] = await cardFor(f.id);
    expect(card!.status).toBe("withdrawn");
    expect((card!.context as { withdrawn?: { note: string } }).withdrawn?.note).toMatch(/now has an open ticket/);
    // A second sweep neither reopens it nor raises another.
    await ctx.sweep();
    expect(await cardFor(f.id)).toHaveLength(1);
  });

  it("linking a ticket while the card is still with the CEO closes it there too, without the owner seeing it", async () => {
    const f = await ctx.feature({ status: "planned" });
    await ctx.sweep();
    const [card] = await cardFor(f.id);
    // The ladder holds it with the CEO; the closer works on any rung.
    expect(card!.status).toBe("open");
    await ctx.ticket({ title: "Build it", featureId: f.id });
    await ctx.sweep();
    expect((await cardFor(f.id))[0]!.status).toBe("withdrawn");
  });
});

describe("create_ticket warns on a code ticket with no description or assignee (BOS-595)", () => {
  it("warns about a missing description, a missing assignee, and both, and still creates the ticket", async () => {
    // Only the CEO or a manager assigns to a colleague, so the assigning cases run as one.
    await ctx.db.update(agents).set({ role: "manager" }).where(eq(agents.id, ctx.dev.id));
    const c = await agentAs(ctx.dev.id);
    const make = async (args: Record<string, unknown>) => textOf(await c.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", ...args } }));

    const bare = await make({ title: "Bare ticket" });
    expect(bare).toMatch(/Heads-up: this ticket has no description.*and no assignee/);
    expect(bare).toContain("Created ticket");

    const noBody = await make({ title: "No description", assignee: "Dev" });
    expect(noBody).toMatch(/no description/);
    expect(noBody).not.toMatch(/no assignee/);

    const noAssignee = await make({ title: "No assignee", body: "Make the queue show each job." });
    expect(noAssignee).toMatch(/no assignee/);
    expect(noAssignee).not.toMatch(/no description/);

    const complete = await make({ title: "Complete ticket", body: "Make the queue show each job.", assignee: "Dev" });
    expect(complete).not.toContain("Heads-up");

    // A no-code ticket is asked for neither: research has no diff and often nobody yet.
    const research = await make({ title: "Research the queue", noCode: true });
    expect(research).not.toContain("Heads-up");
  });

  it("the CEO's create_ticket carries the same warning, and a complete one none", async () => {
    const ceo = await agentAs(ctx.ceo.id);
    const make = async (args: Record<string, unknown>) => textOf(await ceo.callTool({ name: "create_ticket", arguments: { size: 2, project: "Customer app", ...args } }));
    expect(await make({ title: "Owner work" })).toMatch(/no description.*and no assignee/);
    expect(await make({ title: "Owner work", body: "Do the thing.", assignee: "Dev" })).not.toContain("Heads-up");
  });
});
