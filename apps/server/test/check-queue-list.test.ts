// The live check list behind the Merge queue's "Queued checks" tab (BOS-1174): running first, then waiting in order.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkQueue } from "../src/services/check-queue.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" } as never);
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "App" })).json() as { id: string };
  const mk = async (title: string) => ((await req("POST", `/api/projects/${project.id}/tickets`, { title, assigneeAgentId: ceo.id })).json() as { id: string }).id;
  return { ...built, db, close, req, company, ceo, project, mk, queue: checkQueue(db) };
}

describe("check queue list (BOS-1174)", () => {
  it("is empty with nothing queued", async () => {
    const c = (ctx = await setup());
    const r = (await c.req("GET", `/api/companies/${c.company.id}/check-queue`)).json() as { rows: unknown[]; slots: number };
    expect(r.rows).toEqual([]);
    expect(r.slots).toBe(1);
  });

  it("lists the running check first, then the waiting ones with their place and why they wait", async () => {
    const c = (ctx = await setup());
    const [a, b, d] = [await c.mk("First"), await c.mk("Second"), await c.mk("Third")];
    const enq = (ticketId: string, kind: "merge" | "pre_review", scope: "quick" | "full", tree: string) =>
      c.queue.enqueue({ companyId: c.company.id, projectId: c.project.id, ticketId, kind, scope, commit: `c-${tree}`, tree, requestedBy: c.ceo.id });
    await enq(a, "pre_review", "quick", "t1");
    await c.queue.claimNext(null);
    await enq(b, "pre_review", "full", "t2");
    await enq(d, "merge", "full", "t3");
    const r = (await c.req("GET", `/api/companies/${c.company.id}/check-queue`)).json() as { running: number; rows: Array<{ title: string; kind: string; state: string; position: number | null; requestedBy: string | null; heldBy: string | null }> };
    expect(r.running).toBe(1);
    expect(r.rows.map((x) => [x.title, x.kind, x.state, x.position])).toEqual([
      ["First", "quick", "running", null],
      ["Third", "merge", "waiting", 1],
      ["Second", "full", "waiting", 2],
    ]);
    expect(r.rows[0]!.requestedBy).toEqual(expect.any(String));
    expect(r.rows[1]!.requestedBy).toBe("the merge gate");
    expect(r.rows[1]!.heldBy).toMatch(/slot is busy/);
    expect(r.rows[0]!.heldBy).toBeNull();
  });

  it("leaves out a check queued between the list's two reads instead of throwing", async () => {
    const c = (ctx = await setup());
    const [a, b] = [await c.mk("Seen"), await c.mk("Late")];
    const enq = (ticketId: string, tree: string) =>
      c.queue.enqueue({ companyId: c.company.id, projectId: c.project.id, ticketId, kind: "pre_review", scope: "quick", commit: `c-${tree}`, tree, requestedBy: c.ceo.id });
    await enq(a, "t1");
    // Interleave: right after the live-jobs read (the select with fields), the next argument-less select (the queue order) first queues another check.
    let armed = false;
    let fired = false;
    const real = c.db as unknown as { select: (...a: unknown[]) => { from: (t: unknown) => { where: (w: unknown) => Promise<unknown> } } };
    const wrapped = new Proxy(c.db as object, {
      get(target, prop, recv) {
        if (prop !== "select") return Reflect.get(target, prop, recv);
        return (...args: unknown[]) => {
          if (args.length) {
            armed = true;
            return real.select(...args);
          }
          if (!armed || fired) return real.select();
          fired = true;
          return { from: (t: unknown) => ({ where: async (w: unknown) => { await enq(b, "t2"); return real.select().from(t).where(w); } }) };
        };
      },
    });
    const racing = checkQueue(wrapped as never);
    const out = await racing.list(c.company.id);
    expect(fired).toBe(true);
    expect(out.rows.map((x) => x.title)).toEqual(["Seen"]);
    // The next read shows it.
    expect((await c.queue.list(c.company.id)).rows.map((x) => x.title)).toEqual(["Seen", "Late"]);
  });
});
