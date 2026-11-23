// BOS-2376: a skill's history lists its log rows (added, edited, proposed, installed) newest first, with before/after text for an edit.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { record } from "../src/services/activity.js";

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
  const req = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  return { ...built, close, company, req };
}

describe("BOS-2376: skill history", () => {
  it("shows the add and the edit with before and after text, and nothing from another skill", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const mk = async (name: string) => ((await c.req("POST", base, { from: "written", name, description: "Does it.", body: "one\ntwo" })).json() as Array<{ id: string }>)[0]!.id;
    const id = await mk("tidy");
    const other = await mk("sweep");
    expect((await c.req("PUT", `${base}/${id}`, { name: "tidy", description: "Does it.", body: "one\nthree" })).statusCode).toBe(200);

    const h = (await c.req("GET", `${base}/${id}/history`)).json() as Array<{ what: string; who: string; change: { before: string; after: string } | null }>;
    expect(h.map((x) => x.what)).toEqual(["Edited by you", "Added by you"]);
    expect(h[0]!.who).toBe("you");
    expect(h[0]!.change?.before).toContain("two");
    expect(h[0]!.change?.after).toContain("three");
    expect(h[1]!.change).toBeNull();

    const o = (await c.req("GET", `${base}/${other}/history`)).json() as unknown[];
    expect(o).toHaveLength(1);
  });

  it("includes a retro revert, newest first, and refuses another company's skill", async () => {
    const c = (ctx = await setup());
    const base = `/api/companies/${c.company.id}/skills`;
    const id = ((await c.req("POST", base, { from: "written", name: "tidy", description: "Does it.", body: "one" })).json() as Array<{ id: string }>)[0]!.id;
    await c.req("PUT", `${base}/${id}`, { name: "tidy", description: "Does it.", body: "two" });
    const detail = { skillId: id, skillMd: { before: "two", after: "one" } };
    await record(c.db, { companyId: c.company.id, kind: "skill.reverted_by_retro", summary: "Workflow Revert put the playbook tidy back.", detail, at: new Date(Date.now() + 60_000) });
    const h = (await c.req("GET", `${base}/${id}/history`)).json() as Array<{ what: string; who: string; change: { before: string; after: string } | null }>;
    expect(h.map((x) => x.what)).toEqual(["Put back by a workflow retro", "Edited by you", "Added by you"]);
    expect(h[0]!.who).toBe("Boss Man");
    expect(h[0]!.change).toEqual({ before: "two", after: "one" });

    const other = ((await c.req("POST", "/api/companies", { name: "Other Co" })).json() as { company: { id: string } }).company.id;
    expect((await c.req("GET", `/api/companies/${other}/skills/${id}/history`)).statusCode).toBe(404);
  });

  it("is a 404 for a skill that does not exist", async () => {
    const c = (ctx = await setup());
    const r = await c.req("GET", `/api/companies/${c.company.id}/skills/00000000-0000-4000-8000-000000000000/history`);
    expect(r.statusCode).toBe(404);
  });
});
