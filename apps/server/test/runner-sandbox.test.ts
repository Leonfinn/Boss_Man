// The runner's start-up self-test of the agent fence (BOS-321): stored per runner and shown with
// the runner's status, so Settings can say how well this server fences agents (Sandbox 5).
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RunnerEvent, type SandboxReport } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { runners } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const clock = new Date("2026-11-02T10:00:00Z");
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, now: () => clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: object) => built.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const report = async (r: SandboxReport) => {
    await built.runners.ingest(runnerRow!, { seq: ++seq, at: clock.toISOString(), event: { type: "runner.sandbox", report: r } });
    await new Promise((res) => setTimeout(res, 50));
  };
  return { ...built, db, close, req, company, clock, report };
}

const FULL: SandboxReport = { landlockAbi: 6, errno: null, level: "full", missing: [], userns: false, probe: true };

describe("the runner's fence self-test (BOS-321)", () => {
  it("is stored per runner and shown with its status, latest report winning", async () => {
    const c = (ctx = await setup());
    expect((await c.req("GET", `/api/companies/${c.company.id}/runner`)).json()).toMatchObject({ registered: true, sandbox: null, sandboxCheckedAt: null });

    const off: SandboxReport = { landlockAbi: 0, errno: "EOPNOTSUPP", level: "unavailable", missing: [], userns: false, probe: null };
    await c.report(off);
    expect((await c.req("GET", `/api/companies/${c.company.id}/runner`)).json()).toMatchObject({ sandbox: off, sandboxCheckedAt: c.clock.toISOString() });

    await c.report(FULL);
    expect((await c.db.select().from(runners))[0]).toMatchObject({ sandbox: FULL });
  });

  it("accepts only a well-formed report", () => {
    expect(RunnerEvent.safeParse({ type: "runner.sandbox", report: FULL }).success).toBe(true);
    expect(RunnerEvent.safeParse({ type: "runner.sandbox", report: { ...FULL, level: "maybe" } }).success).toBe(false);
    expect(RunnerEvent.safeParse({ type: "runner.sandbox", report: { ...FULL, missing: Array(11).fill("x") } }).success).toBe(false);
  });
});
