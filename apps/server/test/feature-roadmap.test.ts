import { afterEach, describe, expect, it } from "vitest";
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
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  const feature = async (body: Record<string, unknown>) => (await req("POST", `/api/companies/${company.id}/features`, { title: "A feature", ...body })).json();
  const ticket = async (body: Record<string, unknown>) => (await req("POST", `/api/projects/${project.id}/tickets`, { title: "A ticket", ...body })).json();
  return { req, company, project, feature, ticket };
}

describe("feature roadmap", () => {
  it("places features in Now, Next, Later and Released, grouped by objective with their milestones and progress", async () => {
    const c = await setup();
    const launch = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Launch the beta", priority: 1 })).json();
    const growth = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Grow revenue", priority: 2 })).json();
    const beta = (await c.req("POST", `/api/objectives/${launch.id}/milestones`, { title: "Beta", targetDate: "2026-12-01" })).json();

    const building = await c.feature({ title: "Dark mode", status: "in_progress", milestoneId: beta.id, rank: 2 });
    const planned = await c.feature({ title: "CSV export", status: "planned", objectiveId: growth.id });
    const idea = await c.feature({ title: "Mobile app", status: "idea" });
    const shipped = await c.feature({ title: "Sign-in", status: "released", objectiveId: launch.id });
    const dropped = await c.feature({ title: "Not this", status: "declined", objectiveId: launch.id });

    await c.ticket({ title: "Build the toggle", featureId: building.id, milestoneId: beta.id, state: "done" });
    await c.ticket({ title: "Persist the choice", featureId: building.id, state: "in_progress" });

    const board = (await c.req("GET", "/api/roadmap/features")).json();
    const [co] = board.filter((x: { id: string }) => x.id === c.company.id);
    const byTitle = (title: string) => co.features.find((f: { title: string }) => f.title === title);

    expect(byTitle("Dark mode")).toMatchObject({
      column: "now",
      rank: 2,
      objective: { id: launch.id, title: "Launch the beta", priority: 1 },
      tickets: { total: 2, done: 1 },
      milestones: [{ id: beta.id, title: "Beta", targetDate: "2026-12-01" }],
    });
    expect(byTitle("CSV export")).toMatchObject({ column: "next", objective: { id: growth.id, priority: 2 } });
    expect(byTitle("Mobile app")).toMatchObject({ column: "later", objective: null });
    expect(byTitle("Sign-in")).toMatchObject({ column: "released" });
    // Declined features are not on the roadmap at all.
    expect(byTitle("Not this")).toBeUndefined();

    // A pin moves a feature between columns, and clearing it follows the status again.
    expect((await c.req("PATCH", `/api/features/${idea.id}`, { horizon: "now" })).json().horizon).toBe("now");
    expect((await c.req("GET", "/api/roadmap/features")).json().find((x: { id: string }) => x.id === c.company.id).features.find((f: { id: string }) => f.id === idea.id).column).toBe("now");
    expect((await c.req("PATCH", `/api/features/${idea.id}`, { horizon: null })).json().horizon).toBeNull();
    expect((await c.req("GET", "/api/roadmap/features")).json().find((x: { id: string }) => x.id === c.company.id).features.find((f: { id: string }) => f.id === idea.id).column).toBe("later");
  });

  it("keeps a public summary and a show-publicly switch, off by default and never on without a summary", async () => {
    const c = await setup();
    const f = await c.feature({ title: "Dark mode" });
    expect(f).toMatchObject({ publicSummary: null, showPublicly: false });

    // Switching it on without a summary is refused.
    expect((await c.req("PATCH", `/api/features/${f.id}`, { showPublicly: true })).statusCode).toBe(422);
    expect((await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "No summary", showPublicly: true })).statusCode).toBe(422);

    const saved = (await c.req("PATCH", `/api/features/${f.id}`, { publicSummary: "  A choice of light and dark themes.  " })).json();
    expect(saved.publicSummary).toBe("A choice of light and dark themes.");
    expect((await c.req("PATCH", `/api/features/${f.id}`, { showPublicly: true })).json().showPublicly).toBe(true);
    // Clearing the summary while it is shown is refused until the switch goes off.
    expect((await c.req("PATCH", `/api/features/${f.id}`, { publicSummary: null })).statusCode).toBe(422);
    expect((await c.req("PATCH", `/api/features/${f.id}`, { showPublicly: false })).json().showPublicly).toBe(false);
    expect((await c.req("PATCH", `/api/features/${f.id}`, { publicSummary: null })).json().publicSummary).toBeNull();
  });
});
