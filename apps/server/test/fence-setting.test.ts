// The company's agent fence setting (BOS-325): off by default, watch asks capable runners to fence,
// enforce is locked, and a fenced run's kernel refusals reach the permission log.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { FENCE_DENIED_PATTERN, FENCE_OFF_CONSEQUENCE, type RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, agents, companies, decisions, runners, wakes } from "../src/db/schema.js";
import { FENCE_HELD, FENCE_KEEP_OFF, FENCE_KEEP_STOPPED, FENCE_RUN_UNFENCED, FENCE_TO_WATCH, fenceCardKey, fenceDefaultSweep, fenceUnavailableKey } from "../src/services/fence-default.js";

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
  const report = (level: "full" | "partial" | "unavailable") => built.runners.recordSandbox(runnerRow!.id, { landlockAbi: level === "unavailable" ? 1 : level === "partial" ? 4 : 6, errno: null, level, missing: [], userns: false, probe: null }, new Date());
  return { ...built, db, close, req, company, runnerRow: runnerRow!, launch, commands, report };
}

describe("the fence setting (BOS-325)", () => {
  it("a new company starts at watch, unchosen, and its runner that can fence is asked to (BOS-940)", async () => {
    const c = (ctx = await setup(["fence"]));
    expect((await c.req("GET", "/api/companies")).json()[0]).toMatchObject({ fenceMode: "watch", fenceModeChosenAt: null });
    expect(await c.launch()).toMatchObject({ fence: true });
  });

  it("off asks for no fence, even of a runner that can fence", async () => {
    const c = (ctx = await setup(["fence"]));
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "off" })).statusCode).toBe(200);
    expect(await c.launch()).not.toHaveProperty("fence");
  });

  it("watch asks a runner that can fence to fence the run, and doesn't ask one without the fence feature", async () => {
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
    expect((await c.req("GET", "/api/companies")).json()[0]).toMatchObject({ fenceMode: "watch", fenceModeChosenAt: null });
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

describe("the fence stops being off by unspoken default (DR-049 point 3, BOS-940)", () => {
  const mode = async (c: NonNullable<typeof ctx>) => (await c.db.select({ m: companies.fenceMode, at: companies.fenceModeChosenAt }).from(companies).where(eq(companies.id, c.company.id)))[0]!;
  const cards = (c: NonNullable<typeof ctx>) => c.db.select().from(decisions).where(eq(decisions.dedupeKey, fenceCardKey(c.company.id)));
  /** A company made before BOS-940: still at the old default Off, never chosen. */
  const oldOff = (c: NonNullable<typeof ctx>) => c.db.update(companies).set({ fenceMode: "off", fenceModeChosenAt: null }).where(eq(companies.id, c.company.id));

  it("never changes a mode by itself: an unchosen watch on a runner that can't fence stays watch, and nobody chose Off (BOS-373)", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("full");
    expect(await fenceDefaultSweep(c.db, new Date())).toEqual({ raised: 0, heldCards: 0, released: 0 });
    expect(await mode(c)).toEqual({ m: "watch", at: null });
    await c.report("unavailable");
    await fenceDefaultSweep(c.db, new Date());
    expect(await mode(c)).toEqual({ m: "watch", at: null });
  });

  it("never turns off a watch the owner chose, even when the host loses its fence", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("full");
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" })).statusCode).toBe(200);
    expect((await mode(c)).at).not.toBeNull();
    await c.report("unavailable");
    await fenceDefaultSweep(c.db, new Date());
    expect((await mode(c)).m).toBe("watch");
  });

  it("an old unchosen off gets one owner-only card; nothing changes until it is answered, and Switch to Watch applies", async () => {
    const c = (ctx = await setup(["fence"]));
    await oldOff(c);
    // A runner that can't fence isn't asked: Watch would do nothing there.
    await c.report("unavailable");
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ raised: 0 });
    await c.report("partial");
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ raised: 1 });
    // Repeated passes (each minute, each boot) never add a second card.
    for (let i = 0; i < 3; i++) expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ raised: 0 });
    const [card] = await cards(c);
    expect(card).toMatchObject({ status: "open", tier: "owner", options: [FENCE_TO_WATCH, FENCE_KEEP_OFF], recommendedOption: FENCE_TO_WATCH });
    expect(card!.question).toContain(FENCE_OFF_CONSEQUENCE);
    expect(await mode(c)).toEqual({ m: "off", at: null });
    // The CEO can neither answer nor withdraw it.
    const [ceo] = await c.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.role, "ceo")));
    await expect(c.decisions.answer(card!.id, FENCE_TO_WATCH, { settledBy: { agentId: ceo!.id } } as never)).rejects.toThrow(/Only the owner/);
    await expect(c.decisions.withdraw(card!.id, { agentId: ceo!.id }, "duplicate")).rejects.toThrow();
    expect(await mode(c)).toEqual({ m: "off", at: null });
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: FENCE_TO_WATCH })).statusCode).toBe(200);
    const after = await mode(c);
    expect(after.m).toBe("watch");
    expect(after.at).not.toBeNull();
    expect(await c.launch()).toMatchObject({ fence: true });
  });

  it("Keep Off is a choice: the mode stays off, is marked chosen, and is never asked about again", async () => {
    const c = (ctx = await setup(["fence"]));
    await oldOff(c);
    await c.report("full");
    await fenceDefaultSweep(c.db, new Date());
    const [card] = await cards(c);
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: FENCE_KEEP_OFF })).statusCode).toBe(200);
    expect((await mode(c)).m).toBe("off");
    expect((await mode(c)).at).not.toBeNull();
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ raised: 0 });
    expect(await cards(c)).toHaveLength(1);
  });

  it("Switch to Watch is refused, and the card stays open, if the runner can no longer fence", async () => {
    const c = (ctx = await setup(["fence"]));
    await oldOff(c);
    await c.report("full");
    await fenceDefaultSweep(c.db, new Date());
    const [card] = await cards(c);
    await c.report("unavailable");
    const r = await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: FENCE_TO_WATCH });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toMatch(/can't fence agents right now/);
    expect((await cards(c))[0]!.status).toBe("open");
    expect(await mode(c)).toEqual({ m: "off", at: null });
  });

  it("choosing in Settings closes the open card, and a choice made there is not overwritten by a late answer", async () => {
    const c = (ctx = await setup(["fence"]));
    await oldOff(c);
    await c.report("full");
    await fenceDefaultSweep(c.db, new Date());
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "off" })).statusCode).toBe(200);
    expect((await cards(c))[0]!.status).toBe("withdrawn");
    expect((await mode(c)).at).not.toBeNull();
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ raised: 0 });
  });

  it("the fence_watch_by_default migration marks only the companies already at watch or enforce as chosen, and changes no mode", async () => {
    const c = (ctx = await setup(["fence"]));
    // Found by name, not number: main keeps taking the next migration number while this waits to merge.
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
    const [name] = readdirSync(dir).filter((f) => f.endsWith("_fence_watch_by_default.sql"));
    const file = readFileSync(path.join(dir, name!), "utf8");
    const update = file.slice(file.indexOf('UPDATE "companies"')).trim();
    expect(update).toMatch(/^UPDATE "companies" SET "fence_mode_chosen_at" = now\(\) WHERE "fence_mode" <> 'off';$/);
    const [other] = await c.db.insert(companies).values({ name: "Fenced Co", fenceMode: "watch" }).returning();
    await oldOff(c);
    await c.db.execute(sql.raw(update));
    expect(await mode(c)).toEqual({ m: "off", at: null });
    const [o] = await c.db.select().from(companies).where(eq(companies.id, other!.id));
    expect(o).toMatchObject({ fenceMode: "watch" });
    expect(o!.fenceModeChosenAt).not.toBeNull();
  });
});

