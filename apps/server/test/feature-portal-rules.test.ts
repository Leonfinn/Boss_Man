// BOS-1358: features created by any route land on the roadmap, go on the feedback portal by default,
// and any held off it (the security guess or a keep-off mark) is put to the owner as one Keep off /
// Publish card, whose answer is applied. The BOS-991 guard still stops an agent publishing security work.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runs } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { applyPortalAnswer, featurePortalKey, PORTAL_KEEP_OFF, PORTAL_PUBLISH } from "../src/services/feature-portal.js";

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: Buffer.alloc(32, 7) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const pm = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Pip", template: "product-manager" })).json() as { id: string };
  const feature = async (body: Record<string, unknown> = {}) => (await req("POST", `/api/companies/${company.id}/features`, { title: "Dark mode", ...body })).json() as { id: string; title: string; portalVisible: boolean; keepOffPortal: boolean; keepOffReason: string | null };
  const sweep = async () => (await req("POST", "/api/sweep")).json() as { portalHolds: { raised: number } };
  const roadmap = async () => (await req("GET", "/api/roadmap/features")).json().find((x: { id: string }) => x.id === company.id) as { features: Array<{ id: string; column: string }> };
  const answer = (id: string, a: string) => req("POST", `/api/decisions/${id}/answer`, { answer: a });
  const cards = async (featureId: string) => (await db.select().from(decisions)).filter((d) => (d.context as { featureId?: string }).featureId === featureId);
  return { ...built, db, close, base, req, company, ceo, pm, feature, sweep, roadmap, answer, cards };
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
  await ctx.db.insert(runs).values({ id: runId, companyId: ctx.company.id, agentId, startedAt: new Date() });
  const token = await issueRunToken(ctx.db, { companyId: ctx.company.id, agentId, runId });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return c;
}

