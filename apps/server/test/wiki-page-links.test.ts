// BOS-2366: the owner's page read carries the page's links, its [[slug]]s to no page, and the pages linking to it.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { signedInOwner } from "./helpers/owner-session.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("wiki page read: links, missing pages, linked from (BOS-2366)", () => {
  it("returns live links, missing targets and backlinks; a deleted page drops out of both", async () => {
    const { db, close } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    ctx = { close: async () => (await built.app.close(), await close()) };
    const cookie = await signedInOwner(db);
    const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => built.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const page = async (title: string, body: string) => ((await req("POST", `/api/companies/${company.id}/wiki`, { title, body })).json() as { slug: string }).slug;
    const spec = await page("Spec", "See [[glossary]], [[glossary#Terms]], [[old-plan]] and [[nowhere]]. Also [[spec]] itself.");
    await page("Glossary", "Words.");
    await page("Old plan", "Gone soon.");
    await page("Roadmap", "Built on [[spec#Scope]].");
    await page("Notes", "Unrelated [[specs]].");

    const read = async () => (await req("GET", `/api/companies/${company.id}/wiki/${spec}`)).json() as { title: string; links: string[]; missingLinks: string[]; linkedFrom: string[] };
    const first = await read();
    expect(first.title).toBe("Spec");
    expect(first).toMatchObject({ links: ["glossary", "old-plan"], missingLinks: ["nowhere"], linkedFrom: ["roadmap"] });

    // A deleted page counts as missing, and its links no longer count as backlinks.
    expect((await req("DELETE", `/api/companies/${company.id}/wiki/old-plan`)).statusCode).toBe(204);
    expect((await req("DELETE", `/api/companies/${company.id}/wiki/roadmap`)).statusCode).toBe(204);
    expect(await read()).toMatchObject({ links: ["glossary"], missingLinks: ["old-plan", "nowhere"], linkedFrom: [] });
  });
});
