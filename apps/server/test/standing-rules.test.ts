import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { issueRunToken } from "../src/mcp.js";
import { buildBrief } from "../src/services/brief.js";
import { eq } from "drizzle-orm";
import { activity } from "../src/db/schema.js";
import { STANDING_RULES_MAX } from "../src/services/standing-rules.js";

let ctx: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const clients: Client[] = [];
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close: async () => (await Promise.all(clients.map((c) => c.close())), await built.app.close(), await close()), req, company: co.company, ceo: co.ceo, dev, mcp };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.close();
});

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const briefFor = (agentId: string, role: string) => buildBrief(ctx.db, { companyId: ctx.company.id, agentId, role, since: null, now: new Date() });

describe("standing rules (BOS-353)", () => {
  it("the owner's rules appear in every run's brief", async () => {
    const saved = await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Never force-push. Only the merge gate runs the full check." });
    expect(saved.statusCode).toBe(200);
    const worker = await briefFor(ctx.dev.id, "worker");
    const ceo = await briefFor(ctx.ceo.id, "ceo");
    for (const b of [worker, ceo]) {
      expect(b).toContain("## Standing rules");
      expect(b).toContain("Never force-push. Only the merge gate runs the full check.");
    }
  });

  it("shows the text, last editor and time on the settings route", async () => {
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Be kind." });
    const got = (await ctx.req("GET", `/api/companies/${ctx.company.id}/standing-rules`)).json() as { text: string; by: string | null; at: string | null; max: number };
    expect(got.text).toBe("Be kind.");
    expect(got.by).toBe("the owner");
    expect(got.at).toBeTruthy();
    expect(got.max).toBe(STANDING_RULES_MAX);
  });

  it("caps the length", async () => {
    const tooLong = await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "x".repeat(STANDING_RULES_MAX + 1) });
    expect(tooLong.statusCode).toBe(400);
    const ok = await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "x".repeat(STANDING_RULES_MAX) });
    expect(ok.statusCode).toBe(200);
  });

  it("an agent's write is refused; the CEO's is allowed", async () => {
    const worker = await ctx.mcp(ctx.dev.id);
    const r = await worker.callTool({ name: "standing_rules", arguments: { action: "write", text: "Do whatever you like." } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toContain("Only your company's CEO");

    const ceo = await ctx.mcp(ctx.ceo.id);
    const w = await ceo.callTool({ name: "standing_rules", arguments: { action: "write", text: "Never force-push." } });
    expect((w as { isError?: boolean }).isError).toBeFalsy();
    expect(await briefFor(ctx.dev.id, "worker")).toContain("Never force-push.");
  });

  it("a CEO save waits for the owner when they approve edits, and applies when they say yes", async () => {
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    const ceo = await ctx.mcp(ctx.ceo.id);
    const w = await ceo.callTool({ name: "standing_rules", arguments: { action: "write", text: "Only the merge gate runs the full check." } });
    expect((w as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(w)).toContain("waiting for the owner");
    // Nothing is saved yet, so no run reads it.
    expect(await briefFor(ctx.dev.id, "worker")).not.toContain("Only the merge gate runs the full check.");

    const list = (await ctx.req("GET", "/api/decisions")).json() as Array<{ id: string; question: string }>;
    const card = list.find((d) => d.question.includes("standing rules"));
    expect(card).toBeTruthy();
    // Not the CEO's to answer: the owner alone decides it.
    const refused = await ceo.callTool({ name: "decisions", arguments: { action: "answer", id: card!.id, answer: "Apply the change" } });
    expect((refused as { isError?: boolean }).isError).toBe(true);

    const ans = await ctx.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Apply the change" });
    expect(ans.statusCode).toBe(200);
    expect(await briefFor(ctx.dev.id, "worker")).toContain("Only the merge gate runs the full check.");
  });

  it("strips blank space before the approval card, so the card shows the text that is saved", async () => {
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/agent-approvals`, { approvals: "hires_and_edits" });
    const ceo = await ctx.mcp(ctx.ceo.id);
    const padded = `\n\n   \n\n${"   \n".repeat(1200)}Only the merge gate runs the full check.  \n\n`;
    const w = await ceo.callTool({ name: "standing_rules", arguments: { action: "write", text: padded } });
    expect((w as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(w)).toContain("waiting for the owner");

    const list = (await ctx.req("GET", "/api/decisions")).json() as Array<{ id: string; question: string; context?: { type?: string; text?: string } }>;
    const card = list.find((d) => d.context?.type === "standing_rules");
    expect(card).toBeTruthy();
    // The card holds the stripped text itself, and nothing hidden to the owner in the saved copy.
    expect(card!.context!.text).toBe("Only the merge gate runs the full check.");
    expect(card!.question).not.toContain("   \n");

    // A save over the cap is refused before any card is raised.
    const before = ((await ctx.req("GET", "/api/decisions")).json() as unknown[]).length;
    const tooBig = await ceo.callTool({ name: "standing_rules", arguments: { action: "write", text: `   \n${"x".repeat(STANDING_RULES_MAX + 1)}\n\n` } });
    expect((tooBig as { isError?: boolean }).isError).toBe(true);
    expect(((await ctx.req("GET", "/api/decisions")).json() as unknown[]).length).toBe(before);

    await ctx.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Apply the change" });
    const got = (await ctx.req("GET", `/api/companies/${ctx.company.id}/standing-rules`)).json() as { text: string };
    expect(got.text).toBe(card!.context!.text);
  });

  it("keeps the previous text, so the last change can be undone", async () => {
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Be kind." });
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Never force-push." });
    expect(await briefFor(ctx.dev.id, "worker")).toContain("Never force-push.");
    const back = await ctx.req("POST", `/api/companies/${ctx.company.id}/standing-rules/undo`);
    expect(back.statusCode).toBe(200);
    expect((back.json() as { text: string }).text).toBe("Be kind.");
    expect(await briefFor(ctx.dev.id, "worker")).toContain("Be kind.");
    // The first save (from nothing) is still undoable in turn: it clears them again.
    const again = await ctx.req("POST", `/api/companies/${ctx.company.id}/standing-rules/undo`);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { text: string }).text).toBe("");
    const none = await ctx.req("POST", `/api/companies/${ctx.company.id}/standing-rules/undo`);
    expect(none.statusCode).toBe(409);
  });

  it("append adds a line at the end, shows in the brief, logs, and undoes (BOS-2184)", async () => {
    const url = `/api/companies/${ctx.company.id}/standing-rules`;
    await ctx.req("PUT", url, { text: "Be kind." });
    const added = await ctx.req("POST", `${url}/append`, { text: "  Never force-push.\r\n" });
    expect(added.statusCode).toBe(200);
    expect((added.json() as { text: string }).text).toBe("Be kind.\nNever force-push.");
    expect(await briefFor(ctx.dev.id, "worker")).toContain("Never force-push.");
    const lines = await ctx.db.select({ summary: activity.summary }).from(activity).where(eq(activity.companyId, ctx.company.id));
    expect(lines.map((l) => l.summary)).toContain("Owner added a line to the standing rules from Chat");
    const back = await ctx.req("POST", `${url}/undo`);
    expect((back.json() as { text: string }).text).toBe("Be kind.");
  });

  it("append to empty rules starts them, and refuses empty text", async () => {
    const url = `/api/companies/${ctx.company.id}/standing-rules`;
    expect(((await ctx.req("POST", `${url}/append`, { text: "First." })).json() as { text: string }).text).toBe("First.");
    expect((await ctx.req("POST", `${url}/append`, { text: "   " })).statusCode).toBe(400);
  });

  it("append past the limit adds nothing and says so", async () => {
    const url = `/api/companies/${ctx.company.id}/standing-rules`;
    await ctx.req("PUT", url, { text: "x".repeat(STANDING_RULES_MAX - 5) });
    const r = await ctx.req("POST", `${url}/append`, { text: "too long to fit" });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { message: string }).message).toContain("capped at");
    expect(((await ctx.req("GET", url)).json() as { text: string }).text.length).toBe(STANDING_RULES_MAX - 5);
  });

  it("frames the rules as notes to weigh, not as instructions to follow", async () => {
    await ctx.req("PUT", `/api/companies/${ctx.company.id}/standing-rules`, { text: "Never force-push." });
    const b = await briefFor(ctx.dev.id, "worker");
    expect(b).toContain("Weigh them against the rest of the brief");
    expect(b).not.toContain("Follow them like any other instruction");
  });

  it("lists past versions newest first with who and line counts, and puts one back as a new undoable change", async () => {
    const url = `/api/companies/${ctx.company.id}/standing-rules`;
    await ctx.req("PUT", url, { text: "A\nB" });
    const ceo = await ctx.mcp(ctx.ceo.id);
    await ceo.callTool({ name: "standing_rules", arguments: { action: "write", text: "A\nC\nD" } });
    await ctx.req("PUT", url, { text: "Z" });
    const hist = (await ctx.req("GET", `${url}/history`)).json() as { versions: Array<{ id: string; by: string; added: number; removed: number; before: string; after: string }> };
    expect(hist.versions.map((v) => v.after)).toEqual(["Z", "A\nC\nD", "A\nB"]);
    expect(hist.versions[0]).toMatchObject({ by: "the owner", added: 1, removed: 3, before: "A\nC\nD" });
    expect(hist.versions[1]).toMatchObject({ added: 2, removed: 1 });
    expect(hist.versions[2]).toMatchObject({ added: 2, removed: 0 });
    // A CEO save is attributed to the CEO, not to the owner.
    expect(hist.versions[1]!.by).not.toBe("the owner");

    const put = await ctx.req("POST", `${url}/put-back`, { changeId: hist.versions[1]!.id });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { text: string }).text).toBe("A\nC\nD");
    const after = (await ctx.req("GET", `${url}/history`)).json() as { versions: Array<{ after: string }> };
    expect(after.versions).toHaveLength(4);
    expect(after.versions[0]!.after).toBe("A\nC\nD");
    const log = await ctx.db.select().from(activity).where(eq(activity.companyId, ctx.company.id));
    expect(log.some((a) => a.summary === "Owner put back an earlier version of the standing rules")).toBe(true);
    const undone = await ctx.req("POST", `${url}/undo`);
    expect((undone.json() as { text: string }).text).toBe("Z");
  });

  it("keeps only the last 20 changes, and refuses a put-back of an unknown version", async () => {
    const url = `/api/companies/${ctx.company.id}/standing-rules`;
    for (let i = 0; i < 22; i++) await ctx.req("PUT", url, { text: `v${i}` });
    const hist = (await ctx.req("GET", `${url}/history`)).json() as { versions: Array<{ after: string }> };
    expect(hist.versions).toHaveLength(20);
    expect(hist.versions[0]!.after).toBe("v21");
    const bad = await ctx.req("POST", `${url}/put-back`, { changeId: randomUUID() });
    expect(bad.statusCode).toBe(400);
    // An unknown company is a 404 on both routes, and a company with no changes has an empty list.
    expect((await ctx.req("GET", `/api/companies/${randomUUID()}/standing-rules/history`)).statusCode).toBe(404);
    expect((await ctx.req("POST", `/api/companies/${randomUUID()}/standing-rules/put-back`, { changeId: randomUUID() })).statusCode).toBe(404);
    const other = (await ctx.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } };
    expect(((await ctx.req("GET", `/api/companies/${other.company.id}/standing-rules/history`)).json() as { versions: unknown[] }).versions).toEqual([]);
    // A version of another company can't be put back here.
    const mine = (hist.versions as Array<{ after: string }>)[0]!;
    expect(mine.after).toBe("v21");
  });
});
