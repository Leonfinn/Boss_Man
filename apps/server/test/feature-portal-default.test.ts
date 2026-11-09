import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
  const feature = async (body: Record<string, unknown>) => (await req("POST", `/api/companies/${company.id}/features`, { title: "A feature", ...body })).json();
  const portal = async (companyId: string) => (await req("PATCH", `/api/companies/${companyId}/portal`, { enabled: true })).json();
  return { req, company, feature, portal };
}

describe("features go on the portal by default (BOS-957)", () => {
  it("puts a new ordinary feature on the portal; a security one or a manual mark keeps it off and says why", async () => {
    const c = await setup();
    // Safe words first so it may go on, then a public summary so the visitor sees it.
    const ordinary = await c.feature({ title: "Dark mode", description: "A dark theme." });
    expect(ordinary).toMatchObject({ portalVisible: true, keepOffPortal: false });

    const security = await c.feature({ title: "Rotate API keys", description: "Rotate the signing secrets every week." });
    expect(security).toMatchObject({ portalVisible: false, keepOffPortal: false });

    const marked = await c.feature({ title: "Dark mode follow-up", description: "A softer dark theme.", keepOffPortal: true });
    expect(marked).toMatchObject({ portalVisible: false, keepOffPortal: true });
  });

  it("keeps a ticked feature off the portal until a public summary exists, then shows it", async () => {
    const c = await setup();
    const f = await c.feature({ title: "Dark mode", description: "A dark theme." });
    expect(f.portalVisible).toBe(true);
    const { portalToken } = await c.portal(c.company.id);
    const visitor = () => t!.app.inject({ method: "GET", url: "/api/portal", headers: { "x-portal-token": portalToken } });

    expect((await visitor()).json().features).toEqual([]);
    expect((await c.req("PATCH", `/api/features/${f.id}`, { publicSummary: "A dark theme you can switch on." })).statusCode).toBe(200);
    // Visitors see the summary's first line as the title, not the internal title (BOS-991).
    expect((await visitor()).json().features.map((x: { title: string }) => x.title)).toEqual(["A dark theme you can switch on."]);
  });

  it("takes a feature off the portal the moment it is marked sensitive, and cannot be voted on", async () => {
    const c = await setup();
    const f = await c.feature({ title: "Dark mode", description: "A dark theme.", publicSummary: "A dark theme." });
    const { portalToken } = await c.portal(c.company.id);
    const visitor = () => t!.app.inject({ method: "GET", url: "/api/portal", headers: { "x-portal-token": portalToken } });
    expect((await visitor()).json().features).toHaveLength(1);
    const voted = (await t!.app.inject({ method: "POST", url: "/api/portal/votes", headers: { "x-portal-token": portalToken }, payload: { featureId: f.id, importance: "important" } })).statusCode;
    expect(voted).toBe(200);

    const off = (await c.req("PATCH", `/api/features/${f.id}`, { keepOffPortal: true })).json();
    expect(off).toMatchObject({ portalVisible: false, keepOffPortal: true });
    expect((await visitor()).json().features).toEqual([]);
    expect((await t!.app.inject({ method: "POST", url: "/api/portal/votes", headers: { "x-portal-token": portalToken }, payload: { featureId: f.id, importance: "critical" } })).statusCode).toBe(404);
  });

  it("keeps a feature whose area or criteria read as security work off", async () => {
    const c = await setup();
    const security = (await c.req("POST", `/api/companies/${c.company.id}/feature-areas`, { name: "Security" })).json();
    const fromArea = await c.feature({ title: "Settings page", description: "Tidy the settings.", areaId: security.id });
    expect(fromArea).toMatchObject({ portalVisible: false });

    const driver = (await c.req("POST", `/api/companies/${c.company.id}/feature-drivers`, { name: "Keeps the network guard sound" })).json();
    const fromCriteria = await c.feature({ title: "Routing change", driverScores: { [driver.id]: 5 } });
    expect(fromCriteria).toMatchObject({ portalVisible: false });
  });

  it("shows the public summary, never the internal description, to visitors", async () => {
    const c = await setup();
    const f = await c.feature({ title: "Dark mode", description: "Internal: owner's private note about the dark theme.", publicSummary: "A dark theme you can switch on." });
    const { portalToken } = await c.portal(c.company.id);
    const body = (await t!.app.inject({ method: "GET", url: "/api/portal", headers: { "x-portal-token": portalToken } })).json();
    expect(body.features).toHaveLength(1);
    expect(body.features[0]).toMatchObject({ title: "A dark theme you can switch on.", description: "A dark theme you can switch on." });
    // The internal description does not reach the page (BOS-991); the public title test below covers the title.
    expect(JSON.stringify(body)).not.toContain("Internal: owner's private note");
  });

  it("shows visitors a public title, or the public summary's first line, never the internal title (BOS-991)", async () => {
    const c = await setup();
    const withTitle = await c.feature({ title: "Internal: rework the settings screen", description: "Internal note.", publicTitle: "Settings, tidied", publicSummary: "Every setting in one clear place." });
    const summaryOnly = await c.feature({ title: "Internal: dark mode work", description: "Owner's private note.", publicSummary: "A dark theme you can switch on.\nMore detail only for the team." });
    const { portalToken } = await c.portal(c.company.id);
    const body = (await t!.app.inject({ method: "GET", url: "/api/portal", headers: { "x-portal-token": portalToken } })).json();
    const show = (id: string) => body.features.find((x: { id: string }) => x.id === id);
    expect(show(withTitle.id)).toMatchObject({ title: "Settings, tidied", description: "Every setting in one clear place." });
    // No public title: the summary's first line stands in, and the rest of the summary stays the description.
    expect(show(summaryOnly.id).title).toBe("A dark theme you can switch on.");
    expect(show(summaryOnly.id).description).toContain("More detail only for the team.");
    expect(JSON.stringify(body)).not.toContain("Internal:");
  });

  it("still keeps a marked feature off even when its portalVisible flag says on", async () => {
    const c = await setup();
    const f = await c.feature({ title: "Dark mode", description: "A dark theme.", publicSummary: "A dark theme." });
    const { portalToken } = await c.portal(c.company.id);
    const visitor = () => t!.app.inject({ method: "GET", url: "/api/portal", headers: { "x-portal-token": portalToken } });
    expect((await visitor()).json().features).toHaveLength(1);
    // The keep-off mark wins whatever the tick says: a stray tick must not publish a sensitive feature.
    expect((await c.req("PATCH", `/api/features/${f.id}`, { keepOffPortal: true })).statusCode).toBe(200);
    await t!.db.execute(sql`update "features" set "portal_visible" = true where "id" = ${f.id}`);
    expect((await visitor()).json().features).toEqual([]);
  });
});