describe("no agent run goes unfenced unless the owner chose Off (BOS-373)", () => {
  const heldCards = (c: NonNullable<typeof ctx>) => c.db.select().from(decisions).where(and(eq(decisions.companyId, c.company.id), sql`${decisions.context}->>'type' = 'fence_unavailable'`));
  const workWakes = (c: NonNullable<typeof ctx>) => c.db.select({ status: wakes.status, statusReason: wakes.statusReason, reason: wakes.reason }).from(wakes).where(and(eq(wakes.companyId, c.company.id), isNull(wakes.runId)));

  it("holds agent work while the runner reports it can't fence, at a watch the owner chose and at an unchosen one, and says why", async () => {
    for (const chosen of [true, false]) {
      const c = (ctx = await setup(["fence"]));
      await c.report("full");
      if (chosen) await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "watch" });
      // The host gets worse after Watch was saved: a kernel downgrade, a move into an LXC.
      await c.report("unavailable");
      expect(await c.launch(), `chosen=${chosen}`).toBeUndefined();
      const waiting = await workWakes(c);
      expect(waiting.length).toBeGreaterThan(0);
      for (const w of waiting) expect(w).toMatchObject({ status: "queued", statusReason: FENCE_HELD });
      await c.app.close();
      await c.close();
      ctx = undefined;
    }
  });

  it("holds an Off nobody chose too, and lets the owner's own Off through, unfenced", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.db.update(companies).set({ fenceMode: "off", fenceModeChosenAt: null }).where(eq(companies.id, c.company.id));
    await c.report("unavailable");
    expect(await c.launch()).toBeUndefined();
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "off" })).statusCode).toBe(200);
    await c.req("POST", "/api/scheduler/tick");
    expect(c.commands[0]).toBeDefined();
    expect(c.commands[0]).not.toHaveProperty("fence");
  });

  it("still starts the owner's chat with the CEO, which has board tools only", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("unavailable");
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "How is it going?" })).statusCode).toBe(201);
    await c.req("POST", "/api/scheduler/tick");
    expect(c.commands.find((s) => s.boardToolsOnly)).toBeDefined();
  });

  it("holds the owner's chat with a worker, which has file and shell tools (BOS-1300)", async () => {
    const c = (ctx = await setup(["fence"]));
    const [worker] = await c.db.insert(agents).values({ companyId: c.company.id, name: "Wendy", role: "worker", agentKind: "claude" }).returning();
    await c.report("unavailable");
    expect((await c.req("POST", `/api/companies/${c.company.id}/chat`, { text: "Can you look at the logs?", agentId: worker!.id })).statusCode).toBe(201);
    await c.req("POST", "/api/scheduler/tick");
    expect(c.commands.find((s) => s.agentId === worker!.id)).toBeUndefined();
    const [held] = await c.db.select({ status: wakes.status, statusReason: wakes.statusReason }).from(wakes).where(and(eq(wakes.agentId, worker!.id), isNull(wakes.runId)));
    expect(held).toMatchObject({ status: "queued", statusReason: FENCE_HELD });
  });

  it("starts fenced again by itself once the runner can fence", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("unavailable");
    expect(await c.launch()).toBeUndefined();
    await c.report("partial");
    await c.req("POST", "/api/scheduler/tick");
    expect(c.commands[0]).toMatchObject({ fence: true });
  });

  it("raises one owner card with the two ways out, withdraws it when the runner can fence, and asks again on a later episode", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("unavailable");
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ heldCards: 1 });
    for (let i = 0; i < 3; i++) expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ heldCards: 0 });
    const [card] = await heldCards(c);
    expect(card).toMatchObject({ status: "open", tier: "owner", options: [FENCE_KEEP_STOPPED, FENCE_RUN_UNFENCED], recommendedOption: FENCE_KEEP_STOPPED, dedupeKey: fenceUnavailableKey(c.company.id) });
    expect(card!.question).toContain(FENCE_OFF_CONSEQUENCE);
    expect(card!.question).toContain("Chat with the CEO still works");
    // The CEO can't answer it for the owner.
    const [ceo] = await c.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.role, "ceo")));
    await expect(c.decisions.answer(card!.id, FENCE_RUN_UNFENCED, { settledBy: { agentId: ceo!.id } } as never)).rejects.toThrow(/Only the owner/);
    await c.report("full");
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ released: 1 });
    expect((await heldCards(c))[0]).toMatchObject({ status: "withdrawn", dedupeKey: null });
    await c.report("unavailable");
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ heldCards: 1 });
    expect((await heldCards(c)).filter((d) => d.status === "open")).toHaveLength(1);
  });

  it("\"Run agents without the fence\" is the owner's Off: recorded as chosen, and held work starts unfenced", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("unavailable");
    expect(await c.launch()).toBeUndefined();
    await fenceDefaultSweep(c.db, new Date());
    const [card] = await heldCards(c);
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: FENCE_RUN_UNFENCED })).statusCode).toBe(200);
    const [co] = await c.db.select({ m: companies.fenceMode, at: companies.fenceModeChosenAt }).from(companies).where(eq(companies.id, c.company.id));
    expect(co!.m).toBe("off");
    expect(co!.at).not.toBeNull();
    await c.req("POST", "/api/scheduler/tick");
    expect(c.commands[0]).toBeDefined();
    expect(c.commands[0]).not.toHaveProperty("fence");
  });

  it("\"Keep agents stopped\" keeps the work held and isn't asked again in the same episode; choosing Off in Settings withdraws an open card", async () => {
    const c = (ctx = await setup(["fence"]));
    await c.report("unavailable");
    await fenceDefaultSweep(c.db, new Date());
    const [card] = await heldCards(c);
    expect((await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: FENCE_KEEP_STOPPED })).statusCode).toBe(200);
    expect(await fenceDefaultSweep(c.db, new Date())).toMatchObject({ heldCards: 0 });
    expect(await c.launch()).toBeUndefined();
    // A new episode's card, then Off from Settings.
    await c.report("full");
    await fenceDefaultSweep(c.db, new Date());
    await c.report("unavailable");
    await fenceDefaultSweep(c.db, new Date());
    expect((await heldCards(c)).filter((d) => d.status === "open")).toHaveLength(1);
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "off" })).statusCode).toBe(200);
    expect((await heldCards(c)).filter((d) => d.status === "open")).toHaveLength(0);
  });
});

