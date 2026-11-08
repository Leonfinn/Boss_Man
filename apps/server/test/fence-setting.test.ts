// The company's agent fence setting (BOS-325): off by default, watch asks capable runners to fence,
// enforce is locked, and a fenced run's kernel refusals reach the permission log.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FENCE_DENIED_PATTERN, type RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(features: string[]) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" } as never);
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json() as { id: string };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  const commands: Extract<RunnerCommand, { type: "run.start" }>[] = [];
  built.runners.connect(reg.runnerId, (c) => (c.type === "run.start" && commands.push(c), true), features);
  const launch = async () => {
    commands.length = 0;
    await req("POST", `/api/projects/${project.id}/tickets`, { title: "Work", assigneeAgentId: ceo.id });
    await req("POST", "/api/scheduler/tick");
    return commands[0]!;
  };
  return { ...built, db, close, req, company, runnerRow: runnerRow!, launch, commands };
}

describe("the fence setting (BOS-325)", () => {
  it("defaults to off: no fence is asked for, even of a runner that can fence", async () => {
    const c = (ctx = await setup(["fence"]));
    expect((await c.req("GET", "/api/companies")).json()[0]).toMatchObject({ fenceMode: "off" });
    expect(await c.launch()).not.toHaveProperty("fence");
  });

  it("watch asks a runner that can fence to fence the run, and leaves one that can't alone", async () => {
    const c = (ctx = await setup(["fence"]));
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" })).statusCode).toBe(200);
    expect(await c.launch()).toMatchObject({ fence: true });
    await ctx.app.close();
    await ctx.close();
    const d = (ctx = await setup([]));
    await d.req("PATCH", `/api/companies/${d.company.id}`, { fenceMode: "watch" });
    expect(await d.launch()).not.toHaveProperty("fence");
  });

  it("refuses enforce for now, and anything that isn't a mode", async () => {
    const c = (ctx = await setup(["fence"]));
    const r = await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "enforce" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "fence_enforce_locked" });
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "strict" })).statusCode).toBe(400);
    expect((await c.req("GET", "/api/companies")).json()[0]).toMatchObject({ fenceMode: "off" });
  });

  it("refuses watch on a runner that reported it can't fence, and keeps a saved mode (BOS-555)", async () => {
    const c = (ctx = await setup(["fence"]));
    const report = (level: "full" | "partial" | "unavailable") => c.runners.recordSandbox(c.runnerRow.id, { landlockAbi: level === "unavailable" ? 1 : level === "partial" ? 4 : 6, errno: null, level, missing: [], userns: false, probe: null }, new Date());
    // Saved while the host could fence; the host then loses Landlock (a kernel downgrade, a new profile).
    await report("full");
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" })).statusCode).toBe(200);
    await report("unavailable");
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { name: "Renamed Co" })).statusCode).toBe(200);
    expect((await c.req("GET", "/api/companies")).json()[0]).toMatchObject({ fenceMode: "watch" });
    // Off stays allowed; switching back to watch is refused with the per-host fix.
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "off" })).statusCode).toBe(200);
    const r = await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "fence_unavailable" });
    expect(r.json().message).toMatch(/Watch would do nothing.*5\.19/);
    expect((await c.req("GET", "/api/companies")).json()[0]).toMatchObject({ fenceMode: "off" });
    // A partial host may watch.
    await report("partial");
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" })).statusCode).toBe(200);
  });

  it("logs a fenced run's kernel refusal and nothing for an ordinary failed call", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" });
    const cmd = await c.launch();
    let seq = 0;
    const update = (u: object) => c.runners.ingest(c.runnerRow, { seq: ++seq, at: new Date().toISOString(), event: { type: "run.update", runId: cmd.runId, update: u } });
    await update({ kind: "tool_call_update", title: "cat /etc/shadow", status: "failed", fenceDenied: true });
    await update({ kind: "tool_call_update", title: "ls", status: "failed" });
    await new Promise((r) => setTimeout(r, 100));
    const sum = (await c.serverStatus.status(c.company.id)).permissions as { fenceRefusals: { count: number; recent: Array<Record<string, unknown>> } };
    expect(sum.fenceRefusals.count).toBe(1);
    expect(sum.fenceRefusals.recent[0]).toMatchObject({ runId: cmd.runId, tool: "cat /etc/shadow" });
  });

  it("recognises the kernel's refusal wording", () => {
    for (const t of ["cat: /etc/x: Permission denied", "Operation not permitted", "EACCES: permission denied, open", "EPERM"]) expect(FENCE_DENIED_PATTERN.test(t)).toBe(true);
    for (const t of ["No such file or directory", "exit code 1", "User refused permission"]) expect(FENCE_DENIED_PATTERN.test(t)).toBe(false);
  });
});
