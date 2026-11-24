// BOS-2497: a board card leaves out the ticket's long text (the board refreshes every 10 s). The plan comes as hasPlan;
// the description only with ?text=1, which the search box asks for.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { tickets } from "../src/db/schema.js";
import { boardCardFields } from "../src/services/work.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

type Card = Record<string, unknown> & { id: string };
type BoardBody = { columns: Array<{ tickets: Card[] }> };

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  const make = async (title: string) => (await req("POST", `/api/projects/${project.id}/tickets`, { title })).json() as { id: string };
  const card = async (id: string, q = "") => ((await req("GET", `/api/projects/${project.id}/board${q}`)).json() as BoardBody).columns.flatMap((c) => c.tickets).find((t) => t.id === id)!;
  const size = async (q = "") => (await req("GET", `/api/projects/${project.id}/board${q}`)).body.length;
  return { ...built, db, close, make, card, size, companyId: company.id, projectId: project.id };
}

// The long text, and a sample of the row's other columns the page doesn't read.
const LONG = ["plan", "ceoPlan", "stateNote", "ownerSetup", "ownerSetupOverride", "ownerSetupWhy", "ownerSetupIfSkipped", "acceptanceCriteria", "diffFiles", "liveEvidence", "monitorNote", "projectId", "companyId", "createdAt", "customFields", "baseCommit"];

describe("board card fields (BOS-2497)", () => {
  it("sends no long text, hasPlan for the plan, and the description only with ?text=1", async () => {
    ctx = await setup();
    const withPlan = await ctx.make("Has a plan");
    const noPlan = await ctx.make("No plan yet");
    await ctx.db
      .update(tickets)
      .set({ body: "The kanban refresh is slow.", plan: "1. Trim the card.", ceoPlan: "Do it", stateNote: "Working on it", ownerSetup: "Settings → Server", ownerSetupWhy: "why", ownerSetupIfSkipped: "nothing breaks", acceptanceCriteria: [{ text: "fast", when: "before_merge" }] as never, diffFiles: ["a.ts"], liveEvidence: "seen", monitorNote: "ok" })
      .where(eq(tickets.id, withPlan.id));

    const plain = await ctx.card(withPlan.id);
    for (const k of LONG) expect(plain, k).not.toHaveProperty(k);
    expect(plain).not.toHaveProperty("body");
    expect(plain.hasPlan).toBe(true);
    expect(plain.title).toBe("Has a plan");
    expect((await ctx.card(noPlan.id)).hasPlan).toBe(false);

    const searched = await ctx.card(withPlan.id, "?text=1");
    expect(searched.body).toBe("The kanban refresh is slow.");
    for (const k of LONG) expect(searched, k).not.toHaveProperty(k);
    // With every done ticket asked for as well (what the search box sends).
    expect((await ctx.card(withPlan.id, "?done=all&text=1")).body).toBe("The kanban refresh is slow.");
  });

  // The ticket's seed: 175 open and 50 done tickets with 2 KB descriptions. Before this change a card was the whole ticket
  // row plus the board's own fields, so today's size is the ?text=1 response plus, per card, the row's columns it no longer sends.
  it("a refresh of 175 open and 50 done cards with 2 KB descriptions is at most a quarter of today's size", async () => {
    ctx = await setup();
    const words = "The board refresh sends every card to the page every ten seconds. ";
    const body = words.repeat(Math.ceil(2048 / words.length)).slice(0, 2048);
    const row = (i: number, systemState: "ready" | "done") => ({ companyId: ctx!.companyId, projectId: ctx!.projectId, title: `Seeded ticket ${i}`, systemState, body, number: i + 1 });
    await ctx.db.insert(tickets).values([...Array.from({ length: 175 }, (_, i) => row(i, "ready")), ...Array.from({ length: 50 }, (_, i) => row(175 + i, "done"))]);
    const plain = await ctx.size();
    const withText = await ctx.size("?text=1");
    expect(withText).toBeGreaterThan(225 * 2048);
    // What `...t` used to add on top: each row's JSON less the fields still sent (its sent fields and body, and the braces).
    const rows = await ctx.db.select().from(tickets).where(eq(tickets.projectId, ctx.projectId));
    const dropped = rows.reduce((n, r) => n + JSON.stringify(r).length - JSON.stringify({ ...boardCardFields(r), body: r.body }).length, 0);
    const today = withText + dropped;
    expect(plain * 4, `refresh ${plain} bytes, searching ${withText}, today ${today}`).toBeLessThanOrEqual(today);
  });
});