describe("the activity log for fence, advice and run limit changes (BOS-2063)", () => {
  const lines = async (c: Awaited<ReturnType<typeof setup>>) =>
    (await c.db.select().from(activity).where(and(eq(activity.companyId, c.company.id), eq(activity.kind, "settings")))).map((a) => a.summary);

  it("records each changed setting with its new value, and nothing for an unchanged one", async () => {
    const c = (ctx = await setup(["fence"]));
    const url = `/api/companies/${c.company.id}`;
    expect((await c.req("PATCH", url, { fenceMode: "off", permissionJudge: "advise", maxRunMinutes: 90 })).statusCode).toBe(200);
    expect(await lines(c)).toEqual(expect.arrayContaining(["Owner set the agent fence to Off", "Owner set permission-card advice to Advise", "Owner set runs to end after 90 minutes"]));
    expect(await lines(c)).toHaveLength(3);
    // The same values again change nothing, so add no lines.
    await c.req("PATCH", url, { fenceMode: "off", permissionJudge: "advise", maxRunMinutes: 90 });
    expect(await lines(c)).toHaveLength(3);
    await c.req("PATCH", url, { maxRunMinutes: null });
    expect(await lines(c)).toContain("Owner removed the run time limit");
    // Other fields leave no line.
    await c.req("PATCH", url, { name: "Renamed Co" });
    expect(await lines(c)).toHaveLength(4);
  });

  it("a refused fence change and an unknown company write nothing", async () => {
    const c = (ctx = await setup(["fence"]));
    expect((await c.req("PATCH", `/api/companies/${c.company.id}`, { fenceMode: "enforce" })).statusCode).toBe(400);
    expect((await c.req("PATCH", "/api/companies/00000000-0000-4000-8000-000000000000", { fenceMode: "off", maxRunMinutes: 5 })).statusCode).toBe(404);
    expect(await lines(c)).toEqual([]);
  });
});
