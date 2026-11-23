import { afterEach, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("feedback list: linked feature states and the delivered filter", () => {
  it("lists each note's features and returns only notes whose features are all released", async () => {
    t = await makeApp();
    const { cookie } = await signIn(t);
    const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
    const base = `/api/companies/${company.id}`;
    const done = (await req("POST", `${base}/features`, { title: "Dark mode" })).json();
    const open = (await req("POST", `${base}/features`, { title: "CSV export" })).json();
    await req("PATCH", `/api/features/${done.id}`, { status: "released" });

    const mk = async (text: string, links: string[]) => {
      const n = (await req("POST", `${base}/feedback`, { text })).json();
      for (const f of links) await req("POST", `/api/feedback/${n.id}/insights`, { featureId: f });
      return n.id as string;
    };
    const delivered = await mk("a", [done.id]);
    const mixed = await mk("b", [done.id, open.id]);
    const unlinked = await mk("c", []);
    const archived = await mk("d", [done.id]);
    await req("PATCH", `/api/feedback/${archived}`, { state: "archived" });

    const all = (await req("GET", `${base}/feedback`)).json() as Array<{ id: string; features: Array<{ title: string; status: string }> }>;
    expect(all.find((n) => n.id === delivered)!.features).toMatchObject([{ title: "Dark mode", status: "released" }]);
    expect(all.find((n) => n.id === mixed)!.features.map((f) => f.status).sort()).toEqual(["idea", "released"]);
    expect(all.find((n) => n.id === unlinked)!.features).toEqual([]);

    const only = (await req("GET", `${base}/feedback?delivered=true`)).json() as Array<{ id: string }>;
    // Delivered ignores the note's own state: the archived note is in too.
    expect(only.map((n) => n.id).sort()).toEqual([delivered, archived].sort());
  });
});
