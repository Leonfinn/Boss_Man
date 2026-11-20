import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity } from "../src/db/schema.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const a = (await req("POST", "/api/companies", { name: "Homelab Co" })).json().company;
  const b = (await req("POST", "/api/companies", { name: "App Co" })).json().company;
  const lines = async (companyId: string) => (await db.select().from(activity).where(and(eq(activity.companyId, companyId), eq(activity.kind, "settings")))).map((r) => r.summary).filter((s) => /permission rule/.test(s));
  return { req, a, b, lines };
}

describe("permission rule changes leave an activity line (BOS-1963)", () => {
  it("records add, edit, reorder and delete for a company rule, and only against that company", async () => {
    const c = await setup();
    const one = (await c.req("POST", "/api/policy-rules", { companyId: c.a.id, name: "Restarts", match: { commandPattern: "restart" }, outcome: "ceo" })).json();
    const two = (await c.req("POST", "/api/policy-rules", { companyId: c.a.id, name: "No drops", match: { commandPattern: "drop" }, outcome: "deny" })).json();
    await c.req("PATCH", `/api/policy-rules/${one.id}`, { outcome: "allow" });
    await c.req("POST", "/api/policy-rules/order", { companyId: c.a.id, ids: [two.id, one.id] });
    await c.req("DELETE", `/api/policy-rules/${two.id}`);
    const lines = await c.lines(c.a.id);
    expect(lines).toEqual([
      'Owner added the permission rule "Restarts" (outcome: ceo)',
      'Owner added the permission rule "No drops" (outcome: deny)',
      'Owner edited the permission rule "Restarts": outcome; outcome now allow',
      "Owner reordered the permission rules: No drops > Restarts",
      'Owner deleted the permission rule "No drops" (outcome was deny)',
    ]);
    expect(await c.lines(c.b.id)).toEqual([]);
  });

  it("records a rule for every company against each company", async () => {
    const c = await setup();
    const g = (await c.req("POST", "/api/policy-rules", { companyId: null, name: "Global", match: { commandPattern: "^docker" }, outcome: "owner" })).json();
    await c.req("DELETE", `/api/policy-rules/${g.id}`);
    for (const id of [c.a.id, c.b.id]) {
      expect(await c.lines(id)).toEqual([
        'Owner added the permission rule "Global" for every company (outcome: owner)',
        'Owner deleted the permission rule "Global" for every company (outcome was owner)',
      ]);
    }
  });

  it("records nothing when the change is refused", async () => {
    const c = await setup();
    expect((await c.req("DELETE", "/api/policy-rules/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await c.req("PATCH", "/api/policy-rules/00000000-0000-4000-8000-000000000000", { outcome: "deny" })).statusCode).toBe(404);
    expect(await c.lines(c.a.id)).toEqual([]);
  });
});
