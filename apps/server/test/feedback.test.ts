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
  const other = (await req("POST", "/api/companies", { name: "Other Co" })).json().company;
  return { req, company, other };
}

describe("feedback notes and insights", () => {
  it("records feedback, links passages to features with importance, and suggests features", async () => {
    const c = await setup();
    const dark = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "Dark mode", description: "A dark theme for the dashboard" })).json();
    const csv = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "CSV export" })).json();
    expect(dark).toMatchObject({ status: "idea", portalVisible: false });

    const n = (await c.req("POST", `/api/companies/${c.company.id}/feedback`, { text: "The dashboard is far too bright at night. A dark theme would help. Exporting to CSV would be nice too.", customer: { name: "Acme Ltd", email: "ops@acme.example", segment: "Enterprise" } })).json();
    expect(n).toMatchObject({ state: "unprocessed", source: "owner", untrusted: false });

    const detail = (await c.req("GET", `/api/feedback/${n.id}`)).json();
    expect(detail.customer).toMatchObject({ name: "Acme Ltd", segment: "Enterprise" });
    // The note asks for both.
    expect(detail.suggestions.map((x: { id: string }) => x.id).sort()).toEqual([dark.id, csv.id].sort());

    expect((await c.req("POST", `/api/feedback/${n.id}/insights`, { featureId: dark.id, importance: "critical", highlight: "A dark theme would help." })).statusCode).toBe(201);
    await c.req("POST", `/api/feedback/${n.id}/insights`, { featureId: csv.id, importance: "nice_to_have", highlight: "Exporting to CSV would be nice too." });
    // Linked features aren't suggested again.
    expect((await c.req("GET", `/api/feedback/${n.id}`)).json().suggestions).toEqual([]);
    // The passage must be from the note.
    expect((await c.req("POST", `/api/feedback/${n.id}/insights`, { featureId: csv.id, highlight: "made up" })).statusCode).toBe(422);
    // A feature of another company can't be linked.
    const foreign = (await c.req("POST", `/api/companies/${c.other.id}/features`, { title: "Theirs" })).json();
    expect((await c.req("POST", `/api/feedback/${n.id}/insights`, { featureId: foreign.id })).statusCode).toBe(404);

    // The same customer again counts once, at their highest importance.
    const n2 = (await c.req("POST", `/api/companies/${c.company.id}/feedback`, { text: "Dark mode please", customer: { name: "acme ltd" } })).json();
    await c.req("POST", `/api/feedback/${n2.id}/insights`, { featureId: dark.id, importance: "nice_to_have" });
    // Anonymous feedback counts on its own.
    const n3 = (await c.req("POST", `/api/companies/${c.company.id}/feedback`, { text: "dark mode!" })).json();
    await c.req("POST", `/api/feedback/${n3.id}/insights`, { featureId: dark.id, importance: "important" });

    const list = (await c.req("GET", `/api/companies/${c.company.id}/features`)).json();
    const d = list.features.find((f: { id: string }) => f.id === dark.id);
    expect(d).toMatchObject({ demand: 3 + 2, insightCount: 3, customerCount: 2 });
    expect(list.maxDemand).toBe(5);
    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback-customers?q=acme`)).json()).toHaveLength(1);

    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback?state=unprocessed`)).json()).toHaveLength(3);
    await c.req("PATCH", `/api/feedback/${n.id}`, { state: "processed" });
    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback?state=unprocessed`)).json()).toHaveLength(2);
    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback?q=bright`)).json().map((x: { id: string }) => x.id)).toEqual([n.id]);
    expect((await c.req("GET", "/api/feedback/unprocessed")).json()).toEqual({ [c.company.id]: 2 });

    const fd = (await c.req("GET", `/api/features/${dark.id}`)).json();
    expect(fd.insights.map((i: { importance: string }) => i.importance).sort()).toEqual(["critical", "important", "nice_to_have"]);
    expect(fd.insights.find((i: { importance: string }) => i.importance === "critical")).toMatchObject({ highlight: "A dark theme would help.", customer: { name: "Acme Ltd" }, createdBy: "the owner" });
  });
});