describe("features land on the roadmap and the portal (BOS-1358)", () => {
  it("a feature from every create route comes back from the roadmap with a column", async () => {
    // The owner's Features page.
    const fromOwner = await ctx.feature({ title: "Owner feature" });
    // The CEO's triage tool.
    const ceo = await agentAs(ctx.ceo.id);
    const ceoCall = await ceo.callTool({ name: "feedback", arguments: { action: "create_feature", title: "CEO feature", description: "Made by the CEO." } });
    expect(textOf(ceoCall)).toContain("Created feature");
    const ceoId = /Created feature ([0-9a-f-]{36})/.exec(textOf(ceoCall))![1]!;
    // A product manager through the feedback triage tool.
    const pm = await agentAs(ctx.pm.id);
    const pmCall = await pm.callTool({ name: "feedback", arguments: { action: "create_feature", title: "PM feature", reason: "It fits the plan." } });
    expect(textOf(pmCall)).toContain("Created feature");
    const pmId = /Created feature ([0-9a-f-]{36})/.exec(textOf(pmCall))![1]!;

    const board = await ctx.roadmap();
    const placed = (id: string) => board.features.find((f) => f.id === id);
    // Every one is on the roadmap with a column, without anyone placing it.
    for (const id of [fromOwner.id, ceoId, pmId]) expect(placed(id)?.column).toBeTruthy();
    expect(placed(fromOwner.id)?.column).toBe("later");
  });

  it("puts an ordinary feature on the portal, and holds off a security one or a keep-off mark, keeping the reason", async () => {
    const ordinary = await ctx.feature({ title: "Dark mode", description: "A dark theme." });
    expect(ordinary).toMatchObject({ portalVisible: true, keepOffPortal: false });
    // Security work is held off, by the stored feature's words.
    const security = await ctx.feature({ title: "Rotate API keys", description: "Rotate the secret every week." });
    expect(security.portalVisible).toBe(false);
    // A keep-off mark with a reason keeps it off and stores the reason.
    const marked = await ctx.feature({ title: "Beta invite", description: "Invite only.", keepOffPortal: true, keepOffReason: "Partners only for now" });
    expect(marked).toMatchObject({ portalVisible: false, keepOffPortal: true, keepOffReason: "Partners only for now" });
    // Clearing the mark clears the reason.
    const cleared = (await ctx.req("PATCH", `/api/features/${marked.id}`, { keepOffPortal: false })).json();
    expect(cleared).toMatchObject({ keepOffPortal: false, keepOffReason: null });
  });

  it("raises one owner card per held-off feature, and answering Publish puts it on the portal", async () => {
    const held = await ctx.feature({ title: "Rotate API keys", description: "Rotate the secret every week." });
    expect((await ctx.sweep()).portalHolds.raised).toBe(1);
    const [card] = await ctx.cards(held.id);
    expect(card).toMatchObject({ status: "open", kind: "question", tier: "owner" });
    expect(card!.question).toContain("Rotate API keys");
    expect(card!.options).toEqual([PORTAL_KEEP_OFF, PORTAL_PUBLISH]);
    expect(card!.recommendedOption).toBe(PORTAL_KEEP_OFF);
    // No public summary yet, so the card says publishing needs one first.
    expect(card!.question).toContain("public summary");
    // A second pass asks nothing more for the same feature.
    expect((await ctx.sweep()).portalHolds.raised).toBe(0);
    expect(await ctx.cards(held.id)).toHaveLength(1);

    // The owner publishes it: it goes on the portal, and the card is answered.
    expect((await ctx.answer(card!.id, PORTAL_PUBLISH)).statusCode).toBe(200);
    expect((await ctx.req("GET", `/api/features/${held.id}`)).json().feature).toMatchObject({ portalVisible: true, keepOffPortal: false });
  });

  it("answering Keep off keeps the feature off and marks it keep-off by hand", async () => {
    const held = await ctx.feature({ title: "Internal pilot", description: "Trial with one team.", keepOffPortal: true, keepOffReason: "Internal pilot" });
    await ctx.sweep();
    const [card] = await ctx.cards(held.id);
    expect(card!.question).toContain("Internal pilot");
    expect((await ctx.answer(card!.id, PORTAL_KEEP_OFF)).statusCode).toBe(200);
    expect((await ctx.req("GET", `/api/features/${held.id}`)).json().feature).toMatchObject({ portalVisible: false, keepOffPortal: true });
  });

  it("recommends Publish when the feature already has a public summary", async () => {
    const ready = await ctx.feature({ title: "Internal pilot", description: "Trial with one team.", keepOffPortal: true, publicSummary: "A trial with one team." });
    await ctx.sweep();
    const [card] = await ctx.cards(ready.id);
    expect(card!.recommendedOption).toBe(PORTAL_PUBLISH);
    expect(card!.question).not.toContain("public summary");
  });

  it("still refuses an agent that tries to publish security work (BOS-991)", async () => {
    const held = await ctx.feature({ title: "Rotate API keys", description: "Rotate the secret every week." });
    const pm = await agentAs(ctx.pm.id);
    const r = await pm.callTool({ name: "feedback", arguments: { action: "update_feature", featureId: held.id, portalVisible: true, reason: "Ship it." } });
    expect(textOf(r)).toMatch(/security work/i);
    // The stored feature is untouched.
    expect((await ctx.req("GET", `/api/features/${held.id}`)).json().feature.portalVisible).toBe(false);
  });
});

describe("applyPortalAnswer", () => {
  it("without a public summary, Publish ticks the feature on but visitors still see nothing until a summary is written", async () => {
    const held = await ctx.feature({ title: "Internal pilot", description: "Trial with one team.", keepOffPortal: true });
    const applied = await applyPortalAnswer(ctx.db, held.id, PORTAL_PUBLISH, new Date());
    expect(applied).toMatchObject({ published: false });
    expect((await ctx.req("GET", `/api/features/${held.id}`)).json().feature.portalVisible).toBe(true);
    // The dedupe key is one per feature.
    expect(featurePortalKey(held.id)).toBe(`feature-portal-hold:${held.id}`);
  });

  it("does nothing for a feature that is gone", async () => {
    expect(await applyPortalAnswer(ctx.db, randomUUID(), PORTAL_PUBLISH, new Date())).toBeNull();
  });
});
