// BOS-2244 (R58): a command that runs a program through a variable it set itself is refused at once, with the rewrite, and raises no card.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runs } from "../src/db/schema.js";
import { decisionsService } from "../src/services/decisions.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const sent: Array<Record<string, unknown>> = [];
  const svc = decisionsService(db, (_runnerId, command) => (sent.push(command as Record<string, unknown>), true), undefined, undefined, undefined, "/ws");
  return { app: built.app, db, close, company, worker, svc, sent };
}

async function ask(c: Awaited<ReturnType<typeof setup>>, command: string) {
  const runId = randomUUID();
  await c.db.insert(runs).values({ id: runId, companyId: c.company.id, agentId: c.worker.id, startedAt: new Date() });
  const result = await c.svc.onPermissionRequest({ id: randomUUID(), companyId: c.company.id }, { type: "run.permission_request", runId, requestId: randomUUID(), title: command, kind: "execute", rawInput: { command }, optionKinds: ["allow_once", "reject_once"] } as never);
  const cards = await c.db.select().from(decisions).where(eq(decisions.companyId, c.company.id));
  return { result, cards };
}

describe("self-set variable commands (BOS-2244)", () => {
  it("refuses a variable program at once with the rewrite, and raises no card", async () => {
    const c = (ctx = await setup());
    const { result, cards } = await ask(c, 'R=/home/node/workspaces/tickets/x; G="git -C $R"; $G grep -n x');
    expect(result.outcome).toBe("deny");
    expect(cards).toHaveLength(0);
    const message = c.sent.find((m) => m["type"] === "run.message");
    expect(String(message?.["text"])).toContain("$G");
    expect(String(message?.["text"])).toMatch(/Type the command out in full/);
    expect(c.sent.find((m) => m["type"] === "permission.decide")).toMatchObject({ verdict: "deny" });
  });
  it("still raises a card for a variable it can't read (read, $(...)) and for a plain destructive command", async () => {
    const c = (ctx = await setup());
    for (const cmd of ["read G; $G status", "G=$(cat /tmp/g); $G status", "rm -rf /etc"]) {
      const before = (await c.db.select().from(decisions)).length;
      const { result, cards } = await ask(c, cmd);
      expect(result.outcome, cmd).not.toBe("deny");
      expect(cards.length, cmd).toBe(before + 1);
    }
    expect(c.sent.some((m) => m["type"] === "run.message")).toBe(false);
  });
});
