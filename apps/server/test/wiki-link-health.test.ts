// BOS-2395: the wiki-wide "Link health" view: every [[slug]] to no page (with the page it's on), and every page nothing links to.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { linkHealthOf } from "../src/services/wiki.js";
import { signedInOwner } from "./helpers/owner-session.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const p = (slug: string, body: string) => ({ slug, title: slug.toUpperCase(), body });

describe("linkHealthOf (BOS-2395)", () => {
  it("lists missing links with their page, and orphans; leaves out the Index, briefs and self-links", () => {
    const brief = "brief-0b6f1a2c-1111-4222-8333-944455556666";
    const h = linkHealthOf([
      p("index", "[[spec]] [[gone]]"),
      p(brief, "[[spec#Scope]]"),
      p("spec", "[[spec]] [[glossary#Terms]] [[old-plan-]] [[gone]] [[gone]]"),
      p("glossary", "Words."),
      p("lonely", "[[lonely]] only links to itself"),
    ]);
    // [[gone]] twice on one page is one row; on two pages it's two.
    expect(h.missing).toEqual([
      { slug: "index", title: "INDEX", target: "gone" },
      { slug: "spec", title: "SPEC", target: "old-plan-" },
      { slug: "spec", title: "SPEC", target: "gone" },
    ]);
    expect(h.missingTotal).toBe(3);
    expect(h.orphans).toEqual([{ slug: "lonely", title: "LONELY" }]);
    expect(h.orphansTotal).toBe(1);
  });

  it("is empty for a tidy wiki", () => {
    expect(linkHealthOf([p("index", "[[a]]"), p("a", "[[index]]")])).toEqual({ missing: [], missingTotal: 0, orphans: [], orphansTotal: 0 });
  });

  it("caps each list but keeps the full counts", () => {
    const pages = Array.from({ length: 5 }, (_, i) => p(`o${i}`, `[[nope-${i}]]`));
    const h = linkHealthOf(pages, 2);
    expect(h.missing).toHaveLength(2);
    expect(h.missingTotal).toBe(5);
    expect(h.orphans.map((o) => o.slug)).toEqual(["o0", "o1"]);
    expect(h.orphansTotal).toBe(5);
  });
});

describe("GET /api/companies/:id/wiki-link-health (BOS-2395)", () => {
  it("reports live pages only: a deleted page's links drop out and links to it become missing; owner only", async () => {
    const { db, close } = await openPglite();
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    ctx = { close: async () => (await built.app.close(), await close()) };
    const cookie = await signedInOwner(db);
    const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => built.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
    const page = async (title: string, body: string) => ((await req("POST", `/api/companies/${company.id}/wiki`, { title, body })).json() as { slug: string }).slug;
    await page("Spec", "See [[glossary]] and [[nowhere]].");
    await page("Glossary", "Back to [[spec]].");
    await page("Roadmap", "Built on [[spec#Scope]] and [[old-plan]].");
    await page("Old plan", "Gone soon.");
    const url = `/api/companies/${company.id}/wiki-link-health`;
    const read = async () => (await req("GET", url)).json() as { missing: { slug: string; target: string }[]; orphans: { slug: string }[]; missingTotal: number; orphansTotal: number };

    expect(await read()).toMatchObject({ missing: [{ slug: "spec", target: "nowhere" }], missingTotal: 1, orphans: [{ slug: "roadmap" }], orphansTotal: 1 });

    expect((await req("DELETE", `/api/companies/${company.id}/wiki/old-plan`)).statusCode).toBe(204);
    expect(await read()).toMatchObject({ missing: [{ slug: "roadmap", target: "old-plan" }, { slug: "spec", target: "nowhere" }], missingTotal: 2 });
    expect((await req("DELETE", `/api/companies/${company.id}/wiki/roadmap`)).statusCode).toBe(204);
    expect(await read()).toMatchObject({ missing: [{ slug: "spec", target: "nowhere" }], orphans: [] });

    expect((await built.app.inject({ method: "GET", url })).statusCode).toBe(401);
  });
});
