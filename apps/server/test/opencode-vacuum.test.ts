// The runner killed the OpenCode prune's one-off VACUUM at its cap (BOS-622): one CEO card per
// runner per day, saying OpenCode runs are going again and the database is intact.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RunnerEvent } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, runners } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  let clock = new Date("2026-11-07T10:00:00Z");
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, now: () => clock });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: object) => built.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  const [runnerRow] = await db.select().from(runners).where(eq(runners.id, reg.runnerId));
  let seq = 0;
  const cut = async (heldSeconds: number, agentHome = false) => {
    await built.runners.ingest(runnerRow!, { seq: ++seq, at: clock.toISOString(), event: { type: "runner.opencode_vacuum_cut", heldSeconds, bytes: 20 * 1024 ** 3, agentHome } });
    await new Promise((res) => setTimeout(res, 100));
  };
  const cards = () => db.select().from(decisions).where(eq(decisions.companyId, company.id));
  return { ...built, db, close, company, runnerId: reg.runnerId, cut, cards, setClock: (d: Date) => (clock = d) };
}

describe("a killed OpenCode VACUUM (BOS-622)", () => {
  it("raises one CEO card per runner per day, in plain words", async () => {
    const c = (ctx = await setup());
    await c.cut(1800);
    const [card, ...rest] = await c.cards();
    expect(rest).toEqual([]);
    expect(card).toMatchObject({ status: "open", tier: "ceo", dedupeKey: `opencode-vacuum:${c.runnerId}:2026-11-07` });
    expect(card!.question).toMatch(/stopped the one-off compaction \(VACUUM\) of the runner's OpenCode database \(20\.0 GB\) after 30 min/);
    expect(card!.question).toMatch(/OpenCode runs are going again/);
    expect(card!.question).toMatch(/BOSSMAN_OPENCODE_SESSION_DAYS=0/);

    // Another cut the same day (an agent's database this time) doesn't make a second card.
    await c.cut(1801, true);
    expect(await c.cards()).toHaveLength(1);
    // The next day it does.
    c.setClock(new Date("2026-11-08T10:00:00Z"));
    await c.cut(1800, true);
    const all = await c.cards();
    expect(all).toHaveLength(2);
    expect(all.find((d) => d.dedupeKey?.endsWith("2026-11-08"))!.question).toMatch(/a fenced agent's own OpenCode database/);
  });

  it("accepts only a well-formed report", () => {
    const ok = { type: "runner.opencode_vacuum_cut", heldSeconds: 1800, bytes: 1, agentHome: false };
    expect(RunnerEvent.safeParse(ok).success).toBe(true);
    expect(RunnerEvent.safeParse({ ...ok, heldSeconds: -1 }).success).toBe(false);
    expect(RunnerEvent.safeParse({ ...ok, heldSeconds: 1.5 }).success).toBe(false);
    expect(RunnerEvent.safeParse({ ...ok, agentHome: "yes" }).success).toBe(false);
  });
});
