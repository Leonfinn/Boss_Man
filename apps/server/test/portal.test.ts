import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { feedbackNotes, insights } from "../src/db/schema.js";
import { buildPortalApp } from "../src/portal.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const shown = (await req("POST", `/api/companies/${company.id}/features`, { title: "Dark mode", description: "A dark theme.", portalVisible: true, status: "considering" })).json();
  const planned = (await req("POST", `/api/companies/${company.id}/features`, { title: "CSV export", portalVisible: true, status: "planned" })).json();
  const hidden = (await req("POST", `/api/companies/${company.id}/features`, { title: "Secret project" })).json();
  await req("POST", `/api/companies/${company.id}/features`, { title: "Shipped", portalVisible: true, status: "released" });
  await req("POST", `/api/companies/${company.id}/features`, { title: "Nope", portalVisible: true, status: "declined" });
  return { req, company, shown, planned, hidden };
}

/** A visitor: the portal token in a header, and the voter cookie the portal hands out. */
function visitor(app: TestApp["app"], token: string) {
  let jar = "";
  return async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, ip = "203.0.113.7") => {
    const res = await app.inject({ method, url, remoteAddress: ip, headers: { "x-portal-token": token, ...(jar ? { cookie: jar } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const c = res.cookies.find((x) => x.name === "bm_portal_voter");
    if (c) jar = `bm_portal_voter=${c.value}`;
    return res;
  };
}

describe("feedback portal", () => {
  it("is off until the owner turns it on, and answers wrong or old links the same way", async () => {
    const c = await setup();
    expect((await t!.app.inject({ method: "GET", url: "/api/portal" })).statusCode).toBe(404);
    const on = (await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: true, title: "What's next for App Co" })).json();
    expect(on.portalToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const v = visitor(t!.app, on.portalToken);
    const page = await v("GET", "/api/portal");
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    const cookie = page.cookies.find((x) => x.name === "bm_portal_voter")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/portal" });
    const body = page.json();
    expect(body.title).toBe("What's next for App Co");
    expect(body.features.map((f: { title: string; stage: string }) => [f.title, f.stage])).toEqual([
      ["CSV export", "planned"],
      ["Dark mode", "considering"],
      ["Shipped", "released"],
    ]);

    expect((await visitor(t!.app, "x".repeat(32))("GET", "/api/portal")).statusCode).toBe(404);
    const rotated = (await c.req("POST", `/api/companies/${c.company.id}/portal/rotate`)).json();
    expect((await v("GET", "/api/portal")).statusCode).toBe(404);
    expect((await visitor(t!.app, rotated.portalToken)("GET", "/api/portal")).statusCode).toBe(200);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: false });
    expect((await visitor(t!.app, rotated.portalToken)("GET", "/api/portal")).statusCode).toBe(404);
  });

  it("turns votes, comments and ideas into untrusted feedback, one vote per visitor and feature", async () => {
    const c = await setup();
    const { portalToken } = (await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: true })).json();
    const v = visitor(t!.app, portalToken);
    await v("GET", "/api/portal");

    expect((await v("POST", "/api/portal/votes", { featureId: c.shown.id, importance: "important" })).statusCode).toBe(200);
    let notes = await t!.db.select().from(feedbackNotes);
    expect(notes).toHaveLength(1);
    // A bare vote needs no reading, so it arrives processed.
    expect(notes[0]).toMatchObject({ source: "portal", untrusted: true, state: "processed", text: 'Voted "Important" for "Dark mode" on the portal.' });

    // Voting again changes the vote; a comment sends it to the inbox.
    await v("POST", "/api/portal/votes", { featureId: c.shown.id, importance: "critical", comment: "My eyes hurt at night.", name: "Bea", email: "bea@example.org" });
    notes = await t!.db.select().from(feedbackNotes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ state: "unprocessed", text: "My eyes hurt at night.", title: "Portal comment: Dark mode" });
    expect((await t!.db.select().from(insights))[0]).toMatchObject({ featureId: c.shown.id, importance: "critical", createdBy: "portal" });
    const mine = (await v("GET", "/api/portal")).json().features.find((f: { id: string }) => f.id === c.shown.id);
    expect(mine.myVote).toEqual({ importance: "critical", comment: "My eyes hurt at night." });
    const detail = (await c.req("GET", `/api/feedback/${notes[0]!.id}`)).json();
    expect(detail.customer).toMatchObject({ name: "Bea", segment: "Portal" });

    // Another visitor's vote is separate; demand counts both.
    await visitor(t!.app, portalToken)("POST", "/api/portal/votes", { featureId: c.shown.id, importance: "nice_to_have" });
    expect((await c.req("GET", `/api/features/${c.shown.id}`)).json().feature).toMatchObject({ demand: 4, insightCount: 2 });

    // Hidden, declined and unknown features can't be voted on.
    expect((await v("POST", "/api/portal/votes", { featureId: c.hidden.id, importance: "critical" })).statusCode).toBe(404);
    expect((await v("POST", "/api/portal/votes", { featureId: c.shown.id, importance: "huge" })).statusCode).toBe(400);

    expect((await v("DELETE", `/api/portal/votes/${c.shown.id}`)).statusCode).toBe(204);
    expect((await v("GET", "/api/portal")).json().features.find((f: { id: string }) => f.id === c.shown.id).myVote).toBeNull();

    expect((await v("POST", "/api/portal/ideas", { title: "Offline mode", text: "I work on trains." })).statusCode).toBe(201);
    // The hidden field catches bots: they're thanked and nothing is stored.
    expect((await v("POST", "/api/portal/ideas", { title: "Buy pills", text: "spam", website: "http://spam.example" })).statusCode).toBe(201);
    const ideas = (await t!.db.select().from(feedbackNotes).where(eq(feedbackNotes.source, "portal"))).filter((n) => n.title?.startsWith("Portal idea:"));
    expect(ideas).toEqual([expect.objectContaining({ title: "Portal idea: Offline mode", untrusted: true, state: "unprocessed" })]);
  });

  it("limits how much one address can send", async () => {
    t = await makeApp({ portalLimits: { writesPerIpPerHour: 2 } });
    const { cookie } = await signIn(t);
    const req = (method: "POST" | "PATCH", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
    const { portalToken } = (await req("PATCH", `/api/companies/${company.id}/portal`, { enabled: true })).json();
    const v = visitor(t.app, portalToken);
    expect((await v("POST", "/api/portal/ideas", { title: "One", text: "1" })).statusCode).toBe(201);
    expect((await v("POST", "/api/portal/ideas", { title: "Two", text: "2" })).statusCode).toBe(201);
    expect((await v("POST", "/api/portal/ideas", { title: "Three", text: "3" })).statusCode).toBe(429);
    expect((await v("POST", "/api/portal/ideas", { title: "Elsewhere", text: "4" }, "198.51.100.9")).statusCode).toBe(201);
  });

  it("can run on its own listener that serves nothing but the portal", async () => {
    const c = await setup();
    const { portalToken } = (await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: true })).json();
    const web = mkdtempSync(path.join(tmpdir(), "bm-web-"));
    mkdirSync(path.join(web, "assets"));
    writeFileSync(path.join(web, "portal.html"), "<!doctype html><title>portal</title>");
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>owner</title>");
    writeFileSync(path.join(web, "assets", "portal-abc.js"), "console.log(1)");
    writeFileSync(path.join(web, "assets", "main-abc.js"), "console.log(2)");
    const portal = await buildPortalApp({ feedback: t!.feedback, webDir: web, secureCookies: true });
    try {
      const get = (url: string, headers: Record<string, string> = {}) => portal.inject({ method: "GET", url, headers });
      expect((await get("/api/portal", { "x-portal-token": portalToken })).json().features).toHaveLength(3);
      expect((await get("/api/portal", { "x-portal-token": portalToken })).cookies[0]).toMatchObject({ secure: true });
      const page = await get("/portal.html");
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(page.headers["referrer-policy"]).toBe("no-referrer");
      expect((await get("/assets/portal-abc.js")).statusCode).toBe(200);
      expect((await get("/")).headers.location).toBe("/portal.html");
      for (const url of ["/index.html", "/assets/main-abc.js", "/api/setup", "/api/companies", "/api/me", "/mcp", "/api/runner/connect"]) expect([url, (await get(url)).statusCode]).toEqual([url, 404]);
      expect((await portal.inject({ method: "POST", url: "/api/login", payload: { username: "leon", password: "correct horse battery" } })).statusCode).toBe(404);
    } finally {
      await portal.close();
    }
  });
});

