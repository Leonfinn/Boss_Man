// BOS-1695: the card tools accept the 8-character short id agents are shown (a unique prefix in the caller's company).
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { resolveCardId } from "../src/services/card-id.js";

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
  const make = async (name: string) => {
    const { company } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
    const brian = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Brian" })).json() as { id: string };
    return { company, brian };
  };
  const a = await make("Web Co");
  const other = await make("Other Co");
  const clients: Client[] = [];
  const mcp = async (companyId: string, agentId: string) => {
    const token = await issueRunToken(db, { companyId, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const card = async (who: { company: { id: string }; brian: { id: string } }, id: string) => {
    const [row] = await db
      .insert(decisions)
      .values({ id, companyId: who.company.id, kind: "question", question: "Publish the launch announcement?", options: ["Yes", "No"], recommendedOption: "Yes", raisedByAgentId: who.brian.id, tier: "owner", context: { type: "question" } })
      .returning();
    return row!;
  };
  return { ...built, db, close, a, other, mcp, clients, card };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const WHY = "The launch moved to next week, so this question is no longer needed now.";

describe("card tools take a short id (BOS-1695)", () => {
  it("withdraw_decision with the 8-character prefix withdraws the card", async () => {
    const c = (ctx = await setup());
    const d = await c.card(c.a, "ec4843ae-1111-4222-8333-444455556666");
    const mcp = await c.mcp(c.a.company.id, c.a.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: "ec4843ae", reason: WHY, replacedBy: "none" } });
    expect(isError(r), textOf(r)).toBe(false);
    expect(textOf(r)).toContain(d.id);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, d.id));
    expect(after!.status).toBe("withdrawn");
  });

  it("an ambiguous prefix is refused and lists the matches; nothing is withdrawn", async () => {
    const c = (ctx = await setup());
    const d1 = await c.card(c.a, "ab12cd34-1111-4222-8333-444455556666");
    const d2 = await c.card(c.a, "ab12cd34-9999-4222-8333-444455556666");
    const mcp = await c.mcp(c.a.company.id, c.a.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: "ab12cd34", reason: WHY, replacedBy: "none" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toContain(d1.id);
    expect(textOf(r)).toContain(d2.id);
    const rows = await c.db.select().from(decisions);
    expect(rows.every((x) => x.status === "open")).toBe(true);
    // a longer prefix that is unique works
    const ok = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: "ab12cd34-1111", reason: WHY, replacedBy: "none" } });
    expect(isError(ok), textOf(ok)).toBe(false);
  });

  it("a prefix never reaches a card in another company", async () => {
    const c = (ctx = await setup());
    await c.card(c.other, "fe00aa11-1111-4222-8333-444455556666");
    const mcp = await c.mcp(c.a.company.id, c.a.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: "fe00aa11", reason: WHY, replacedBy: "none" } });
    expect(isError(r)).toBe(true);
    expect(textOf(r)).toMatch(/No card in your company/);
    const [row] = await c.db.select().from(decisions).where(eq(decisions.id, "fe00aa11-1111-4222-8333-444455556666"));
    expect(row!.status).toBe("open");
  });

  it("replacedBy card:<short id> is resolved to the full id", async () => {
    const c = (ctx = await setup());
    const old = await c.card(c.a, "11111111-1111-4222-8333-444455556666");
    const newer = await c.card(c.a, "22222222-1111-4222-8333-444455556666");
    const mcp = await c.mcp(c.a.company.id, c.a.brian.id);
    const r = await mcp.callTool({ name: "withdraw_decision", arguments: { decisionId: "11111111", reason: WHY, replacedBy: "card:22222222" } });
    expect(isError(r), textOf(r)).toBe(false);
    const [after] = await c.db.select().from(decisions).where(eq(decisions.id, old.id));
    expect(after!.status).toBe("withdrawn");
    expect(newer.status).toBe("open");
  });

  it("resolveCardId: full id passes through, junk and too-short input are refused", async () => {
    const c = (ctx = await setup());
    const full = randomUUID();
    expect(await resolveCardId(c.db, c.a.company.id, full)).toEqual({ ok: true, id: full });
    expect((await resolveCardId(c.db, c.a.company.id, "abc")).ok).toBe(false);
    expect((await resolveCardId(c.db, c.a.company.id, "50%_ff")).ok).toBe(false);
  });
});