describe("prioritisation", () => {
  it("scores features on demand and the company's criteria, divided by effort", async () => {
    const c = await setup();
    await c.req("PATCH", `/api/companies/${c.company.id}/feedback-settings`, { demandWeight: 2 });
    const mission = (await c.req("POST", `/api/companies/${c.company.id}/feature-drivers`, { name: "Fits the mission", weight: 2 })).json();
    const a = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "A", effort: 1, driverScores: { [mission.id]: 5 } })).json();
    const b = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "B", effort: 5 })).json();
    const n = (await c.req("POST", `/api/companies/${c.company.id}/feedback`, { text: "B please" })).json();
    await c.req("POST", `/api/feedback/${n.id}/insights`, { featureId: b.id, importance: "critical" });

    const { features } = (await c.req("GET", `/api/companies/${c.company.id}/features`)).json();
    const fa = features.find((f: { id: string }) => f.id === a.id);
    const fb = features.find((f: { id: string }) => f.id === b.id);
    // A: no demand (0 × 2) and mission 5 × 2 → value 2.5; effort 1 → 7.5.
    expect(fa).toMatchObject({ value: 2.5, priority: 7.5 });
    // B: full demand (5 × 2), mission unscored → value 5; effort 5 → 3.
    expect(fb).toMatchObject({ value: 5, priority: 3 });

    // Removing a criterion removes its scores.
    await c.req("DELETE", `/api/feature-drivers/${mission.id}`);
    expect((await c.req("GET", `/api/features/${a.id}`)).json().feature.driverScores).toEqual({});
    expect((await c.req("PATCH", `/api/features/${a.id}`, { driverScores: { [mission.id]: 3 } })).statusCode).toBe(422);
  });

  it("links a feature to a whole objective, in its own company only", async () => {
    const c = await setup();
    const o = (await c.req("POST", `/api/companies/${c.company.id}/objectives`, { title: "Complete alpha build", priority: 1 })).json();
    const theirs = (await c.req("POST", `/api/companies/${c.other.id}/objectives`, { title: "Theirs", priority: 1 })).json();
    const f = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "Empty columns", objectiveId: o.id })).json();
    expect(f.objectiveId).toBe(o.id);
    expect((await c.req("PATCH", `/api/features/${f.id}`, { objectiveId: theirs.id })).statusCode).toBe(404);
    expect((await c.req("PATCH", `/api/features/${f.id}`, { objectiveId: null })).json().objectiveId).toBeNull();
  });

  it("keeps the hierarchy to one level and rolls subfeature demand up", async () => {
    const c = await setup();
    const area = (await c.req("POST", `/api/companies/${c.company.id}/feature-areas`, { name: "Reporting" })).json();
    const parent = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "Exports", areaId: area.id })).json();
    const child = (await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "CSV", parentId: parent.id })).json();
    expect((await c.req("POST", `/api/companies/${c.company.id}/features`, { title: "Too deep", parentId: child.id })).statusCode).toBe(422);
    expect((await c.req("PATCH", `/api/features/${parent.id}`, { parentId: child.id })).statusCode).toBe(422);
    expect((await c.req("PATCH", `/api/features/${parent.id}`, { status: "released" })).json().releasedAt).not.toBeNull();

    const n = (await c.req("POST", `/api/companies/${c.company.id}/feedback`, { text: "csv please", customer: { name: "Bea" } })).json();
    await c.req("POST", `/api/feedback/${n.id}/insights`, { featureId: child.id, importance: "important" });
    const { features } = (await c.req("GET", `/api/companies/${c.company.id}/features`)).json();
    expect(features.find((f: { id: string }) => f.id === parent.id)).toMatchObject({ demand: 2, insightCount: 1 });
    const detail = (await c.req("GET", `/api/features/${parent.id}`)).json();
    expect(detail.subfeatures.map((s: { title: string }) => s.title)).toEqual(["CSV"]);
    expect(detail.insights[0]).toMatchObject({ fromSubfeature: true });

    // Deleting a feature keeps the feedback.
    await c.req("DELETE", `/api/features/${child.id}`);
    expect((await c.req("GET", `/api/feedback/${n.id}`)).json().insights).toEqual([]);
  });
});