describe("portal logo", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const b64 = (b: Buffer) => ({ data: b.toString("base64") });
  const put = (c: Awaited<ReturnType<typeof setup>>, buf: Buffer) => c.req("PUT" as never, `/api/companies/${c.company.id}/feedback/portal-logo`, b64(buf));

  it("accepts a PNG, serves it with the right type and nosniff, and reports it in the portal data", async () => {
    const c = await setup();
    const { portalToken } = (await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: true })).json();
    const v = visitor(t!.app, portalToken);
    expect((await v("GET", "/api/portal")).json().hasLogo).toBe(false);
    expect((await v("GET", "/api/portal/logo")).statusCode).toBe(404);

    const ok = await put(c, PNG);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().hasLogo).toBe(true);
    expect((await v("GET", "/api/portal")).json().hasLogo).toBe(true);
    const img = await v("GET", "/api/portal/logo");
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect(img.headers["content-disposition"]).toBe("inline");
    expect(img.headers["cache-control"]).toBe("private, no-cache");
    expect(img.rawPayload.equals(PNG)).toBe(true);

    const del = await c.req("DELETE", `/api/companies/${c.company.id}/feedback/portal-logo`);
    expect(del.json().hasLogo).toBe(false);
    expect((await v("GET", "/api/portal/logo")).statusCode).toBe(404);
  });

  it("refuses wrong bytes, SVG and files over 256 KB", async () => {
    const c = await setup();
    expect((await put(c, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).statusCode).toBe(415);
    expect((await put(c, Buffer.from("GIF89a-not-allowed-here-either"))).statusCode).toBe(415);
    expect((await put(c, Buffer.concat([PNG, Buffer.alloc(256 * 1024)]))).statusCode).toBe(413);
    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback-settings`)).json().hasLogo).toBe(false);
  });

  it("gives share links the portal's own address when one is set", async () => {
    const c = await setup();
    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback-settings`)).json().portalUrl).toBeNull();
    await t!.close();
    t = await makeApp({ portalUrl: "http://192.168.68.67:3111/" });
    const { cookie } = await signIn(t);
    const { company } = (await t.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "Port Co" } })).json();
    const s = (await t.app.inject({ method: "GET", url: `/api/companies/${company.id}/feedback-settings`, headers: { cookie } })).json();
    expect(s.portalUrl).toBe("http://192.168.68.67:3111");
  });

  it("is a 404 when the portal is off or the token is wrong", async () => {
    const c = await setup();
    const { portalToken } = (await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: true })).json();
    await put(c, PNG);
    expect((await visitor(t!.app, "x".repeat(32))("GET", "/api/portal/logo")).statusCode).toBe(404);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { enabled: false });
    expect((await visitor(t!.app, portalToken)("GET", "/api/portal/logo")).statusCode).toBe(404);
  });
});
