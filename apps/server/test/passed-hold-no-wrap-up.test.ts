// BOS-2577: a run that passed an update hold (urgent / fixes-live, runs.passed_update_hold) is never told to wrap up:
// not by the WRAP_UP line on a set_ticket_state reply, and not by the drain's or the owner's wrap-up messages.
// Every other run keeps both.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners, runs, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { WRAP_UP, WRAP_UP_ASKED } from "../src/services/maintenance.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  ctx = { close: async () => (await Promise.all(clients.map((c) => c.close().catch(() => undefined))), await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const sent: RunnerCommand[] = [];
  built.runners.connect(reg.runnerId, (c) => (sent.push(c), true));
  const [runner] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  expect(runner).toBeTruthy();
  const ticket = async () => (await req("POST", `/api/projects/${project.id}/tickets`, { title: `Work ${randomUUID().slice(0, 4)}`, assigneeAgentId: worker.id })).json();
  const startRun = async (passed: boolean) => {
    const t = await ticket();
    await db.update(tickets).set({ systemState: "ready" }).where(eq(tickets.id, t.id));
    const runId = randomUUID();
    await db.insert(runs).values({ id: runId, companyId: company.id, agentId: worker.id, ticketId: t.id, passedUpdateHold: passed, startedAt: new Date() });
    const token = await issueRunToken(db, { companyId: company.id, agentId: worker.id, runId });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return { runId, ticketId: t.id as string, c };
  };
  const setState = async (r: { c: Client; ticketId: string }) => textOf(await r.c.callTool({ name: "set_ticket_state", arguments: { ticketId: r.ticketId, state: "in_progress", summary: "Working on it." } }));
  const told = () => sent.filter((m): m is Extract<RunnerCommand, { type: "run.message" }> => m.type === "run.message").map((m) => [m.runId, m.text] as const);
  return { ...built, db, sent, startRun, setState, told };
}

describe("a run that passed an update hold is not told to wrap up (BOS-2577)", () => {
  it("leaves WRAP_UP off its set_ticket_state reply; any other run still gets it", async () => {
    const c = await setup();
    const passed = await c.startRun(true);
    const plain = await c.startRun(false);
    await c.maintenance.start({ minutes: 30 });
    expect(await c.setState(passed)).not.toContain(WRAP_UP);
    expect(await c.setState(plain)).toContain(WRAP_UP);
  });

  it("sends neither the update's message nor the owner's wrap-up to it, and still sends both to other runs", async () => {
    const c = await setup();
    const passed = await c.startRun(true);
    const plain = await c.startRun(false);
    await c.maintenance.start({ minutes: 30 });
    await c.maintenance.step();
    await c.maintenance.start({ kind: "wrapup" });
    await c.maintenance.step();
    const texts = (id: string) => c.told().filter(([r]) => r === id).map(([, t]) => t);
    expect(texts(passed.runId)).toEqual([]);
    const plainTexts = texts(plain.runId).join("\n");
    expect(plainTexts).toContain(WRAP_UP);
    expect(plainTexts).toContain("The owner asked every agent to wrap up");
    expect(WRAP_UP_ASKED).toContain("The owner asked every agent to wrap up");
  });
});
