// BOS-1210: the read-only merge_line_records tool. It returns only merge_line rows of the caller's own company,
// only the named fields, and nothing from any other table or company.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { exportRow } from "../src/mcp-merge-line.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const mk = async (name: string) => {
    const co = (await req("POST", "/api/companies", { name })).json() as { company: { id: string }; ceo: { id: string } };
    const p = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: `${name} app` })).json() as { id: string };
    const t = (await db.insert(tickets).values({ companyId: co.company.id, projectId: p.id, title: "A ticket", systemState: "ready" }).returning())[0]!;
    return { ...co, ticket: t };
  };
  return { ...built, db, close, base, mine: await mk("App Co"), other: await mk("Other Co") };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
async function asCeo(co: { company: { id: string }; ceo: { id: string } }) {
  const token = await issueRunToken(ctx.db, { companyId: co.company.id, agentId: co.ceo.id, runId: randomUUID() });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://${ctx.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const call = async (c: Client, args: Record<string, unknown>) => (await c.callTool({ name: "merge_line_records", arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
const row = (co: typeof ctx.mine, at: string, kind: string, detail: Record<string, unknown>, summary = "secret summary") =>
  ctx.db.insert(activity).values({ companyId: co.company.id, ticketId: co.ticket.id, at: new Date(at), kind, summary, detail });

describe("merge_line_records", () => {
  it("returns merge_line rows from the date on, with only the named fields", async () => {
    await row(ctx.mine, "2026-11-08T21:00:00Z", "merge_line", { event: "approved", by: "Jane" });
    await row(ctx.mine, "2026-11-08T21:30:00Z", "merge_line", { event: "check_ended", check: "gate", passed: false, way: "gate", jobId: "j1", why: "private why" });
    await row(ctx.mine, "2026-11-09T01:00:00Z", "merge_line", { event: "hold_ended", hold: "card", since: "x", heldMs: 1234, note: "private note" });
    const c = await asCeo(ctx.mine);
    const out = JSON.parse(textOf(await call(c, { since: "2026-11-08T21:22:00Z" }))) as { rows: Array<Record<string, unknown>> };
    expect(out.rows.map((r) => r.event)).toEqual(["check_ended", "hold_ended"]);
    expect(out.rows[0]).toEqual({ ticket_id: ctx.mine.ticket.id, at: "2026-11-08T21:30:00.000Z", event: "check_ended", hold: null, heldMs: null, check: "gate", passed: false, by: null });
    expect(out.rows[1]).toMatchObject({ hold: "card", heldMs: 1234 });
    const all = textOf(await call(c, { since: "2026-11-01T00:00:00Z", format: "csv" }));
    expect(all.split("\n")[0]).toBe("ticket_id,at,event,hold,heldMs,check,passed,by");
    for (const leak of ["private", "secret summary", "jobId", "j1"]) expect(all).not.toContain(leak);
    expect(textOf(await call(c, { since: "2026-11-01T00:00:00Z", until: "2026-11-08T21:10:00Z" }))).toContain('"event":"approved"');
    await c.close();
  });

  it("never returns other kinds of activity or another company's rows", async () => {
    await row(ctx.mine, "2026-11-09T00:00:00Z", "ticket_reply", { event: "approved", by: "Someone" });
    await row(ctx.other, "2026-11-09T00:00:00Z", "merge_line", { event: "approved", by: "Other Co person" });
    const c = await asCeo(ctx.mine);
    const out = JSON.parse(textOf(await call(c, { since: "2026-11-01T00:00:00Z" }))) as { rows: unknown[] };
    expect(out.rows).toEqual([]);
    await c.close();
    const o = await asCeo(ctx.other);
    expect(textOf(await call(o, { since: "2026-11-01T00:00:00Z" }))).toContain("Other Co person");
    await o.close();
  });

  it("refuses a bad date, cuts at the limit and says how to carry on, and quotes CSV cells safely", async () => {
    for (const m of [1, 2, 3]) await row(ctx.mine, `2026-11-09T00:0${m}:00Z`, "merge_line", { event: "approved", by: m === 3 ? "=cmd,\"x\"" : "Jane" });
    const c = await asCeo(ctx.mine);
    expect((await call(c, { since: "not a date" })).isError).toBe(true);
    const cut = JSON.parse(textOf(await call(c, { since: "2026-11-01T00:00:00Z", limit: 2 }))) as { note: string; rows: unknown[] };
    expect(cut.rows).toHaveLength(2);
    expect(cut.note).toContain("since=2026-11-09T00:02:00.000Z");
    expect(textOf(await call(c, { since: "2026-11-01T00:00:00Z", format: "csv" }))).toContain(`"'=cmd,""x"""`);
    await c.close();
  });

  it("exportRow ignores values of the wrong type", () => {
    expect(exportRow({ ticketId: null, at: new Date(0), detail: { event: 5, heldMs: "1", passed: "yes", check: { a: 1 } } })).toMatchObject({ event: null, heldMs: null, passed: null, check: null });
  });
});
